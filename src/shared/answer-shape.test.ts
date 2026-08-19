import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerShapeFor, LABELLED_SHAPE } from './answer-shape.ts'

test('practice mode gets the labelled sections', () => {
  assert.equal(answerShapeFor('practice'), LABELLED_SHAPE)
})

// star and live are deliberate choices the user made, and each already carries
// a shape instruction that contradicts the labelled sections. Neither may
// quietly inherit them.
test('star mode keeps STAR and never mentions the markers', () => {
  const shape = answerShapeFor('star')
  assert.match(shape, /Situation, Task, Action, Result/)
  assert.doesNotMatch(shape, /##/)
})

test('live mode stays terse and never mentions the markers', () => {
  const shape = answerShapeFor('live')
  assert.match(shape, /Brevity over completeness/)
  assert.doesNotMatch(shape, /##/)
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

// The vocabulary has to agree with answer-beats.ts exactly. A marker the prompt
// asks for that the parser does not know stays on screen as literal "## " text
// in the middle of an answer being read aloud.
test('the shape names every marker the parser accepts', () => {
  for (const marker of ['## what', '## why', '## how', '## when', '## scenario']) {
    assert.ok(LABELLED_SHAPE.includes(marker), `missing ${marker}`)
  }
})

// The scenario half must be optional in the prompt itself, or a model with an
// empty story bank is under standing instructions to invent one to fill it.
test('the shape permits omitting the scenario when no story fits', () => {
  assert.match(LABELLED_SHAPE, /omit the "## scenario" section/)
  assert.match(LABELLED_SHAPE, /[Nn]ever invent a scenario/)
})

// The markers are app chrome. If the model believes they are spoken, the user
// reads "hash hash what" to an interviewer.
test('the shape says the markers are stripped and never spoken', () => {
  assert.match(LABELLED_SHAPE, /strips the markers/)
})

// The screenshots that motivated this shape ran to roughly 230 words in one
// block. A cap the model can act on is the only thing that was missing.
test('the shape caps the length, because the surface is read at a glance', () => {
  assert.match(LABELLED_SHAPE, /120 words/)
})
