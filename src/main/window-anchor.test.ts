import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeAnchoredBounds,
  clampIntoWorkArea,
  clampIntoWorkAreas,
  GRID_ANCHORS,
  type Rect
} from './window-anchor.ts'

/** Hue's window size, so the numbers below are the ones the real app produces. */
const SIZE = { width: 900, height: 670 }

/**
 * A 1920x1080 primary display with a 40px taskbar along the bottom. This is the
 * common Windows case and the one every bottom-anchor assertion below is really
 * about: `bounds` would be 1080 tall, `workArea` is 1040.
 */
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

test('top-left insets the window from both work-area edges by the margin, so it never sits flush', () => {
  const b = computeAnchoredBounds('top-left', SIZE, PRIMARY, 16)
  assert.deepEqual(b, { x: 16, y: 16, width: 900, height: 670 })
})

test('top-center centres horizontally while staying pinned to the top edge', () => {
  const b = computeAnchoredBounds('top-center', SIZE, PRIMARY, 16)
  assert.deepEqual(b, { x: (1920 - 900) / 2, y: 16, width: 900, height: 670 })
})

test('top-right measures the margin from the right edge, not from the left', () => {
  // The classic off-by-a-window bug: `workArea.width - margin` rather than
  // `workArea.width - width - margin` hangs all but 16px of the card off-screen.
  const b = computeAnchoredBounds('top-right', SIZE, PRIMARY, 16)
  assert.deepEqual(b, { x: 1920 - 900 - 16, y: 16, width: 900, height: 670 })
})

test('center-left and center-right share the same vertical centre, so switching sides is a horizontal move only', () => {
  const left = computeAnchoredBounds('center-left', SIZE, PRIMARY, 16)
  const right = computeAnchoredBounds('center-right', SIZE, PRIMARY, 16)
  assert.equal(left.x, 16)
  assert.equal(right.x, 1920 - 900 - 16)
  assert.equal(left.y, right.y)
  assert.equal(left.y, Math.round((1040 - 670) / 2))
})

test('center ignores the margin entirely, because a centred window has no edge to inset from', () => {
  const tight = computeAnchoredBounds('center', SIZE, PRIMARY, 0)
  const loose = computeAnchoredBounds('center', SIZE, PRIMARY, 64)
  assert.deepEqual(tight, loose)
  assert.deepEqual(tight, {
    x: (1920 - 900) / 2,
    y: Math.round((1040 - 670) / 2),
    width: 900,
    height: 670
  })
})

test('bottom-* anchors sit above the taskbar, because they are measured against workArea and not bounds', () => {
  // The whole point of the feature: against the display's 1080px `bounds` the
  // bottom edge would land at y = 1080 - 670 - 16 = 394, putting 40px of the
  // card behind the taskbar where it cannot be clicked.
  const expectedY = 1040 - 670 - 16
  assert.equal(computeAnchoredBounds('bottom-left', SIZE, PRIMARY, 16).y, expectedY)
  assert.equal(computeAnchoredBounds('bottom-center', SIZE, PRIMARY, 16).y, expectedY)
  assert.equal(computeAnchoredBounds('bottom-right', SIZE, PRIMARY, 16).y, expectedY)
  assert.notEqual(expectedY, 1080 - 670 - 16)
})

test('bottom-right — the anchor a user picks mid-call — lands in the free corner of a taskbar display', () => {
  const b = computeAnchoredBounds('bottom-right', SIZE, PRIMARY, 16)
  assert.deepEqual(b, { x: 1920 - 900 - 16, y: 1040 - 670 - 16, width: 900, height: 670 })
})

test('every one of the nine anchors produces a rectangle wholly inside the work area', () => {
  for (const anchor of GRID_ANCHORS) {
    const b = computeAnchoredBounds(anchor, SIZE, PRIMARY, 16)
    assert.ok(b.x >= PRIMARY.x, `${anchor} x`)
    assert.ok(b.y >= PRIMARY.y, `${anchor} y`)
    assert.ok(b.x + b.width <= PRIMARY.x + PRIMARY.width, `${anchor} right edge`)
    assert.ok(b.y + b.height <= PRIMARY.y + PRIMARY.height, `${anchor} bottom edge`)
  }
})

test('the nine anchors are nine distinct positions, or the picker would have dead cells', () => {
  const seen = new Set(
    GRID_ANCHORS.map((a) => {
      const b = computeAnchoredBounds(a, SIZE, PRIMARY, 16)
      return `${b.x},${b.y}`
    })
  )
  assert.equal(seen.size, 9)
})

test("a work area offset by a left/top taskbar is honoured, not assumed to start at the screen's origin", () => {
  // A left-docked Windows taskbar (or the macOS menu bar) shifts workArea.x/y.
  // Code that only reads width/height would park the card under the taskbar.
  const shifted: Rect = { x: 80, y: 30, width: 1840, height: 1050 }
  assert.deepEqual(computeAnchoredBounds('top-left', SIZE, shifted, 16), {
    x: 96,
    y: 46,
    width: 900,
    height: 670
  })
  assert.deepEqual(computeAnchoredBounds('bottom-right', SIZE, shifted, 16), {
    x: 80 + 1840 - 900 - 16,
    y: 30 + 1050 - 670 - 16,
    width: 900,
    height: 670
  })
})

test('a monitor to the left of the primary anchors within its own negative coordinate space', () => {
  // Windows gives a display placed left of the primary a negative origin. An
  // implementation that clamps x to >= 0 would yank the window to the primary.
  const secondary: Rect = { x: -1920, y: -120, width: 1920, height: 1080 }
  assert.deepEqual(computeAnchoredBounds('top-left', SIZE, secondary, 16), {
    x: -1904,
    y: -104,
    width: 900,
    height: 670
  })
  const bottomRight = computeAnchoredBounds('bottom-right', SIZE, secondary, 16)
  assert.deepEqual(bottomRight, {
    x: -1920 + 1920 - 900 - 16,
    y: -120 + 1080 - 670 - 16,
    width: 900,
    height: 670
  })
  assert.ok(bottomRight.x < 0)
})

test('a window wider and taller than the work area is pinned to its origin rather than given negative coordinates', () => {
  // A 1024x600 netbook panel cannot fit a 900x670 card vertically. Negative
  // coordinates here would push the draggable header off the top of the screen,
  // leaving the user no way to move the window back.
  const small: Rect = { x: 0, y: 0, width: 800, height: 560 }
  const b = computeAnchoredBounds('bottom-right', SIZE, small, 16)
  assert.deepEqual(b, { x: 0, y: 0, width: 900, height: 670 })
})

test('an oversized window is pinned to a shifted work area, not to the screen origin', () => {
  const small: Rect = { x: -1000, y: 40, width: 800, height: 560 }
  assert.deepEqual(computeAnchoredBounds('center', SIZE, small, 16), {
    x: -1000,
    y: 40,
    width: 900,
    height: 670
  })
})

test('a margin wider than the leftover space cannot push the window off the opposite edge', () => {
  // A hand-edited settings file with a 900px margin must degrade to "as far into
  // the corner as fits", not to a window parked outside the display.
  const b = computeAnchoredBounds('top-right', SIZE, PRIMARY, 900)
  assert.ok(b.x >= PRIMARY.x)
  assert.ok(b.x + b.width <= PRIMARY.x + PRIMARY.width)
})

test('a negative margin is treated as zero rather than as permission to overhang the edge', () => {
  const b = computeAnchoredBounds('top-left', SIZE, PRIMARY, -40)
  assert.deepEqual(b, { x: 0, y: 0, width: 900, height: 670 })
})

test('a free position saved on a monitor that has since been unplugged is clamped back into view', () => {
  // The undock case: the window was left on a second display at x = 2200, that
  // display is gone, and restoring the rectangle verbatim would put Hue
  // somewhere no monitor covers — invisible, and unreachable by mouse.
  const saved: Rect = { x: 2200, y: 300, width: 900, height: 670 }
  const restored = clampIntoWorkAreas(saved, [PRIMARY])
  assert.deepEqual(restored, { x: 1920 - 900, y: 300, width: 900, height: 670 })
})

test('a free position fully on a still-connected display is returned untouched, to the pixel', () => {
  // This runs on every display event, so any drift here would walk the window
  // across the screen each time a monitor sleeps and wakes.
  const saved: Rect = { x: 412, y: 88, width: 900, height: 670 }
  assert.deepEqual(clampIntoWorkAreas(saved, [PRIMARY]), saved)
})

test('a free position on a secondary display is kept there rather than dragged onto the primary', () => {
  const secondary: Rect = { x: 1920, y: 0, width: 2560, height: 1400 }
  const saved: Rect = { x: 2400, y: 500, width: 900, height: 670 }
  assert.deepEqual(clampIntoWorkAreas(saved, [PRIMARY, secondary]), saved)
})

test('a position hanging off the edge of a display is clamped into the display it mostly occupies', () => {
  const secondary: Rect = { x: 1920, y: 0, width: 2560, height: 1400 }
  // Mostly on the secondary, spilling past its right edge.
  const saved: Rect = { x: 3900, y: 1200, width: 900, height: 670 }
  assert.deepEqual(clampIntoWorkAreas(saved, [PRIMARY, secondary]), {
    x: 1920 + 2560 - 900,
    y: 1400 - 670,
    width: 900,
    height: 670
  })
})

test('a position overlapping no display at all falls back to the first work area, which the caller passes as the primary', () => {
  const secondary: Rect = { x: 1920, y: 0, width: 2560, height: 1400 }
  const saved: Rect = { x: -9000, y: -9000, width: 900, height: 670 }
  assert.deepEqual(clampIntoWorkAreas(saved, [PRIMARY, secondary]), {
    x: 0,
    y: 0,
    width: 900,
    height: 670
  })
})

test('an empty display list returns the bounds unchanged, since there is nowhere better to put them', () => {
  // screen.getAllDisplays() should never be empty, but a headless/racing session
  // must not turn into a crash or a window teleported to 0,0.
  const saved: Rect = { x: 400, y: 200, width: 900, height: 670 }
  assert.deepEqual(clampIntoWorkAreas(saved, []), saved)
})

test('clamping preserves the window size, because docking must never resize the card', () => {
  const clamped = clampIntoWorkArea({ x: 5000, y: 5000, width: 900, height: 670 }, PRIMARY)
  assert.equal(clamped.width, 900)
  assert.equal(clamped.height, 670)
})
