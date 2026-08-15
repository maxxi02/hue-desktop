import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRateLimitHeaders, summarize, pruneEvents, type UsageEvent } from './usage.ts'

/**
 * Two separate jobs live in this module and the tests are grouped that way.
 *
 * `parseRateLimitHeaders` turns a vendor's headers into headroom. Every vendor
 * spells it differently and several do not report it at all, so the thing under
 * test is mostly "does it stay quiet when it does not know" — a fabricated 0 in
 * a quota display is worse than a blank, because a blank prompts you to go look
 * and a 0 tells you to stop working.
 *
 * `summarize` turns a pile of events into what the panel renders.
 */

const AT = Date.UTC(2026, 7, 15, 12, 0, 0)

function headers(pairs: Record<string, string>): Headers {
  return new Headers(pairs)
}

// ── Header parsing ──────────────────────────────────────────────────────────

test('an OpenAI-compatible provider reports its remaining requests and tokens', () => {
  const snap = parseRateLimitHeaders(
    'groq',
    headers({
      'x-ratelimit-limit-requests': '14400',
      'x-ratelimit-remaining-requests': '14370',
      'x-ratelimit-limit-tokens': '18000',
      'x-ratelimit-remaining-tokens': '17512'
    }),
    AT
  )
  assert.equal(snap?.remainingRequests, 14370)
  assert.equal(snap?.limitRequests, 14400)
  assert.equal(snap?.remainingTokens, 17512)
  assert.equal(snap?.limitTokens, 18000)
})

test('Groq reports transcription quota in audio seconds, which is what it bills', () => {
  // The one ASR provider that reports headroom at all, and it does it in a unit
  // no LLM provider uses. Dropping it would leave the transcriber column blank
  // for the only vendor that fills it.
  const snap = parseRateLimitHeaders(
    'groq',
    headers({
      'x-ratelimit-limit-audio-seconds': '7200',
      'x-ratelimit-remaining-audio-seconds': '6480'
    }),
    AT
  )
  assert.equal(snap?.remainingAudioSeconds, 6480)
  assert.equal(snap?.limitAudioSeconds, 7200)
})

test('Anthropic spells its rate-limit headers differently and is read on its own terms', () => {
  const snap = parseRateLimitHeaders(
    'anthropic',
    headers({
      'anthropic-ratelimit-requests-limit': '1000',
      'anthropic-ratelimit-requests-remaining': '999',
      'anthropic-ratelimit-tokens-limit': '80000',
      'anthropic-ratelimit-tokens-remaining': '76000'
    }),
    AT
  )
  assert.equal(snap?.remainingRequests, 999)
  assert.equal(snap?.remainingTokens, 76000)
  assert.equal(snap?.limitTokens, 80000)
})

test('a duration-style reset becomes a wall-clock time the panel can count down to', () => {
  // Groq sends "2m59.56s" — a duration from now, not a timestamp. Stored raw it
  // would still read "3 minutes" an hour later.
  const snap = parseRateLimitHeaders(
    'groq',
    headers({
      'x-ratelimit-remaining-tokens': '10',
      'x-ratelimit-reset-tokens': '2m59.56s'
    }),
    AT
  )
  assert.equal(snap?.resetAt, AT + 179_560)
})

test('a bare seconds reset is a duration too', () => {
  const snap = parseRateLimitHeaders(
    'groq',
    headers({ 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-reset-tokens': '7.66s' }),
    AT
  )
  assert.equal(snap?.resetAt, AT + 7_660)
})

test("Anthropic's reset is already a timestamp and is not treated as a duration", () => {
  const snap = parseRateLimitHeaders(
    'anthropic',
    headers({
      'anthropic-ratelimit-tokens-remaining': '10',
      'anthropic-ratelimit-tokens-reset': '2026-08-15T12:05:00Z'
    }),
    AT
  )
  assert.equal(snap?.resetAt, Date.UTC(2026, 7, 15, 12, 5, 0))
})

test('a provider that reports no quota at all yields nothing rather than a row of zeroes', () => {
  // Deepgram and AssemblyAI send no rate-limit headers. A snapshot full of
  // zeroes would render as "0 left" — the panel must show a dash instead.
  assert.equal(parseRateLimitHeaders('deepgram', headers({}), AT), null)
  assert.equal(parseRateLimitHeaders('assemblyai', headers({ 'content-type': 'json' }), AT), null)
})

test('Ollama is local, so it has no quota to report', () => {
  assert.equal(parseRateLimitHeaders('ollama', headers({}), AT), null)
})

test('a partially reported quota keeps the fields it has and omits the rest', () => {
  const snap = parseRateLimitHeaders(
    'mistral',
    headers({ 'x-ratelimit-remaining-requests': '42' }),
    AT
  )
  assert.equal(snap?.remainingRequests, 42)
  assert.equal(snap?.remainingTokens, undefined)
  assert.equal(snap?.limitRequests, undefined)
})

test('a header that is not a number is ignored rather than stored as NaN', () => {
  // NaN survives JSON.stringify as null and then renders as an empty cell that
  // looks like a bug. Refusing it at the door keeps the file clean.
  const snap = parseRateLimitHeaders(
    'groq',
    headers({ 'x-ratelimit-remaining-tokens': 'unknown' }),
    AT
  )
  assert.equal(snap, null)
})

test('every snapshot records when it was observed, because headroom goes stale', () => {
  const snap = parseRateLimitHeaders(
    'groq',
    headers({ 'x-ratelimit-remaining-tokens': '5' }),
    AT
  )
  assert.equal(snap?.observedAt, AT)
})

// ── Summarising ─────────────────────────────────────────────────────────────

const HOUR = 3_600_000
const DAY = 24 * HOUR

function llm(at: number, provider: string, input: number, output: number): UsageEvent {
  return { at, kind: 'llm', provider, inputTokens: input, outputTokens: output }
}

test('usage is totalled per provider, not lumped together', () => {
  const events = [
    llm(AT - 60_000, 'groq', 100, 20),
    llm(AT - 60_000, 'anthropic', 500, 90),
    llm(AT - 120_000, 'groq', 300, 10)
  ]
  const s = summarize(events, AT)
  const groq = s.providers.find((p) => p.provider === 'groq')
  assert.equal(groq?.lastHour.inputTokens, 400)
  assert.equal(groq?.lastHour.outputTokens, 30)
  assert.equal(s.providers.find((p) => p.provider === 'anthropic')?.lastHour.inputTokens, 500)
})

test('the hour window excludes what happened before it', () => {
  const events = [llm(AT - 2 * HOUR, 'groq', 999, 999), llm(AT - 60_000, 'groq', 1, 2)]
  const groq = summarize(events, AT).providers[0]
  assert.equal(groq.lastHour.inputTokens, 1)
  assert.equal(groq.lastDay.inputTokens, 1000)
})

test('the day and week windows nest, so a recent call counts in all three', () => {
  const groq = summarize([llm(AT - 1000, 'groq', 10, 5)], AT).providers[0]
  assert.equal(groq.lastHour.inputTokens, 10)
  assert.equal(groq.lastDay.inputTokens, 10)
  assert.equal(groq.lastWeek.inputTokens, 10)
})

test('transcription is counted in audio seconds alongside the token columns', () => {
  const events: UsageEvent[] = [
    { at: AT - 1000, kind: 'asr', provider: 'deepgram', audioSeconds: 12.5 },
    { at: AT - 2000, kind: 'asr', provider: 'deepgram', audioSeconds: 7.5 }
  ]
  const dg = summarize(events, AT).providers[0]
  assert.equal(dg.lastHour.audioSeconds, 20)
  assert.equal(dg.lastHour.requests, 2)
})

test('the freshest quota snapshot wins, so the panel never shows stale headroom', () => {
  const events: UsageEvent[] = [
    { at: AT - 5000, kind: 'llm', provider: 'groq', limit: { remainingTokens: 900, observedAt: AT - 5000 } },
    { at: AT - 1000, kind: 'llm', provider: 'groq', limit: { remainingTokens: 400, observedAt: AT - 1000 } }
  ]
  assert.equal(summarize(events, AT).providers[0].limit?.remainingTokens, 400)
})

test('an out-of-order event does not make older headroom look current', () => {
  // Events are appended as replies land, and replies can land out of order.
  // Trusting array position instead of observedAt would show the older number.
  const events: UsageEvent[] = [
    { at: AT - 1000, kind: 'llm', provider: 'groq', limit: { remainingTokens: 400, observedAt: AT - 1000 } },
    { at: AT - 5000, kind: 'llm', provider: 'groq', limit: { remainingTokens: 900, observedAt: AT - 5000 } }
  ]
  assert.equal(summarize(events, AT).providers[0].limit?.remainingTokens, 400)
})

test('a provider that only ever reported usage has no headroom, and says so', () => {
  assert.equal(summarize([llm(AT - 1000, 'ollama', 5, 5)], AT).providers[0].limit, null)
})

test('no events at all summarises to nothing rather than throwing', () => {
  assert.deepEqual(summarize([], AT).providers, [])
})

// ── Pruning ─────────────────────────────────────────────────────────────────

test('events older than the retention window are dropped so the file cannot grow forever', () => {
  const events = [llm(AT - 8 * DAY, 'groq', 1, 1), llm(AT - 6 * DAY, 'groq', 2, 2)]
  const kept = pruneEvents(events, AT, 7)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].inputTokens, 2)
})

test('pruning keeps an event exactly on the boundary rather than losing it to rounding', () => {
  const events = [llm(AT - 7 * DAY, 'groq', 3, 3)]
  assert.equal(pruneEvents(events, AT, 7).length, 1)
})

test('an event stamped in the future is kept, since a clock change is not a reason to lose data', () => {
  const events = [llm(AT + DAY, 'groq', 1, 1)]
  assert.equal(pruneEvents(events, AT, 7).length, 1)
})
