/**
 * Cue sheets on disk, one file each.
 *
 * Deliberately not in `hue-settings.json` alongside `profileBundleJson`.
 * `settings.ts` writes that file whole on every update; cue sheets are plural
 * and each carries a full document, so folding them in would rewrite every
 * sheet on every unrelated settings change.
 *
 * Stored in plaintext, matching `profileBundleJson`, which is not in
 * `SECRET_SETTING_KEYS` either. That is a consistency choice about content
 * class — personal, not credential — and not an oversight. `safeStorage` is
 * reserved for API keys and the ingest token.
 *
 * `dir` is a parameter rather than read from `app` so this module tests
 * without Electron.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CueSheet } from '../shared/cuesheet'

export function sheetsDir(): string {
  const { app } = require('electron')
  return join(app.getPath('userData'), 'cue-sheets')
}

/**
 * The one definition of a well-formed sheet id.
 *
 * Exported so callers that merely STORE an id can reject a bad one at the
 * point it enters the system. Without that, `hue:cuesheet:select` happily
 * persists any string, and the throw lands later — in `deleteSheet`, or worse,
 * in whatever is holding the settings object at the time.
 */
export function isValidSheetId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id)
}

function fileFor(dir: string, id: string): string {
  // Ids must be validated, not laundered, so two distinct ids can never address
  // the same file. A malformed id is a bug upstream in ingest; throwing here
  // surfaces that bug rather than silently mangling the id and hiding it.
  if (!isValidSheetId(id)) {
    throw new Error(`Invalid cue sheet id: ${id}`)
  }
  return join(dir, `${id}.json`)
}

export function saveSheet(dir: string, sheet: CueSheet): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(fileFor(dir, sheet.id), JSON.stringify(sheet, null, 2), 'utf-8')
}

/**
 * A sheet is only usable if every card is shaped like a card.
 *
 * `{ id, cards: [...] }` used to be enough, which let a truncated or
 * half-written file through to `new CueMatcher(sheet)` — where
 * `cards.flatMap((c) => c.triggers)` throws on the first card whose `triggers`
 * never made it to disk. That throw surfaces inside the renderer's session
 * start, so a single bad file could stop an interview from beginning. Cheaper
 * to check the shape here and drop the sheet.
 */
function isUsableSheet(sheet: unknown): sheet is CueSheet {
  const s = sheet as CueSheet | null
  if (typeof s?.id !== 'string' || !Array.isArray(s.cards)) return false
  return s.cards.every(
    (c) =>
      typeof c?.id === 'string' &&
      typeof c?.heading === 'string' &&
      typeof c?.script === 'string' &&
      Array.isArray(c?.cues) &&
      Array.isArray(c?.triggers)
  )
}

export function listSheets(dir: string): CueSheet[] {
  if (!existsSync(dir)) return []
  const out: CueSheet[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const sheet: unknown = JSON.parse(readFileSync(join(dir, name), 'utf-8'))
      if (isUsableSheet(sheet)) out.push(sheet)
    } catch {
      // A corrupt sheet loses that sheet, not the session. Throwing here would
      // mean one bad file makes the whole feature unavailable mid-interview.
    }
  }
  return out
}

export function deleteSheet(dir: string, id: string): void {
  rmSync(fileFor(dir, id), { force: true })
}
