/**
 * Which gap question is on screen, tracked by id rather than by index.
 *
 * The gaps are answered one at a time, and answering one removes it from
 * `openGaps` — so the array shifts under any index the UI was holding. A cursor
 * of `1` pointing at "b" in `[a, b, c]` points at "c" the moment "a" is
 * answered, and "b" is never shown. Ids do not shift, so the cursor is an id and
 * the list is consulted only to decide where that id can move to.
 *
 * Pure and separate from the component for the same reason `stickToBottom.ts`
 * and `sessionHistory.ts` are: this is the part with behaviour worth testing,
 * and the JSX around it is just a textarea.
 */

/**
 * The cursor after a save or skip.
 *
 * `before` is the open list as it was when the answer was submitted, `after` is
 * the list the main process returned. Passing both is what lets this walk
 * forward through questions the user has not seen yet: `after` alone has lost
 * the position the answered gap used to occupy.
 *
 * Falls back to the previous surviving gap when the answered one was last, and
 * returns null only when nothing is left to answer.
 */
export function nextAfterAnswered(
  before: readonly string[],
  answeredId: string,
  after: readonly string[]
): string | null {
  const stillOpen = new Set(after)

  // A rejected answer leaves the gap open. Staying put is the whole point: the
  // "we couldn't use that" note is about this question, and advancing would
  // hide the question the note refers to.
  if (stillOpen.has(answeredId)) return answeredId

  const from = before.indexOf(answeredId)
  // An id that was never in `before` gives -1; starting the forward walk at 0
  // then treats it as "show the first thing still open", which is the only
  // sensible reading of a cursor that was already stale.
  const start = from === -1 ? 0 : from

  for (let i = start; i < before.length; i++) {
    if (stillOpen.has(before[i])) return before[i]
  }
  // Nothing after it survived, so the user answered the last one. Step back to
  // whatever is still open rather than returning null, which would read as
  // "all done" while questions remain above.
  for (let i = start - 1; i >= 0; i--) {
    if (stillOpen.has(before[i])) return before[i]
  }
  return null
}

/**
 * Back and Next. Clamps at both ends instead of wrapping — wrapping from the
 * last question to the first looks like the form submitted and started over.
 */
export function stepCursor(
  openIds: readonly string[],
  currentId: string | null,
  delta: number
): string | null {
  if (openIds.length === 0) return null
  const at = currentId === null ? -1 : openIds.indexOf(currentId)
  if (at === -1) return openIds[0]
  const next = Math.min(openIds.length - 1, Math.max(0, at + delta))
  return openIds[next]
}

/**
 * Force a cursor back onto a gap that actually exists.
 *
 * Reloading or re-ingesting the profile swaps the whole bundle, and the id on
 * screen can vanish with it. Without this the pane renders a question that is
 * `undefined`.
 */
export function clampCursor(openIds: readonly string[], currentId: string | null): string | null {
  if (openIds.length === 0) return null
  if (currentId !== null && openIds.includes(currentId)) return currentId
  return openIds[0]
}
