import test from 'node:test'
import assert from 'node:assert/strict'
import {
  displayCapturePolicy,
  macOsMajor,
  MACOS_SYSTEM_PICKER_MAJOR
} from './display-capture.ts'

/**
 * The macOS half of this was written on Windows and cannot be run here, which is
 * the reason the decision is a pure function at all: the branch that most needs
 * checking is the one this machine will never take.
 *
 * What these tests can prove is that the policy is right about what it claims,
 * that the two platforms never both try to own the audio, and that no path
 * silently reports success. What they cannot prove is that ScreenCaptureKit
 * hands back an audio track on a real Mac. That needs a Mac.
 */

test('Windows captures through loopback and never asks for the picker', () => {
  const p = displayCapturePolicy('win32', '10.0.26200')
  assert.equal(p.loopbackAudio, true)
  assert.equal(p.useSystemPicker, false)
  assert.equal(p.supported, true)
})

test('macOS 15 and later use the native picker, not loopback', () => {
  // `audio: 'loopback'` is documented by Electron as Windows only. Asking for it
  // on a Mac is not a fallback, it is a request that quietly returns nothing.
  for (const version of ['15.0', '15.3.1', '16.0', '26.1']) {
    const p = displayCapturePolicy('darwin', version)
    assert.equal(p.useSystemPicker, true, `${version} did not use the picker`)
    assert.equal(p.loopbackAudio, false, `${version} asked for Windows loopback`)
    assert.equal(p.supported, true)
  }
})

test('macOS 14 and older report the version as the reason, not a generic failure', () => {
  // The user can act on "needs macOS 15" and cannot act on "no audio captured".
  for (const version of ['14.7.2', '13.0', '12.6']) {
    const p = displayCapturePolicy('darwin', version)
    assert.equal(p.supported, false)
    assert.equal(p.useSystemPicker, false)
    assert.equal(p.loopbackAudio, false)
    assert.match(p.reason, /macOS 15 or later/)
    assert.match(p.reason, /Microphone/, 'no workaround was offered')
  }
})

test('an unreadable macOS version is treated as old, never as new', () => {
  // Guessing high turns a missing feature into a silent empty audio track and a
  // session that hears nothing. Guessing low costs the user a picker they can
  // work around with the microphone. The failures are not symmetric.
  for (const version of ['', 'unknown', 'Version 15']) {
    const p = displayCapturePolicy('darwin', version)
    assert.equal(p.supported, false, `"${version}" was optimistically treated as new`)
    assert.equal(p.useSystemPicker, false)
  }
})

test('Linux is told plainly that there is no route, rather than left to fail', () => {
  const p = displayCapturePolicy('linux', '')
  assert.equal(p.supported, false)
  assert.equal(p.useSystemPicker, false)
  assert.equal(p.loopbackAudio, false)
  assert.match(p.reason, /Microphone/)
})

test('the two capture routes are never both on', () => {
  // They are different mechanisms, and when the picker is active our handler is
  // not invoked at all, so a policy asking for both would be describing
  // something that cannot happen.
  const platforms: NodeJS.Platform[] = ['win32', 'darwin', 'linux', 'freebsd']
  for (const platform of platforms) {
    for (const version of ['', '14.0', '15.1', '10.0.26200']) {
      const p = displayCapturePolicy(platform, version)
      assert.equal(
        p.useSystemPicker && p.loopbackAudio,
        false,
        `${platform} ${version} claimed both routes`
      )
      // Every unsupported path still has to explain itself.
      if (!p.supported) assert.ok(p.reason.length > 0, `${platform} ${version} gave no reason`)
    }
  }
})

test('support implies exactly one working route', () => {
  const platforms: NodeJS.Platform[] = ['win32', 'darwin', 'linux']
  for (const platform of platforms) {
    for (const version of ['', '13.2', '15.0', '10.0.26200']) {
      const p = displayCapturePolicy(platform, version)
      assert.equal(
        p.supported,
        p.useSystemPicker || p.loopbackAudio,
        `${platform} ${version} disagrees with itself about support`
      )
    }
  }
})

test('the version parser reads a marketing version and rejects everything else', () => {
  assert.equal(macOsMajor('15.3.1'), 15)
  assert.equal(macOsMajor('14'), 14)
  assert.equal(macOsMajor(' 26.0 '), 26)
  assert.equal(macOsMajor(''), null)
  assert.equal(macOsMajor('x15'), null)
  assert.equal(macOsMajor('0'), null)
})

test('the threshold is named once, so the message and the branch cannot disagree', () => {
  const below = displayCapturePolicy('darwin', `${MACOS_SYSTEM_PICKER_MAJOR - 1}.0`)
  const at = displayCapturePolicy('darwin', `${MACOS_SYSTEM_PICKER_MAJOR}.0`)
  assert.equal(below.supported, false)
  assert.equal(at.supported, true)
  assert.match(below.reason, new RegExp(`macOS ${MACOS_SYSTEM_PICKER_MAJOR} or later`))
})
