import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeCodingQuestion } from './assessment.ts'

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
