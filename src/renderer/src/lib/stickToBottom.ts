/**
 * Should the transcript keep following new messages?
 *
 * The transcript auto-scrolls to the bottom whenever `messages` changes, and
 * `messages` changes on *every streamed token* — the draft turn is rewritten in
 * place as it arrives. Unconditional, that pins the pane to the bottom dozens of
 * times a second, so scrolling up is undone in the same frame it happens and the
 * wheel reads as broken. Nothing above the fold can be reached while Hue is
 * answering, which is exactly when you want to look back at the question.
 *
 * So auto-follow becomes conditional on where the user already is: keep
 * following only if they were at the bottom when the new text landed. Scroll up
 * and Hue stops chasing; scroll back down and it resumes. This is the same
 * courtesy `.glance` already extends via its continuation check — a view must
 * not throw you out of the text you are reading.
 */

/** The parts of a scrollable element this decision needs. */
export interface ScrollMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/**
 * How far off the bottom still counts as "at the bottom", in pixels.
 *
 * Not zero. Fractional scroll offsets, sub-pixel line heights and display
 * scaling all mean an untouched pane routinely sits a pixel or two short of its
 * exact maximum, and an exact comparison would read that as a deliberate scroll
 * away — disabling auto-follow for everyone, permanently. Small enough that a
 * real scroll gesture always clears it.
 */
export const STICK_THRESHOLD_PX = 32

export function isAtBottom(m: ScrollMetrics): boolean {
  // Negative when the content is shorter than the pane, and elastic scrolling
  // can push scrollTop past the maximum; both are "at the bottom".
  return m.scrollHeight - m.scrollTop - m.clientHeight <= STICK_THRESHOLD_PX
}
