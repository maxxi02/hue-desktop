/**
 * What Hue has consumed, and how much of your quota is left.
 *
 * Two different kinds of number live in one event, deliberately:
 *
 *   - the tally, which we count ourselves from what the vendor returned, and
 *   - the headroom, which the vendor states in its response headers.
 *
 * They are not interchangeable. The tally is what *this app* used; the headroom
 * is what the *account* has left, which also moves when you use the same key
 * somewhere else. Keeping both means the panel can say "Hue used 40k tokens this
 * hour, and Groq says you have 17k left" — two facts that are only useful
 * together.
 *
 * Every numeric field is optional and every absent one means "not reported".
 * That distinction is the whole point of the module: a provider that publishes
 * no quota must render as a dash, never as a zero. "0 remaining" is a stop sign,
 * and inventing one over missing data would be a lie in the only direction that
 * costs the user something.
 *
 * Pure — no Electron, no fs, no clock of its own (`now` is always a parameter) —
 * so it runs under `node --test` directly and both processes can import it.
 */

/** The vendor's own statement of what is left on the account. */
export interface RateLimitSnapshot {
  remainingRequests?: number
  limitRequests?: number
  remainingTokens?: number
  limitTokens?: number
  /** Groq bills transcription in audio seconds and reports quota in them too. */
  remainingAudioSeconds?: number
  limitAudioSeconds?: number
  /** Epoch ms at which the window refills, normalised from several formats. */
  resetAt?: number
  /** Epoch ms this was read. Headroom is a measurement, and it goes stale. */
  observedAt: number
}

/** One billable call: a model turn or one transcribed utterance. */
export interface UsageEvent {
  at: number
  kind: 'llm' | 'asr'
  provider: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  audioSeconds?: number
  /** Present only when the response carried rate-limit headers. */
  limit?: RateLimitSnapshot
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  audioSeconds: number
  requests: number
}

export interface ProviderUsage {
  provider: string
  lastHour: UsageTotals
  lastDay: UsageTotals
  lastWeek: UsageTotals
  /** Null when this provider has never reported headroom. */
  limit: RateLimitSnapshot | null
}

export interface UsageSummary {
  providers: ProviderUsage[]
  generatedAt: number
}

/**
 * How each vendor spells its rate-limit headers.
 *
 * A table rather than `if (provider === 'anthropic')` at the call site, matching
 * how `openai-compat.ts` already treats provider quirks: a name check in the
 * parser would be one more copy of the provider list, and the next provider
 * added would silently miss it. 'none' is a real, deliberate entry — Deepgram,
 * AssemblyAI and Ollama publish no quota, and saying so here is what stops the
 * panel inventing a number for them.
 */
type Dialect = 'openai' | 'anthropic' | 'none'

const DIALECTS: Record<string, Dialect> = {
  anthropic: 'anthropic',
  // The OpenAI-compatible surface, same five providers as `PROVIDERS` in
  // openai-compat.ts. Groq appears once and covers both its chat and its
  // transcription endpoints — same account, same headers.
  google: 'openai',
  groq: 'openai',
  mistral: 'openai',
  cohere: 'openai',
  deepseek: 'openai',
  // Local. There is no account and no ceiling.
  ollama: 'none',
  // Cloud ASR that simply does not report quota in headers.
  deepgram: 'none',
  assemblyai: 'none'
}

/** A header that is absent, empty, or not a number reads as "not reported". */
function num(h: Headers, name: string): number | undefined {
  const raw = h.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * "2m59.56s", "7.66s", "1h2m3s" → milliseconds.
 *
 * The OpenAI-compatible providers express reset as a duration from now. Stored
 * as-is it would still claim "3 minutes" an hour later, so it is resolved
 * against `observedAt` into a wall-clock instant at the point of reading.
 */
function durationMs(raw: string): number | undefined {
  const m = raw.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/)
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    // Some providers send a bare number of seconds with no unit at all.
    const bare = Number(raw)
    return Number.isFinite(bare) ? Math.round(bare * 1000) : undefined
  }
  const h = Number(m[1] ?? 0)
  const min = Number(m[2] ?? 0)
  const s = Number(m[3] ?? 0)
  return Math.round((h * 3600 + min * 60 + s) * 1000)
}

/**
 * Read a vendor's headroom off one response.
 *
 * Returns null when the provider reported nothing usable — which is the common
 * case for two of the three ASR vendors and for Ollama, and is not a failure.
 */
export function parseRateLimitHeaders(
  provider: string,
  h: Headers,
  observedAt: number
): RateLimitSnapshot | null {
  const dialect = DIALECTS[provider] ?? 'openai'
  if (dialect === 'none') return null

  const snap: RateLimitSnapshot = { observedAt }

  if (dialect === 'anthropic') {
    snap.limitRequests = num(h, 'anthropic-ratelimit-requests-limit')
    snap.remainingRequests = num(h, 'anthropic-ratelimit-requests-remaining')
    snap.limitTokens = num(h, 'anthropic-ratelimit-tokens-limit')
    snap.remainingTokens = num(h, 'anthropic-ratelimit-tokens-remaining')
    // Already an instant, not a duration — parsing it as one would put the
    // reset somewhere in 1970.
    const reset = h.get('anthropic-ratelimit-tokens-reset')
    if (reset) {
      const t = Date.parse(reset)
      if (Number.isFinite(t)) snap.resetAt = t
    }
  } else {
    snap.limitRequests = num(h, 'x-ratelimit-limit-requests')
    snap.remainingRequests = num(h, 'x-ratelimit-remaining-requests')
    snap.limitTokens = num(h, 'x-ratelimit-limit-tokens')
    snap.remainingTokens = num(h, 'x-ratelimit-remaining-tokens')
    snap.limitAudioSeconds = num(h, 'x-ratelimit-limit-audio-seconds')
    snap.remainingAudioSeconds = num(h, 'x-ratelimit-remaining-audio-seconds')
    // Tokens reset first where both are present: it is the ceiling that
    // actually bites during an interview.
    const reset = h.get('x-ratelimit-reset-tokens') ?? h.get('x-ratelimit-reset-requests')
    if (reset) {
      const d = durationMs(reset)
      if (d !== undefined) snap.resetAt = observedAt + d
    }
  }

  // `observedAt` alone is not headroom. Without this a provider that sent no
  // rate-limit headers would still produce a snapshot, and the panel would
  // show an empty quota row for a vendor that never had one.
  const reported = Object.entries(snap).some(([k, v]) => k !== 'observedAt' && v !== undefined)
  return reported ? snap : null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    audioSeconds: 0,
    requests: 0
  }
}

function add(into: UsageTotals, e: UsageEvent): void {
  into.inputTokens += e.inputTokens ?? 0
  into.outputTokens += e.outputTokens ?? 0
  into.cacheReadTokens += e.cacheReadTokens ?? 0
  into.cacheWriteTokens += e.cacheWriteTokens ?? 0
  into.audioSeconds += e.audioSeconds ?? 0
  into.requests += 1
}

/**
 * Roll the event log up into what the panel renders.
 *
 * Windows are rolling rather than calendar-aligned ("last 24 hours", not
 * "today"), which sidesteps timezone and midnight-rollover questions that would
 * otherwise need answering for a number nobody reads that precisely. They nest:
 * a call a minute ago counts in all three.
 */
export function summarize(events: readonly UsageEvent[], now: number): UsageSummary {
  const byProvider = new Map<string, ProviderUsage>()

  for (const e of events) {
    let p = byProvider.get(e.provider)
    if (!p) {
      p = {
        provider: e.provider,
        lastHour: emptyTotals(),
        lastDay: emptyTotals(),
        lastWeek: emptyTotals(),
        limit: null
      }
      byProvider.set(e.provider, p)
    }

    const age = now - e.at
    if (age <= 7 * DAY) add(p.lastWeek, e)
    if (age <= DAY) add(p.lastDay, e)
    if (age <= HOUR) add(p.lastHour, e)

    // Freshest snapshot wins, decided by `observedAt` rather than by position
    // in the array: events are appended as replies land and replies can land
    // out of order, so the last element is not reliably the latest reading.
    if (e.limit && (p.limit === null || e.limit.observedAt > p.limit.observedAt)) {
      p.limit = e.limit
    }
  }

  return {
    providers: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    generatedAt: now
  }
}

/**
 * Drop events past the retention horizon.
 *
 * Called on write rather than on read so the file cannot grow without bound —
 * this is the only thing standing between a long-running install and a usage log
 * measured in megabytes.
 */
export function pruneEvents(
  events: readonly UsageEvent[],
  now: number,
  retentionDays: number
): UsageEvent[] {
  const horizon = now - retentionDays * DAY
  // `>=` keeps an event landing exactly on the boundary; a future-stamped event
  // is kept too, because a daylight-saving shift or a corrected system clock is
  // not a reason to delete someone's data.
  return events.filter((e) => e.at >= horizon)
}
