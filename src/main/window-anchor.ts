/**
 * Window docking geometry.
 *
 * Hue is a frameless overlay that lives on top of a video call, so *where* it
 * sits is part of the product: parked bottom-right it stays out of the way of
 * the interviewer's face, and it must be in the same place every launch rather
 * than wherever Chromium happens to centre it.
 *
 * Everything here is arithmetic on plain rectangles — no `electron` import, and
 * deliberately so. The mistakes this feature can make are all geometric (a
 * bottom anchor computed against a display's full `bounds` slides under the
 * Windows taskbar; a secondary monitor to the left of the primary has a
 * *negative* `x`, and code that assumes screen space starts at 0 puts the window
 * on the wrong display; a saved position on a monitor that has since been
 * unplugged is off-screen with no way back). Keeping the arithmetic callable
 * from a plain `node --test` process is what lets those cases be pinned down.
 *
 * The caller's job is to pass the right rectangles in: the display's
 * **`workArea`** (the screen minus taskbar/dock/menu bar), from the display the
 * window is currently on — not the primary one.
 */

import type { WindowAnchor } from '../shared/types.ts'

/** A screen-space rectangle: an Electron `Rectangle`, structurally. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The size half of a rectangle, for callers that only know how big the window is. */
export interface Size {
  width: number
  height: number
}

/**
 * The nine docking positions, i.e. every anchor except `'free'`.
 *
 * Split out from {@link WindowAnchor} so `computeAnchoredBounds` cannot be
 * handed `'free'`: "free" is the *absence* of a computed position — the answer
 * for it is the user's saved rectangle, which is {@link clampIntoWorkAreas}'
 * job, not this function's.
 */
export type GridAnchor = Exclude<WindowAnchor, 'free'>

/** Every anchor, in reading order — the order the 3x3 picker renders them in. */
export const GRID_ANCHORS: readonly GridAnchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
] as const

/** Default inset from the work-area edge: enough to read as deliberate, not flush. */
export const DEFAULT_ANCHOR_MARGIN = 16

/** Widest inset the UI offers. Beyond this an anchor stops meaning "in the corner". */
export const MAX_ANCHOR_MARGIN = 200

type Axis = 'start' | 'center' | 'end'

/** Which edge (or centre) each anchor pins to, per axis. */
const AXES: Record<GridAnchor, { h: Axis; v: Axis }> = {
  'top-left': { h: 'start', v: 'start' },
  'top-center': { h: 'center', v: 'start' },
  'top-right': { h: 'end', v: 'start' },
  'center-left': { h: 'start', v: 'center' },
  center: { h: 'center', v: 'center' },
  'center-right': { h: 'end', v: 'center' },
  'bottom-left': { h: 'start', v: 'end' },
  'bottom-center': { h: 'center', v: 'end' },
  'bottom-right': { h: 'end', v: 'end' }
}

/**
 * Place `extent` along one axis of a track that starts at `origin` and runs for
 * `available`. Integer pixels throughout: Windows rounds fractional window
 * coordinates itself, and rounding here keeps what we compute equal to what we
 * later read back out of the window.
 */
function place(
  axis: Axis,
  origin: number,
  available: number,
  extent: number,
  margin: number
): number {
  if (axis === 'start') return origin + margin
  if (axis === 'end') return origin + available - extent - margin
  return origin + Math.round((available - extent) / 2)
}

/** Pin `value` to `[min, max]`. Returns `min` when the range is inverted. */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * Where a window of `size` sits when docked to `anchor` inside `workArea`.
 *
 * `workArea` must be the display's work area, not its bounds: on Windows the
 * two differ by the taskbar, and anchoring `bottom-*` to `bounds` parks the card
 * underneath it. Its `x`/`y` are honoured rather than assumed zero — that is
 * both the taskbar-on-the-left case and every secondary monitor, whose origin
 * can be negative.
 *
 * The result is clamped into `workArea`, so a window larger than the work area
 * (a small laptop panel, or a display scaled up after the fact) lands at the
 * work area's origin instead of at a negative coordinate that would push its
 * header — the only draggable part — off the top of the screen.
 */
export function computeAnchoredBounds(
  anchor: GridAnchor,
  size: Size,
  workArea: Rect,
  margin: number = DEFAULT_ANCHOR_MARGIN
): Rect {
  const { h, v } = AXES[anchor]
  // A margin larger than the slack would push the window past the opposite edge,
  // so it can never exceed half the leftover space. Negative margins are a
  // corrupted settings file, not a request to overhang the edge.
  const safeMargin = Math.max(0, Math.round(margin))
  const marginX = Math.min(safeMargin, Math.max(0, Math.floor((workArea.width - size.width) / 2)))
  const marginY = Math.min(safeMargin, Math.max(0, Math.floor((workArea.height - size.height) / 2)))

  const x = place(h, workArea.x, workArea.width, size.width, marginX)
  const y = place(v, workArea.y, workArea.height, size.height, marginY)

  return clampIntoWorkArea({ x, y, width: size.width, height: size.height }, workArea)
}

/**
 * Nudge `bounds` until it lies inside `workArea`, keeping its size.
 *
 * When the window is bigger than the work area it is pinned to the work area's
 * top-left rather than centred on it: the top edge carries the drag handle and
 * the close control, so of the two edges that must be reachable, that is the one
 * to keep.
 */
export function clampIntoWorkArea(bounds: Rect, workArea: Rect): Rect {
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - bounds.width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - bounds.height),
    width: bounds.width,
    height: bounds.height
  }
}

/** Area of the overlap between two rectangles; 0 when they do not intersect. */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Make a remembered free position usable again on the displays that exist *now*.
 *
 * This is the recovery path for the arrangement having changed since the
 * position was saved: the second monitor was unplugged, the laptop was
 * undocked, the resolution dropped. Restoring such a rectangle blindly strands
 * the window in coordinates no display covers, where it is unreachable by
 * anything short of editing the settings file.
 *
 * A rectangle already wholly on one display is returned untouched — down to the
 * pixel, because this runs on every display event and a window that drifts each
 * time a monitor wakes would be worse than the bug it fixes. Otherwise it is
 * clamped into the display it overlaps most, falling back to the first work area
 * (the caller passes the primary display first) when it overlaps none.
 */
export function clampIntoWorkAreas(bounds: Rect, workAreas: readonly Rect[]): Rect {
  if (workAreas.length === 0) return bounds

  for (const area of workAreas) {
    const fits =
      bounds.x >= area.x &&
      bounds.y >= area.y &&
      bounds.x + bounds.width <= area.x + area.width &&
      bounds.y + bounds.height <= area.y + area.height
    if (fits) return bounds
  }

  let best = workAreas[0]
  let bestOverlap = 0
  for (const area of workAreas) {
    const area_ = overlapArea(bounds, area)
    if (area_ > bestOverlap) {
      bestOverlap = area_
      best = area
    }
  }
  return clampIntoWorkArea(bounds, best)
}
