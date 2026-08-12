import test from 'node:test'
import assert from 'node:assert/strict'
import { outcomeForExtractFailure, outcomeForError } from './ingest.ts'
import { LlmRefusal, MissingApiKey } from './structured-llm.ts'

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
