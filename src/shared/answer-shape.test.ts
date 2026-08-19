import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerShapeFor, FOUR_BEAT_SHAPE } from './answer-shape.ts'

test('practice mode gets the four beats', () => {
  assert.equal(answerShapeFor('practice'), FOUR_BEAT_SHAPE)
})

// star and live are deliberate choices the user made, and each already carries
// a shape instruction that contradicts the beats. Neither may quietly inherit
// them.
test('star mode keeps STAR and never mentions beats', () => {
  const shape = answerShapeFor('star')
  assert.match(shape, /Situation, Task, Action, Result/)
  assert.doesNotMatch(shape, /beat/i)
})

test('live mode stays terse and never mentions beats', () => {
  const shape = answerShapeFor('live')
  assert.match(shape, /Brevity over completeness/)
  assert.doesNotMatch(shape, /beat/i)
})

// HUMAN_VOICE_GUIDANCE forbids dashes in Hue's output, and a dash anywhere in
// the instruction teaches the model to use one no matter what the abstract rule
// says. That is how em dashes got into the answers once before, so it is pinned
// here rather than trusted to review.
test('no shape instruction contains an em dash or an en dash', () => {
  for (const mode of ['practice', 'star', 'live'] as const) {
    assert.doesNotMatch(answerShapeFor(mode), /[—–]/, `${mode} shape contains a dash`)
  }
})

test('the four beats ask for blank-line separation and forbid labels', () => {
  assert.match(FOUR_BEAT_SHAPE, /blank line/)
  assert.match(FOUR_BEAT_SHAPE, /no headings, no labels/)
})
