/**
 * Hotkey triggers, in both directions: a DOM event to an Electron accelerator
 * string, and an accelerator string back to something a person can read.
 *
 * Pure functions over strings and numbers, so they are testable without a
 * window — see `accelerators.test.ts`. They handle the two shapes a trigger can
 * take, keyboard ("CommandOrControl+Shift+Enter") and mouse ("Mouse:Back"),
 * which is the detail that makes them worth testing rather than eyeballing.
 */

// Friendly labels for the mouse buttons we can bind.
export const MOUSE_LABELS: Record<string, string> = {
  Back: 'Mouse Back (X1)',
  Forward: 'Mouse Forward (X2)',
  Middle: 'Middle Click',
  Right: 'Right Click'
}

// Render a trigger string in a human-friendly way. Keyboard accelerators like
// "CommandOrControl+Shift+Enter" -> "Ctrl + Shift + Enter"; mouse triggers like
// "Mouse:Back" -> "Mouse Back (X1)".
export function formatAccelerator(acc: string): string {
  if (!acc) return 'Not set'
  if (acc.startsWith('Mouse:')) {
    const name = acc.slice('Mouse:'.length)
    return MOUSE_LABELS[name] ?? `Mouse ${name}`
  }
  return acc
    .split('+')
    .map((p) => (p === 'CommandOrControl' ? 'Ctrl' : p === 'Return' ? 'Enter' : p))
    .join(' + ')
}

// Map a DOM MouseEvent.button to our internal trigger name. DOM numbering:
// 0=left, 1=middle, 2=right, 3=back (X1), 4=forward (X2). Left is the click that
// starts/confirms recording, so it isn't bindable.
export function domButtonName(button: number): string | null {
  switch (button) {
    case 1:
      return 'Middle'
    case 2:
      return 'Right'
    case 3:
      return 'Back'
    case 4:
      return 'Forward'
    default:
      return null
  }
}

// Named keys whose accelerator token differs from the DOM KeyboardEvent.key.
export const ACCEL_KEY_MAP: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Enter'
}

// Convert a keydown into an Electron accelerator, or null if it isn't usable yet
// (a lone modifier). A modifier is no longer required — single keys are allowed
// (e.g. F9), which globally captures that key from every app, so it's best kept
// to keys you don't otherwise type (function keys).
export function eventToAccelerator(e: React.KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return null
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  const k = e.key
  let key: string | null = null
  if (ACCEL_KEY_MAP[k]) key = ACCEL_KEY_MAP[k]
  else if (/^[a-z]$/i.test(k)) key = k.toUpperCase()
  else if (/^[0-9]$/.test(k)) key = k
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k
  else if (k.length === 1) key = k.toUpperCase()
  if (!key) return null

  return [...mods, key].join('+')
}
