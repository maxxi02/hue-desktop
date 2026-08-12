import test from 'node:test'
import assert from 'node:assert/strict'
import { outcomeForExtractFailure, outcomeForError } from './ingest.ts'
import { LlmRefusal, MissingApiKey, ProviderError } from './structured-llm.ts'

/**
 * `ingest.ts` imports `./settings`, which pulls in Electron, so the functions
 * exercised here are the pure decision surface: given a failure, what does the
 * user get told, and are they invited to retry?
 */

test('an extraction refusal keeps the extractor’s own wording — it knows what was wrong', () => {
  const outcome = outcomeForExtractFailure({
    ok: false,
    reason: 'no-text-layer',
    message: 'This PDF has no text in it — it looks like a scan or an image.'
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /scan or an image/)
})

test('an extraction refusal is never retryable — the same file fails the same way', () => {
  const outcome = outcomeForExtractFailure({
    ok: false,
    reason: 'too-short',
    message: 'We only found a few words in that file.'
  })
  assert.equal(outcome.ok === false && outcome.retryable, false)
})

test('a missing key is not retryable and names Settings, not the network', () => {
  const outcome = outcomeForError(new MissingApiKey('Anthropic'))
  assert.equal(outcome.ok === false && outcome.retryable, false)
  assert.match(outcome.ok === false ? outcome.message : '', /Settings/)
})

test('a model refusal is terminal — the same input will be refused again', () => {
  const outcome = outcomeForError(new LlmRefusal('The model declined.', 'story mining'))
  assert.equal(outcome.ok === false && outcome.retryable, false)
})

test('an unknown transport error is retryable, because a blip genuinely might not recur', () => {
  const outcome = outcomeForError(new Error('socket hang up'))
  assert.equal(outcome.ok === false && outcome.retryable, true)
  assert.match(outcome.ok === false ? outcome.message : '', /socket hang up/)
})

test('a non-Error throw still produces a message rather than "[object Object]"', () => {
  const outcome = outcomeForError('everything broke')
  assert.match(outcome.ok === false ? outcome.message : '', /everything broke/)
})

test('a request larger than the whole per-minute cap names the fix, not the rate limit', () => {
  // The exact body Groq's free tier returns for story mining.
  const err = new ProviderError(
    413,
    '{"error":{"message":"Request too large for model `openai/gpt-oss-120b` ... on tokens per minute (TPM): Limit 8000, Requested 9779","code":"rate_limit_exceeded"}}'
  )
  const outcome = outcomeForError(err)
  assert.equal(outcome.ok, false)
  // Not retryable: the same document is the same size next time.
  assert.equal(outcome.ok === false && outcome.retryable, false)
  assert.match(outcome.ok === false ? outcome.message : '', /Ingest provider/i)
})

test('an ordinary rate limit is still retryable — that one does clear on its own', () => {
  const err = new ProviderError(429, '{"error":{"message":"Too many requests, slow down."}}')
  assert.equal(outcomeForError(err).ok === false && outcomeForError(err).retryable, true)
})

test('a spent daily allowance says so, and does not blame the document', () => {
  const err = new ProviderError(
    429,
    '{"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` ... on tokens per day (TPD): Limit 100000, Used 99051, Requested 5329. Please try again in 1h3m4.31s","code":"rate_limit_exceeded"}}'
  )
  const outcome = outcomeForError(err)
  const message = outcome.ok === false ? outcome.message : ''
  assert.match(message, /daily token allowance/i)
  // The provider states the reset; quoting it beats "try again later".
  assert.match(message, /1h3m4/)
  // Must NOT tell the user the document is too big — it is not.
  assert.doesNotMatch(message, /more tokens in one request/i)
})

test('a per-request cap blames the request size and points at the provider setting', () => {
  const err = new ProviderError(
    413,
    '{"error":{"message":"Request too large ... on tokens per minute (TPM): Limit 8000, Requested 9779"}}'
  )
  const message = (() => {
    const o = outcomeForError(err)
    return o.ok === false ? o.message : ''
  })()
  assert.match(message, /more tokens in one request/i)
  assert.match(message, /Ingest provider/i)
})
