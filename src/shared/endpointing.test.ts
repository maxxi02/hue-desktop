import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EndpointBuffer, DEFAULT_ENDPOINT_CONFIG } from './endpointing.ts'

test('a lone segment completes when the hold expires', () => {
  const buf = new EndpointBuffer()
  const decision = buf.onSegmentFinal('what is your greatest weakness?', 0)
  assert.deepEqual(decision, { kind: 'hold', until: DEFAULT_ENDPOINT_CONFIG.holdMs })
  assert.deepEqual(buf.onHoldExpired(DEFAULT_ENDPOINT_CONFIG.holdMs), {
    text: 'what is your greatest weakness?'
  })
})

// The defect this module exists for. One sentence, one pause, two VAD segments.
test('the screenshot case reassembles into one question', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('Walk me through your brass.', 0)
  assert.equal(buf.onSpeechStart(400), true)
  buf.onSegmentFinal('when you are testing a new endpoint for the first time.', 2500)
  assert.deepEqual(buf.onHoldExpired(3200), {
    text: 'Walk me through your brass. when you are testing a new endpoint for the first time.'
  })
})

test('speech after the hold has passed is not a continuation', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('tell me about a time you disagreed with your manager.', 0)
  assert.equal(buf.onSpeechStart(1500), false)
})

test('nothing held means nothing to complete', () => {
  const buf = new EndpointBuffer()
  assert.equal(buf.onHoldExpired(5000), null)
})

// A talkative interviewer must not defer the answer without bound, for the same
// reason INTERIM_MAX_SAMPLES exists in the pipeline.
test('the segment cap completes rather than holding again', () => {
  const buf = new EndpointBuffer({ maxHeldSegments: 2 })
  assert.equal(buf.onSegmentFinal('one', 0).kind, 'hold')
  buf.onSpeechStart(100)
  const decision = buf.onSegmentFinal('two', 500)
  assert.deepEqual(decision, { kind: 'complete', text: 'one two' })
  // Completing clears the buffer: the next question starts empty.
  assert.equal(buf.heldText, '')
})

test('reset drops a held question', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('half a question', 0)
  buf.reset()
  assert.equal(buf.onHoldExpired(700), null)
})

test('an empty segment does not extend the hold with blank text', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('a real question here', 0)
  buf.onSpeechStart(200)
  buf.onSegmentFinal('   ', 900)
  assert.deepEqual(buf.onHoldExpired(1600), { text: 'a real question here' })
})
