import { BrowserWindow, screen } from 'electron'
import { getSettings } from './settings'
import {
  DEFAULT_ANCHOR_MARGIN,
  MAX_ANCHOR_MARGIN,
  clampIntoWorkAreas,
  computeAnchoredBounds,
  type Rect
} from './window-anchor'

/**
 * The Electron half of window docking: read the displays, hand plain rectangles
 * to `./window-anchor`, push the answer back onto the window.
 *
 * All the geometry lives next door precisely because none of it can be tested
 * from here — `screen` only exists inside a running Electron process. What is
 * left in this file is the part that has to talk to the OS: which display the
 * window is on, when the desktop's shape changed, and noticing that the user
 * has taken over placement by dragging.
 */

let displayWatchAttached = false

/** Clamp a possibly hand-edited margin into a range that still means "inset". */
function safeMargin(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ANCHOR_MARGIN
  return Math.min(Math.max(Math.round(value), 0), MAX_ANCHOR_MARGIN)
}

/** Work areas of every display, primary first — the fallback order the clamp uses. */
function workAreas(): Rect[] {
  const primary = screen.getPrimaryDisplay()
  const rest = screen.getAllDisplays().filter((d) => d.id !== primary.id)
  return [primary, ...rest].map((d) => d.workArea)
}

function setBoundsIfChanged(win: BrowserWindow, next: Rect): void {
  const now = win.getBounds()
  if (
    now.x === next.x &&
    now.y === next.y &&
    now.width === next.width &&
    now.height === next.height
  )
    return
  win.setBounds(next)
}

/**
 * Put `win` where the settings say it belongs.
 *
 * For the nine grid anchors this is the work area of the display the window is
 * **currently on** — found from the window's own centre point, not from
 * `getPrimaryDisplay()`, so dragging Hue to a second monitor and then picking
 * "bottom right" docks it in that monitor's corner rather than teleporting it
 * home.
 *
 * For `'free'` it restores `windowFreeBounds` if one is saved, validated against
 * the displays that exist right now. Nothing writes that field automatically at
 * present — see the defect note on {@link trackWindowPlacement} — so in practice
 * `'free'` means "leave the window where the OS put it" unless the value was set
 * by hand.
 *
 * Safe to call before the window is shown (which is where it belongs — the
 * window must not visibly jump), on a destroyed window, and repeatedly.
 */
export function applyWindowAnchor(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return

  const settings = getSettings()
  const current = win.getBounds()
  const areas = workAreas()
  if (areas.length === 0) return

  if (settings.windowAnchor === 'free') {
    const saved = settings.windowFreeBounds
    if (!saved) return
    // Every field is checked, not just the sizes. A saved bounds missing x/y (or
    // holding a string) made `target.x` undefined, which the clamp cannot
    // rescue: its comparisons all read false, the overlap arithmetic yields NaN,
    // and `setBounds({ x: NaN })` throws inside createWindow — no window, at
    // startup. Falling back to the window's current position is always safe.
    const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
    const target: Rect = {
      x: usable(saved.x) ? saved.x : current.x,
      y: usable(saved.y) ? saved.y : current.y,
      // A saved size of 0 would be a corrupted file; keep what the window has.
      width: usable(saved.width) && saved.width > 0 ? saved.width : current.width,
      height: usable(saved.height) && saved.height > 0 ? saved.height : current.height
    }
    setBoundsIfChanged(win, clampIntoWorkAreas(target, areas))
    return
  }

  const centre = {
    x: Math.round(current.x + current.width / 2),
    y: Math.round(current.y + current.height / 2)
  }
  const display = screen.getDisplayNearestPoint(centre)
  setBoundsIfChanged(
    win,
    computeAnchoredBounds(
      settings.windowAnchor,
      { width: current.width, height: current.height },
      display.workArea,
      safeMargin(settings.windowAnchorMargin)
    )
  )
}

/**
 * Keep an anchored window on its anchor as it is resized.
 *
 * The intent was broader — watch `win` for user drags and record them, so a
 * dragged window releases its anchor and its position is remembered. The header
 * drag is `-webkit-app-region: drag`, handled by the OS, so `moved` is the only
 * signal available. That half is currently disabled; the note in the body says
 * why and what would have to be established to turn it back on.
 */
export function trackWindowPlacement(win: BrowserWindow): void {
  // KNOWN DEFECT — writing placement back is disabled until it is root-caused.
  //
  // This used to watch `moved`, so that dragging an anchored window released the
  // anchor and remembered the new position. That is still the behaviour the
  // feature wants. It is off because `moved` is not reliably a user drag for
  // this window.
  //
  // Measured on Windows with an instrumented build: the window is placed at
  // (200,200), verified still there 1.5 s later, and is then moved by something
  // outside this app — to (1258,0) on one run and (-612,4) on another, roughly
  // 3 s into launch. Something about a transparent, frameless, alwaysOnTop,
  // skipTaskbar window that also calls setVisibleOnAllWorkspaces perturbs its
  // position after `show()`; which of those is responsible is not established.
  //
  // Trusting those events corrupted the saved rectangle, and because the restore
  // path clamps while the save path did not, the bad value survived across
  // launches and drifted further each time. Rejecting illegal rectangles is not
  // sufficient either: the observed perturbations are frequently fully
  // on-screen, so no legality test separates them from a real drag.
  //
  // So nothing is written back for now. The nine anchors are unaffected and land
  // exactly; what is missing is "remember where I dragged it" — a smaller loss
  // than silently overwriting a saved position the user never chose.
  //
  // A resize still re-docks an anchored window: growing a bottom-right card
  // should keep its corner. Free windows are left exactly where they are.
  win.on('resized', () => {
    if (getSettings().windowAnchor !== 'free') applyWindowAnchor(win)
  })
}

/**
 * Re-apply the anchor whenever the desktop's shape changes.
 *
 * This is the part that earns the feature its keep. A resolution change, a
 * docking station unplugged, a projector disconnected mid-call: all of them can
 * leave the window in coordinates no display covers any more, where it is
 * invisible and unreachable. `display-removed` in particular is exactly the
 * "walked away from my desk with the laptop" case.
 *
 * Idempotent — the listeners are attached once even if this is called again
 * after the window is recreated (macOS `activate`), since they resolve the
 * window through the callback rather than capturing it.
 */
export function watchDisplayChanges(getWindow: () => BrowserWindow | null): void {
  if (displayWatchAttached) return
  displayWatchAttached = true

  const reapply = (): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    // The metrics event can arrive before the OS has finished rearranging the
    // desktop; a tick later, screen.getAllDisplays() reports the new layout.
    setTimeout(() => applyWindowAnchor(getWindow()), 100)
  }

  screen.on('display-metrics-changed', reapply)
  screen.on('display-added', reapply)
  screen.on('display-removed', reapply)
}
