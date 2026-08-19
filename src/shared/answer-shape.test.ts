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

/**
 * Each mode gets the length its purpose calls for, rather than one number
 * imposed on all three.
 *
 * A real interviewer expects roughly a minute for "tell me about a time", and
 * fifteen seconds for "do you know X". A single cap serves one of those well and
 * the other badly, which is why the shared cap tried earlier was reverted.
 */
test('live is the shortest, practice the middle, star the longest', () => {
  const wordCap = (mode: 'practice' | 'star' | 'live'): number => {
    const match = /about (\d+) words/.exec(answerShapeFor(mode))
    assert.ok(match, `${mode} states no word cap`)
    return Number(match[1])
  }
  assert.equal(wordCap('live'), 40)
  assert.equal(wordCap('practice'), 90)
  assert.equal(wordCap('star'), 150)
  assert.ok(wordCap('live') < wordCap('practice'))
  assert.ok(wordCap('practice') < wordCap('star'))
})

// Drift guard, in the spirit of provider-tables.test.ts: a fourth mode must not
// be able to ship with no length rule at all. star and live carried none for
// months, which is how an answer ran to 230 words in one block.
test('every mode states a cap in both words and seconds', () => {
  for (const mode of ['practice', 'star', 'live'] as const) {
    const shape = answerShapeFor(mode)
    assert.match(shape, /about \d+ words/, `${mode} has no word cap`)
    assert.match(shape, /second|minute/, `${mode} does not say what the cap is for`)
  }
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
  assert.match(LABELLED_SHAPE, /90 words/)
})

// The cap is stated in seconds as well as words. The number is what the model
// can count; the seconds are what the limit is actually for, and an instruction
// carrying its own purpose survives a long prompt better than a bare figure.
test('the cap says what it is for, not just how many words', () => {
  assert.match(LABELLED_SHAPE, /seconds/)
})
