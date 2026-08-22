import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerShapeFor, ASSESSMENT_SHAPE, LABELLED_SHAPE } from './answer-shape.ts'

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
  // practice reads 70: its first cap is the spoken answer. The optional story
  // carries its own, smaller one and is not part of what the user says by default.
  assert.equal(wordCap('live'), 40)
  assert.equal(wordCap('practice'), 70)
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

// The markers are app chrome. If the model believes they are spoken, the user
// reads "hash hash what" to an interviewer.
test('the shape says the markers are stripped and never spoken', () => {
  assert.match(LABELLED_SHAPE, /strips the markers/)
})

// The screenshots that motivated this shape ran to roughly 230 words in one
// block. A cap the model can act on is the only thing that was missing.
test('the answer and the optional story are capped separately', () => {
  assert.match(LABELLED_SHAPE, /about 70 words/)
  assert.match(LABELLED_SHAPE, /about 30 words/)
})

// The cap is stated in seconds as well as words. The number is what the model
// can count; the seconds are what the limit is actually for, and an instruction
// carrying its own purpose survives a long prompt better than a bare figure.
test('the cap says what it is for, not just how many words', () => {
  assert.match(LABELLED_SHAPE, /seconds/)
})

/**
 * The complaint this shape was rewritten to fix: the card "jumps to the story
 * bank instead of answering the question straightly".
 *
 * The cause was a fixed 50/50 split, which handed half the answer to a story
 * even on a technical question, while the voice rule that says not to force a
 * story onto a crisp question was overridden by it. The answer now has to stand
 * complete on its own, and the story is something held in reserve.
 */
test('part one must answer the question without the story', () => {
  assert.match(LABELLED_SHAPE, /fully answer the question on its own/)
  assert.match(LABELLED_SHAPE, /reads only this part/)
})

test('the story is optional, and never something part one leans on', () => {
  assert.match(LABELLED_SHAPE, /optional/)
  assert.match(LABELLED_SHAPE, /never needed to complete the answer/)
})

// An optional extra is exactly the thing that must never be improvised: it is
// volunteered on purpose, so an invented one is a claim the user chose to make.
test('an unfitting story is omitted rather than bent', () => {
  assert.match(LABELLED_SHAPE, /omit "## scenario" entirely/)
  assert.match(LABELLED_SHAPE, /[Nn]ever invent one/)
})

// Assessment is not an InterviewMode, so it is exported directly and the dash
// test above cannot reach it through answerShapeFor. Checked here explicitly:
// the rule is about this file, not about that function.
test('the assessment shape contains no em dash or en dash either', () => {
  assert.doesNotMatch(ASSESSMENT_SHAPE, /[—–]/)
})

test('the assessment shape names all four markers', () => {
  for (const marker of ['## approach', '## steps', '## code', '## complexity']) {
    assert.ok(ASSESSMENT_SHAPE.includes(marker), `missing ${marker}`)
  }
})

// LABELLED_SHAPE ends with "never write a heading, a label, a number, or a
// bullet of your own". Steps are the one exception and must say so, or the two
// instructions fight and the model picks one.
test('the assessment shape permits numbering, which every other shape forbids', () => {
  assert.match(ASSESSMENT_SHAPE, /number/i)
})

test('the assessment shape keeps code out of the spoken part', () => {
  assert.match(ASSESSMENT_SHAPE, /never read aloud/i)
})

// Assessment must be reachable from every interview mode: someone in star mode
// who is asked to design a function still needs the code answer.
test('assessment is not folded into the interview modes', () => {
  for (const mode of ['practice', 'star', 'live'] as const) {
    assert.notEqual(answerShapeFor(mode), ASSESSMENT_SHAPE)
  }
})
