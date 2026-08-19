/**
 * The usage log on disk, plus the buffer that keeps it off the hot path.
 *
 * Deliberately not in `hue-settings.json`: `settings.ts` rewrites that file
 * whole on every update, and this records
 * an event per utterance and per model turn. Folding it in would rewrite every
 * API key and the résumé bundle several times a minute during an interview —
 * and would put that write on the path of the thing the app exists to do.
 *
 * Writes are buffered and flushed on a debounce, so a sixty-utterance interview
 * costs a handful of writes rather than sixty. Usage data is the least important
 * thing in the app: losing the last few seconds of it to a crash is fine, and
 * nothing here is allowed to throw into a caller that is mid-session.
 *
 * `dir` is a parameter rather than read from `app` so this module tests without
 * Electron.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pruneEvents, type UsageEvent } from '../shared/usage.ts'

/** Kept in step with the rolling windows the panel offers. */
const RETENTION_DAYS = 7

/**
 * How long a burst of events is allowed to accumulate before hitting the disk.
 * Long enough that a rapid exchange of turns coalesces, short enough that the
 * panel is never meaningfully behind what just happened.
 */
const FLUSH_DEBOUNCE_MS = 5_000

/**
 * Where the log lives, handed in at startup rather than read from `app` here.
 *
 * A module that needs `app` here would have to reach for Electron through a
 * lazy `require` to stay loadable under `node --test`; this one does not, because
 * the buffer is the only part that wants a default directory and startup can
 * simply tell it one. That keeps Electron out of the module altogether — no
 * lint exception, and the tests exercise the same code path the app does.
 */
let dir: string | null = null

export function configureUsageStore(usageDir: string): void {
  dir = usageDir
}

function fileFor(dir: string): string {
  return join(dir, 'usage.json')
}

/**
 * A row is only usable if it is shaped like one.
 *
 * A hand-edited file or a future format can put anything in here, and one bad
 * row would otherwise reach `summarize` and add `undefined` into every column,
 * turning the whole panel into NaN. Cheaper to drop the row than to render a
 * broken total.
 */
function isUsageEvent(v: unknown): v is UsageEvent {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    (e.kind === 'llm' || e.kind === 'asr') &&
    typeof e.provider === 'string'
  )
}

/** Everything on disk, or nothing at all. Never throws. */
export function readEvents(dir: string): UsageEvent[] {
  const file = fileFor(dir)
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { events?: unknown }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) return []
    return raw.events.filter(isUsageEvent)
  } catch {
    // A truncated file from a kill mid-write. The history is gone either way;
    // what matters is that launch continues.
    return []
  }
}

/**
 * Replace the file with `events`, pruned to the retention horizon.
 *
 * Written to a temp name and renamed, so a crash mid-write leaves the previous
 * file intact rather than a half-written one — the failure `readEvents` has to
 * tolerate, made rarer at the source.
 */
export function writeEvents(dir: string, events: readonly UsageEvent[], now: number): void {
  const kept = pruneEvents(events, now, RETENTION_DAYS)
  mkdirSync(dir, { recursive: true })
  const file = fileFor(dir)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ events: kept }), 'utf-8')
  renameSync(tmp, file)
}

// ── The live buffer ─────────────────────────────────────────────────────────

let buffer: UsageEvent[] | null = null
let timer: NodeJS.Timeout | null = null
let listeners: (() => void)[] = []

function load(): UsageEvent[] {
  // Before `configureUsageStore` runs there is nowhere to read from. Recording
  // into memory anyway means the events from a very early call are not lost —
  // the next flush, once a directory exists, writes them out.
  if (buffer === null) buffer = dir === null ? [] : readEvents(dir)
  return buffer
}

/**
 * Record one billable call.
 *
 * Called from inside provider code on the interview hot path, so it swallows
 * everything: a usage-accounting failure must never surface as a failed answer
 * or a dropped utterance.
 */
export function record(event: UsageEvent): void {
  try {
    load().push(event)
    for (const notify of listeners) notify()
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        flush()
      }, FLUSH_DEBOUNCE_MS)
      // Don't hold the process open just to write a usage file.
      timer.unref?.()
    }
  } catch (e) {
    console.error('usage not recorded:', e)
  }
}

/** Everything held in memory, pruned. The panel reads through this. */
export function currentEvents(now: number): UsageEvent[] {
  try {
    return pruneEvents(load(), now, RETENTION_DAYS)
  } catch {
    return []
  }
}

/** Write the buffer out now. Safe to call when there is nothing pending. */
export function flush(): void {
  if (buffer === null || dir === null) return
  try {
    const now = Date.now()
    writeEvents(dir, buffer, now)
    // Prune the in-memory copy to match what was just written. `writeEvents`
    // prunes on the way to disk, so the file stayed bounded, but the buffer it
    // was written from did not: it held every event since launch for the whole
    // life of the process, and `currentEvents` re-pruned that growing array on
    // every read. Small next to the models, but it is unbounded growth in a
    // process that is expected to stay open all day.
    buffer = pruneEvents(buffer, now, RETENTION_DAYS)
  } catch (e) {
    console.error('usage not written:', e)
  }
}

/** Fires whenever an event is recorded, so the panel can update live. */
export function onRecorded(cb: () => void): () => void {
  listeners.push(cb)
  return () => {
    listeners = listeners.filter((l) => l !== cb)
  }
}
