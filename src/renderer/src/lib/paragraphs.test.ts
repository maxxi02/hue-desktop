import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paragraphs } from './paragraphs.ts'

test('text with no blank line is a single paragraph', () => {
  assert.deepEqual(paragraphs('I use Postman constantly.'), ['I use Postman constantly.'])
})

test('blank lines split the text into beats', () => {
  const answer = 'Beat one.\n\nBeat two.\n\nBeat three.\n\nBeat four.'
  assert.deepEqual(paragraphs(answer), ['Beat one.', 'Beat two.', 'Beat three.', 'Beat four.'])
})

// A wrapped line inside one spoken beat is not a beat boundary. Splitting on
// every newline would shatter a single sentence the model happened to wrap.
test('a single newline stays inside one paragraph', () => {
  assert.deepEqual(paragraphs('one\ntwo'), ['one\ntwo'])
})

test('leading and trailing blank lines produce no empty paragraphs', () => {
  assert.deepEqual(paragraphs('\n\n  one  \n\n\n  two \n\n'), ['one', 'two'])
})

test('a blank line of spaces still splits', () => {
  assert.deepEqual(paragraphs('one\n   \ntwo'), ['one', 'two'])
})

// The streaming case: an empty or whitespace-only answer must yield nothing to
// render rather than one blank paragraph holding open a gap on the surface.
test('empty text yields no paragraphs', () => {
  assert.deepEqual(paragraphs(''), [])
  assert.deepEqual(paragraphs('   \n  '), [])
})
