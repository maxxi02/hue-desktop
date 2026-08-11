import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { isStealthSupported, applyStealth } from './stealth.ts'

/**
 * A stand-in for the two BrowserWindow members stealth touches. Hand-rolled
 * rather than mocked: importing `electron` outside a real Electron process
 * fails, and the repo carries no mocking library.
 */
function fakeWindow(destroyed = false): {
  win: BrowserWindow
  calls: boolean[]
} {
  const calls: boolean[] = []
  const win = {
    isDestroyed: () => destroyed,
    setContentProtection: (enabled: boolean) => {
      calls.push(enabled)
    }
  }
  return { win: win as unknown as BrowserWindow, calls }
}

test('Windows and macOS are reported as supported, or the feature is hidden where it works', () => {
  assert.equal(isStealthSupported('win32'), true)
  assert.equal(isStealthSupported('darwin'), true)
})

test('Linux is reported unsupported, so the UI never promises a protection X11/Wayland cannot give', () => {
  assert.equal(isStealthSupported('linux'), false)
})

test('enabling on Linux reports false, so the user is not told they are hidden when they are not', () => {
  const { win, calls } = fakeWindow()
  assert.equal(applyStealth(win, true, 'linux'), false)
  // The flag is still pushed — Chromium accepts and ignores it — but the return
  // value is what the badge and status IPC trust.
  assert.deepEqual(calls, [false])
})

test('enabling on a supported platform reports true and pushes the flag through', () => {
  const { win, calls } = fakeWindow()
  assert.equal(applyStealth(win, true, 'win32'), true)
  assert.deepEqual(calls, [true])
})

test('disabling actually calls setContentProtection(false), or the window stays excluded from capture forever', () => {
  // Skipping the call when disabling would leave the OS display affinity set,
  // so a user who turns stealth off would still be invisible in their share.
  const { win, calls } = fakeWindow()
  assert.equal(applyStealth(win, false, 'win32'), false)
  assert.deepEqual(calls, [false])
})

test('a null window is a no-op, because settings can be applied before the window exists', () => {
  assert.equal(applyStealth(null, true, 'win32'), false)
})

test('a destroyed window is a no-op rather than a throw, since settings changes race window teardown on quit', () => {
  const { win, calls } = fakeWindow(true)
  assert.equal(applyStealth(win, true, 'win32'), false)
  assert.deepEqual(calls, [])
})
