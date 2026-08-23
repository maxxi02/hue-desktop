import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessmentRouting, looksLikeCodingQuestion } from './assessment.ts'

const CODING = [
  'How would you design an SSR function?',
  'how would you implement a rate limiter',
  'Write a function that reverses a linked list',
  "What's the time complexity of that?",
  'Walk me through the algorithm you would use',
  'Can you code up a debounce for me',
  'How would you structure the database schema for this',
  'implement fizzbuzz'
]

const BEHAVIOURAL = [
  'Tell me about a time you disagreed with your manager',
  'Tell me about a hard technical decision you made',
  "What's the hardest bug you've ever shipped?",
  'How do you approach code review?',
  'Why do you want to work here?',
  'Tell me about yourself',
  'How do you handle disagreement on a technical team?',
  'What did you learn from that project?'
]

test('a coding question is recognised', () => {
  for (const q of CODING) {
    assert.equal(looksLikeCodingQuestion(q), true, `should fire: ${q}`)
  }
})

test('a behavioural question wearing technical words is not', () => {
  // This is the half that matters. Firing here buries a STAR answer under a
  // code block while the user is mid-interview.
  for (const q of BEHAVIOURAL) {
    assert.equal(looksLikeCodingQuestion(q), false, `should not fire: ${q}`)
  }
})

test('empty and junk input never fires', () => {
  assert.equal(looksLikeCodingQuestion(''), false)
  assert.equal(looksLikeCodingQuestion('   '), false)
  assert.equal(looksLikeCodingQuestion('uh, so, um'), false)
})

test('classification survives a partial interim transcript', () => {
  // Routing happens on the interim transcript, so the decision must be
  // reachable before the sentence is finished.
  assert.equal(looksLikeCodingQuestion('how would you implement a'), true)
})

/**
 * The routing decision, pinned as a whole rather than one flag at a time.
 *
 * `speak` and `speculate` are what stop a code answer being read aloud to the
 * interviewer or drafted repeatedly against the most expensive model, so a
 * regression in either is expensive and silent.
 */
const S = { assessmentEnabled: true } as never

test('an armed coding question routes to assessment', () => {
  const r = assessmentRouting(S, 'How would you design an SSR function?')
  assert.equal(r.assessment, true)
  assert.equal(r.speak, false)
  assert.equal(r.speculate, false)
  assert.equal(r.maxTokens, 1500)
})

test('an armed behavioural question does not', () => {
  const r = assessmentRouting(S, 'Tell me about a time you disagreed')
  assert.equal(r.assessment, false)
  assert.equal(r.maxTokens, 700)
})

test('a disarmed session never routes to assessment', () => {
  const r = assessmentRouting({ assessmentEnabled: false } as never, 'write a function that sorts')
  assert.equal(r.assessment, false)
})

/**
 * Arming the mode must not silence an ordinary answer.
 *
 * `speak` is a permission the caller ANDs with its own state, so `true` here
 * means "no objection", not "speak now". A behavioural question in an armed
 * session has to come back with both permissions intact, or interviewer mode
 * goes mute the moment the user arms assessment.
 */
test('an armed session leaves behavioural answers speakable and speculable', () => {
  const r = assessmentRouting(S, 'Tell me about a time you disagreed')
  assert.equal(r.speak, true)
  assert.equal(r.speculate, true)
})
