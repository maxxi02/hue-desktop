/**
 * Is there work in the Settings pane that closing it would throw away?
 *
 * The pane edits a local copy and persists it only when Save is pressed, so
 * every close path — the X, the backdrop — silently discarded whatever had been
 * typed. An API key entered and not saved was simply gone, with nothing on
 * screen to suggest it would be.
 *
 * Two kinds of unsaved work, and the second is the one worth protecting. A
 * half-changed toggle is cheap to redo. A gap answer is a story the user has
 * just composed out of their own memory, it lives outside the settings object
 * entirely, and it is the single most expensive thing in this pane to lose.
 *
 * Pure and separate from the component for the same reason `gapCursor.ts` and
 * `stickToBottom.ts` are: this is the part with behaviour worth testing, and the
 * modal around it is just JSX.
 */

import type { HueSettings } from '../../../shared/types'

/**
 * `pristine` is the settings as last *persisted*, not as last rendered.
 *
 * Several paths write through the main process and then sync the local copy —
 * the phone-mirror, stealth and relay toggles, and every profile mutation
 * (ingest, gap answer, gap skip, rescan) which assigns `profileBundleJson` after
 * main has already stored it. Each of those must refresh `pristine` too, or this
 * reports unsaved changes for work that is already on disk and the guard becomes
 * something the user learns to dismiss.
 */
export function isSettingsDirty(
  current: HueSettings,
  pristine: HueSettings,
  gapDrafts: Record<string, string>
): boolean {
  if (Object.values(gapDrafts).some((draft) => draft.trim().length > 0)) return true
  return !sameSettings(current, pristine)
}

/**
 * Value equality over the settings object.
 *
 * Compared key by key against a sorted key list rather than by stringifying
 * both: `JSON.stringify` is order-sensitive, and these objects are routinely
 * rebuilt by spreading, which does not guarantee the original insertion order.
 * Two identical settings would then compare unequal and the pane would refuse to
 * close over a difference that does not exist.
 */
function sameSettings(a: HueSettings, b: HueSettings): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const left = a[key as keyof HueSettings]
    const right = b[key as keyof HueSettings]
    if (left === right) continue
    // Object-valued settings (window bounds, hotkeys) are small and flat enough
    // that a stringify comparison is honest here — and unlike the top level,
    // they are stored, not rebuilt, so their key order is stable.
    if (JSON.stringify(left) !== JSON.stringify(right)) return false
  }
  return true
}
