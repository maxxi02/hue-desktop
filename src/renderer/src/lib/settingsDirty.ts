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
/**
 * The two kinds of unsaved work, reported separately.
 *
 * They are separate because **only one of them can be saved by Save.** Settings
 * are written by `hue:settings:set`; a gap answer is not a setting at all, it is
 * a model call that turns spoken words into a story. Collapsing both into one
 * boolean produced a guard that could never be satisfied: a typed gap draft kept
 * it armed, pressing Save did nothing about it, and the dialog reappeared on
 * every close attempt.
 *
 * It also hid a real loss. The dialog's "Save and close" ran the settings save
 * and then closed, destroying the typed answer, while the copy above it said
 * that button saved unsaved work.
 *
 * Counting the gap draft is still right — a story someone just composed from
 * memory is the most expensive thing in this pane to lose. What was wrong was
 * being unable to say which kind of work was outstanding, so the dialog could
 * not offer an action that covered it.
 */
export interface UnsavedWork {
  /** Edits to the settings form. Save writes these. */
  settings: boolean
  /** A gap answer typed but not sent. Save does NOT write this. */
  gapAnswer: boolean
  /** Either kind. What the close guard keys on. */
  any: boolean
}

export function describeUnsaved(
  current: HueSettings,
  pristine: HueSettings,
  gapDrafts: Record<string, string>
): UnsavedWork {
  const gapAnswer = Object.values(gapDrafts).some((draft) => draft.trim().length > 0)
  const settings = !sameSettings(current, pristine)
  return { settings, gapAnswer, any: settings || gapAnswer }
}

export function isSettingsDirty(
  current: HueSettings,
  pristine: HueSettings,
  gapDrafts: Record<string, string>
): boolean {
  return describeUnsaved(current, pristine, gapDrafts).any
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
