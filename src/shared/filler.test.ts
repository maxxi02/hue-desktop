import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFillerOnly } from './filler.ts'

test('a lone um is filler', () => {
  assert.equal(isFillerOnly('um'), true)
})

test('filler survives case and trailing punctuation', () => {
  assert.equal(isFillerOnly('Um...'), true)
  assert.equal(isFillerOnly('Uh,'), true)
  assert.equal(isFillerOnly('HMMM'), true)
})

test('a run of fillers is still filler', () => {
  assert.equal(isFillerOnly('um so'), true)
  assert.equal(isFillerOnly('uh, um... right'), true)
  assert.equal(isFillerOnly('okay yeah sure'), true)
})

test('punctuation or whitespace alone is filler', () => {
  assert.equal(isFillerOnly('...'), true)
  assert.equal(isFillerOnly('   '), true)
  assert.equal(isFillerOnly(''), true)
})

// The reason this is a vocabulary test and not a word-count minimum. A single
// word can be a real question, and suppressing it would cost the user an answer
// with no visible sign anything went wrong.
test('a one-word question is not filler', () => {
  assert.equal(isFillerOnly('Why?'), false)
  assert.equal(isFillerOnly('Thoughts?'), false)
})

test('one content word among fillers makes the whole utterance real', () => {
  assert.equal(isFillerOnly('um so why'), false)
  assert.equal(isFillerOnly('so why do you want to'), false)
})

test('an ordinary question is not filler', () => {
  assert.equal(isFillerOnly('Tell me more.'), false)
  assert.equal(isFillerOnly('So why do you want to work with a pharma client?'), false)
})

// Deliberately excluded from the vocabulary: they are real words, and the cost
// of suppressing a real word is invisible while the cost of answering one is a
// merely odd answer.
test('yes and no are not treated as filler', () => {
  assert.equal(isFillerOnly('yes'), false)
  assert.equal(isFillerOnly('no'), false)
})
