import { globalShortcut, type BrowserWindow } from 'electron'
import { uIOhook } from 'uiohook-napi'
import { getSettings } from './settings'

const MOUSE_PREFIX = 'Mouse:'

let resolveWindow: () => BrowserWindow | null = () => null
let hookStarted = false

// Keyboard accelerators we've registered with Electron, so we can unregister
// exactly those (and not the ones other parts of the app might own).
const keyboardAccelerators = new Set<string>()
// Mouse-button triggers → action, matched against the global uIOhook stream.
// Keyed by our internal button name ("Back", "Forward", "Middle", …).
const mouseHandlers = new Map<string, () => void>()

function bringToFront(): BrowserWindow | null {
  const win = resolveWindow()
  if (!win) return null
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

/** Show and focus Hue. Used by the tray ("Show Hue" / icon click). */
export function summon(): void {
  bringToFront()
}

/**
 * Toggle Hue's visibility — bound to the summon trigger. Pressing it when Hue is
 * already up front hides it back to the tray; otherwise it brings Hue forward.
 * (Visible-but-not-focused still counts as "bring forward", so the trigger
 * surfaces Hue from behind another app rather than hiding it.)
 */
export function toggleVisibility(): void {
  const win = resolveWindow()
  if (win && win.isVisible() && win.isFocused()) {
    win.hide()
    return
  }
  bringToFront()
}

/** Show Hue and tell the renderer to start or stop the voice session. */
export function toggleSession(): void {
  const win = bringToFront()
  win?.webContents.send('hue:hotkey:toggle-session')
}

// Map a uIOhook mouse button number to our internal name. On Windows libuiohook
// reports: 1=left, 2=right, 3=middle, 4=X1 (Back), 5=X2 (Forward).
function uiohookButtonName(button: number): string {
  switch (button) {
    case 1:
      return 'Left'
    case 2:
      return 'Right'
    case 3:
      return 'Middle'
    case 4:
      return 'Back'
    case 5:
      return 'Forward'
    default:
      return `Button${button}`
  }
}

// Start the global input hook once. It runs a background thread that observes
// all mouse input system-wide so mouse-button triggers fire even when another
// app is focused (Electron's globalShortcut can't see mouse buttons). We never
// consume the event, so the button still does its normal thing in the focused
// app — we just additionally fire Hue's handler.
function startHook(): void {
  if (hookStarted) return
  uIOhook.on('mousedown', (e) => {
    // The typings declare `button` as unknown, but libuiohook reports a number.
    const handler = mouseHandlers.get(uiohookButtonName(Number(e.button)))
    if (handler) handler()
  })
  uIOhook.start()
  hookStarted = true
}

// Register one trigger string (keyboard accelerator or "Mouse:<Button>") to an
// action. Keyboard goes through Electron's globalShortcut (layout-aware, handles
// single keys); mouse goes through the uIOhook matcher above.
function registerTrigger(trigger: string, action: () => void): void {
  if (!trigger) return
  if (trigger.startsWith(MOUSE_PREFIX)) {
    mouseHandlers.set(trigger.slice(MOUSE_PREFIX.length), action)
    return
  }
  try {
    if (globalShortcut.register(trigger, action)) keyboardAccelerators.add(trigger)
    else console.warn(`Could not register hotkey "${trigger}" (already in use?)`)
  } catch (e) {
    console.warn(`Invalid hotkey "${trigger}":`, e)
  }
}

/** (Re)bind both global triggers from the current settings. Safe to call again. */
export function applyHotkeys(): void {
  for (const acc of keyboardAccelerators) globalShortcut.unregister(acc)
  keyboardAccelerators.clear()
  mouseHandlers.clear()

  const s = getSettings()
  registerTrigger(s.summonHotkey, toggleVisibility)
  registerTrigger(s.startSessionHotkey, toggleSession)
}

/** Start the input hook and bind the saved summon + start-session triggers. */
export function initHotkeys(windowGetter: () => BrowserWindow | null): void {
  resolveWindow = windowGetter
  startHook()
  applyHotkeys()
}

export function unregisterAllHotkeys(): void {
  globalShortcut.unregisterAll()
  keyboardAccelerators.clear()
  mouseHandlers.clear()
  if (hookStarted) {
    uIOhook.stop()
    hookStarted = false
  }
}
