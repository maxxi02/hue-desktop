import type { BrowserWindow } from 'electron'

/**
 * Stealth mode: keep Hue's card off screen captures and screen shares.
 *
 * The whole feature is one Chromium window flag. `BrowserWindow.setContentProtection`
 * lowers to the platform's "do not capture this window" primitive:
 *
 *   - Windows 10 2004+ : SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) — the
 *     compositor keeps painting the window to the physical display but omits it
 *     from every capture path, so the sharer sees the desktop behind it.
 *   - Windows 8–10 1909: WDA_MONITOR, the older affinity. The window is excluded,
 *     but it comes out as a black rectangle rather than as nothing, which is more
 *     conspicuous than leaving it off.
 *   - macOS            : NSWindowSharingNone.
 *   - Linux            : no equivalent; the call is accepted and does nothing.
 *
 * What it is not: it does not hide the process, the tray icon, the window title
 * in the task list, or the audio devices Hue holds open, and it obviously cannot
 * do anything about a phone camera pointed at the monitor. Treating it as more
 * than "this window is not in the capture buffer" will mislead the user.
 */

/** Platforms where `setContentProtection` actually suppresses capture. */
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>([
  'win32',
  'darwin'
])

/**
 * Whether stealth mode can do anything on this platform.
 *
 * Kept separate from applying it so the UI can tell the user the switch will not
 * help here, rather than showing an enabled toggle that silently does nothing.
 */
export function isStealthSupported(platform: NodeJS.Platform = process.platform): boolean {
  return SUPPORTED_PLATFORMS.has(platform)
}

/**
 * Apply `enabled` to `win`.
 *
 * Returns whether protection is actually in force, which is `false` whenever the
 * platform has no primitive for it — the caller can surface that instead of
 * reporting a protection the OS is not providing. Calling this on a destroyed
 * window is a no-op rather than a throw, since settings changes and window
 * teardown race during quit.
 */
export function applyStealth(
  win: BrowserWindow | null,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!win || win.isDestroyed()) return false

  const effective = enabled && isStealthSupported(platform)
  // Always push the flag, including when it is being turned off, so toggling
  // stealth off genuinely restores capture instead of leaving the affinity set.
  win.setContentProtection(effective)
  return effective
}
