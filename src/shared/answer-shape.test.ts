import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerShapeFor, LABELLED_SHAPE, SPOKEN_LENGTH_CAP } from './answer-shape.ts'

test('practice mode gets the labelled sections', () => {
  assert.ok(answerShapeFor('practice').includes(LABELLED_SHAPE))
})

// The cap is composed onto every shape rather than written into each one, so a
// fourth mode cannot be added without it. Unbounded length is the defect this
// exists to prevent, and star and live carried no length rule at all before.
test('every mode carries the spoken length cap', () => {
  for (const mode of ['practice', 'star', 'live'] as const) {
    assert.ok(answerShapeFor(mode).includes(SPOKEN_LENGTH_CAP), `${mode} is missing the cap`)
  }
})

test('the cap is 70 words, stated as 30 seconds spoken', () => {
  assert.match(SPOKEN_LENGTH_CAP, /70 words/)
  assert.match(SPOKEN_LENGTH_CAP, /30 seconds/)
})

// A ceiling, not a target. Phrased as a target it would make live answers
// LONGER than they are now, which is the opposite of what that mode is for.
test('the cap reads as a ceiling rather than a target', () => {
  assert.match(SPOKEN_LENGTH_CAP, /hard ceiling rather than a target/)
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

// The length rule lives in SPOKEN_LENGTH_CAP now, composed onto every mode.
// Duplicating it inside the shape would be two numbers to disagree with each
// other, which is the class of bug that produced the walls of text.
test('the labelled shape states no length of its own', () => {
  assert.doesNotMatch(LABELLED_SHAPE, /\d+ words/)
})
