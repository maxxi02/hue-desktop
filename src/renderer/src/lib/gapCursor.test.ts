import test from 'node:test'
import assert from 'node:assert/strict'
import { nextAfterAnswered, stepCursor, clampCursor } from './gapCursor.ts'

/**
 * The gap questions are answered one at a time, so something has to decide which
 * question is on screen next. That decision is not "index + 1": answering a gap
 * removes it from `openGaps`, so the array shifts underneath the index and the
 * naive version silently skips the question that slid into the old slot. Every
 * test here is about an id surviving an array that changed shape.
 */

test('answering a gap advances to the one that followed it, not to the shifted index', () => {
  // 'b' is answered and leaves the list. Index 1 now holds 'c' — which is also
  // the correct answer, but only by luck. The next test is the one that bites.
  const before = ['a', 'b', 'c', 'd']
  const after = ['a', 'c', 'd']
  assert.equal(nextAfterAnswered(before, 'b', after), 'c')
})

test('answering the first gap does not skip the second', () => {
  // The bug this whole module exists to prevent: with a plain index the cursor
  // stays at 0, the array shifts, and 'b' — never seen, never answered — is
  // now at index 0 with the cursor pointing past it at 'c'.
  const before = ['a', 'b', 'c']
  const after = ['b', 'c']
  assert.equal(nextAfterAnswered(before, 'a', after), 'b')
})

test('answering the last open gap falls back to the previous one rather than off the end', () => {
  const before = ['a', 'b', 'c']
  const after = ['a', 'b']
  assert.equal(nextAfterAnswered(before, 'c', after), 'b')
})

test('answering the only remaining gap reports no cursor, which is how the pane knows it is done', () => {
  assert.equal(nextAfterAnswered(['a'], 'a', []), null)
})

test('a rejected answer leaves the gap open, so the cursor must not move off it', () => {
  // `answerGap` can come back "that answer did not contain a story we could
  // use". The gap is still open and the user's text is still on screen; moving
  // on would hide the very question the message is about.
  const unchanged = ['a', 'b', 'c']
  assert.equal(nextAfterAnswered(unchanged, 'b', unchanged), 'b')
})

test('Back and Next walk the open gaps', () => {
  assert.equal(stepCursor(['a', 'b', 'c'], 'b', 1), 'c')
  assert.equal(stepCursor(['a', 'b', 'c'], 'b', -1), 'a')
})

test('Next stops at the last gap instead of wrapping round to the first', () => {
  // Wrapping would make "Next" on the final question look like it had saved
  // something and started over.
  assert.equal(stepCursor(['a', 'b', 'c'], 'c', 1), 'c')
  assert.equal(stepCursor(['a', 'b', 'c'], 'a', -1), 'a')
})

test('a cursor pointing at a gap that no longer exists lands on a real one', () => {
  // Reloading the profile replaces the whole bundle; the id on screen may be
  // gone. Anything but a valid id here renders a blank question.
  assert.equal(clampCursor(['a', 'b'], 'zz'), 'a')
})

test('a cursor is left alone when it still points at an open gap', () => {
  assert.equal(clampCursor(['a', 'b'], 'b'), 'b')
})

test('no open gaps means no cursor', () => {
  assert.equal(clampCursor([], 'a'), null)
})
