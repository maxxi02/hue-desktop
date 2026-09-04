import test from 'node:test'
import assert from 'node:assert/strict'
import { domButtonName, eventToAccelerator, formatAccelerator } from './accelerators.ts'

/**
 * A hotkey is global: whatever it binds is captured from every other app on the
 * machine, including the video call Hue is sitting over. So the two directions
 * have to agree, and the round trip below is the property that matters. A
 * recorder that displays "Ctrl + Shift + Enter" while binding something else
 * leaves the user pressing a key that does nothing, mid-interview, with no way
 * to tell which half is wrong.
 *
 * These functions were untestable until they moved out of `Settings.tsx`: not
 * because they were complex, but because they sat in a 3,000-line component
 * file that no test could import without pulling React in with it.
 */

/** The fields `eventToAccelerator` actually reads, without a DOM. */
function keydown(
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}
): React.KeyboardEvent {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false
  } as React.KeyboardEvent
}

test('a lone modifier is not a binding yet', () => {
  // Held while the user reaches for the real key. Returning a value here would
  // bind Ctrl on its own and swallow every shortcut on the machine.
  for (const k of ['Control', 'Meta', 'Alt', 'Shift']) {
    assert.equal(eventToAccelerator(keydown(k, { ctrl: true })), null, `${k} bound on its own`)
  }
})

test('ctrl and cmd both record as CommandOrControl, so a binding is portable', () => {
  assert.equal(eventToAccelerator(keydown('k', { ctrl: true })), 'CommandOrControl+K')
  assert.equal(eventToAccelerator(keydown('k', { meta: true })), 'CommandOrControl+K')
})

test('modifiers are recorded in a fixed order regardless of which was pressed first', () => {
  // Electron matches the string, so "Alt+CommandOrControl+K" and
  // "CommandOrControl+Alt+K" are different bindings for the same chord.
  const chord = { ctrl: true, alt: true, shift: true }
  assert.equal(eventToAccelerator(keydown('k', chord)), 'CommandOrControl+Alt+Shift+K')
})

test('named keys map to the tokens Electron expects, not the DOM ones', () => {
  assert.equal(eventToAccelerator(keydown(' ')), 'Space')
  assert.equal(eventToAccelerator(keydown('ArrowUp')), 'Up')
  assert.equal(eventToAccelerator(keydown('Escape')), 'Esc')
  assert.equal(eventToAccelerator(keydown('Enter')), 'Enter')
})

test('function keys survive unchanged, up to F24 and no further', () => {
  // The keys worth binding without a modifier, since they are the ones nobody
  // types by accident.
  assert.equal(eventToAccelerator(keydown('F9')), 'F9')
  assert.equal(eventToAccelerator(keydown('F24')), 'F24')
  // F25 is not a key Electron knows; it falls through to the single-character
  // branch, which cannot match a three-character string.
  assert.equal(eventToAccelerator(keydown('F25')), null)
})

test('letters are upper-cased and digits are left alone', () => {
  assert.equal(eventToAccelerator(keydown('a')), 'A')
  assert.equal(eventToAccelerator(keydown('7')), '7')
})

test('an unusable key records nothing rather than a broken accelerator', () => {
  assert.equal(eventToAccelerator(keydown('Dead')), null)
  assert.equal(eventToAccelerator(keydown('Unidentified')), null)
})

// --- Reading it back --------------------------------------------------------

test('what is recorded is what is displayed', () => {
  // The round trip. If these drift, the label lies about the binding.
  const cases: Array<[string, string]> = [
    ['CommandOrControl+K', 'Ctrl + K'],
    ['CommandOrControl+Shift+Enter', 'Ctrl + Shift + Enter'],
    ['F9', 'F9']
  ]
  for (const [acc, label] of cases) assert.equal(formatAccelerator(acc), label)
})

test('Return is shown as Enter, the key people actually call it', () => {
  assert.equal(formatAccelerator('CommandOrControl+Return'), 'Ctrl + Enter')
})

test('an unset trigger says so instead of rendering an empty label', () => {
  assert.equal(formatAccelerator(''), 'Not set')
})

test('mouse triggers are named, and an unknown one degrades to something readable', () => {
  assert.equal(formatAccelerator('Mouse:Back'), 'Mouse Back (X1)')
  assert.equal(formatAccelerator('Mouse:Forward'), 'Mouse Forward (X2)')
  assert.equal(formatAccelerator('Mouse:Middle'), 'Middle Click')
  // Not in the table: still a sentence, not a blank.
  assert.equal(formatAccelerator('Mouse:Nonesuch'), 'Mouse Nonesuch')
})

test('left click is not bindable, because it is the click that confirms recording', () => {
  assert.equal(domButtonName(0), null)
})

test('the DOM button numbers map to the buttons we bind', () => {
  assert.equal(domButtonName(1), 'Middle')
  assert.equal(domButtonName(2), 'Right')
  assert.equal(domButtonName(3), 'Back')
  assert.equal(domButtonName(4), 'Forward')
  assert.equal(domButtonName(9), null)
})

test('every bindable mouse button has a label, so none renders as a bare name', () => {
  for (const button of [1, 2, 3, 4]) {
    const name = domButtonName(button)
    assert.ok(name)
    const label = formatAccelerator(`Mouse:${name}`)
    assert.notEqual(label, `Mouse ${name}`, `${name} fell through to the unknown-button fallback`)
  }
})
