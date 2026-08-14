import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STICK_THRESHOLD_PX, isAtBottom, type ScrollMetrics } from './stickToBottom.ts'

function metrics(overrides: Partial<ScrollMetrics> = {}): ScrollMetrics {
  // A pane showing 400px of a 1000px transcript, scrolled to the very bottom.
  return { scrollTop: 600, clientHeight: 400, scrollHeight: 1000, ...overrides }
}

test('pinned to the bottom counts as at-bottom', () => {
  assert.equal(isAtBottom(metrics()), true)
})

test('a user who has scrolled up is not at-bottom', () => {
  // The whole point of the fix: this must be false, or the next streamed token
  // yanks them back down mid-read.
  assert.equal(isAtBottom(metrics({ scrollTop: 120 })), false)
})

test('a few pixels short of the bottom still counts as at-bottom', () => {
  // Fractional scroll offsets and sub-pixel line heights mean an untouched pane
  // is often a pixel or two off exact. Treating that as "scrolled away" would
  // silently disable auto-follow for everyone.
  assert.equal(isAtBottom(metrics({ scrollTop: 600 - (STICK_THRESHOLD_PX - 1) })), true)
})

test('just past the threshold is a deliberate scroll away', () => {
  assert.equal(isAtBottom(metrics({ scrollTop: 600 - (STICK_THRESHOLD_PX + 1) })), false)
})

test('content shorter than the pane is at-bottom', () => {
  // Nothing to scroll: an empty or one-bubble transcript must keep following,
  // otherwise auto-follow never switches on for a fresh session.
  assert.equal(isAtBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 200 }), true)
})

test('overscroll past the bottom is at-bottom', () => {
  // Rubber-band/elastic scrolling can report scrollTop beyond the maximum.
  assert.equal(isAtBottom(metrics({ scrollTop: 640 })), true)
})
