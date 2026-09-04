/**
 * How to ask the OS for the interviewer's voice.
 *
 * Companion mode's whole input is the call audio coming out of the speakers, so
 * this decision is the difference between a working install and one that can
 * only hear the user. It is not one mechanism with a flag: Windows and macOS
 * reach system audio by genuinely different routes, and macOS only reaches it at
 * all on recent versions.
 *
 * **Windows** — `audio: 'loopback'` from `setDisplayMediaRequestHandler`.
 * Chromium taps the audio render stream directly. Electron's own typings say
 * this is "currently only supported on Windows", so it is not a default that
 * happens to work elsewhere; it is the Windows path.
 *
 * **macOS 15+** — `useSystemPicker: true`, which hands the request to
 * ScreenCaptureKit's own `SCContentSharingPicker`. The user picks the screen or
 * window in a native panel, and system audio comes back with it. Two
 * consequences worth knowing before touching this: when the picker is available
 * and the flag is set, **our handler is never invoked at all**, so nothing in it
 * can influence the result; and Electron documents the flag as experimental and
 * macOS 15+ only, which is why the version is parsed rather than assumed.
 *
 * **macOS 14 and older, and Linux** — there is no route. `loopback` is not
 * implemented, and the picker does not exist. Saying so here, once, is what lets
 * the renderer fail with a sentence naming the actual reason instead of handing
 * the user an empty audio track and a silent session.
 *
 * Pure so it can be tested without an Electron session: the branch that matters
 * most is the one this development machine cannot run.
 */

/** What the main process should do about system-audio capture on this machine. */
export interface DisplayCapturePolicy {
  /**
   * Pass to `setDisplayMediaRequestHandler`'s options. True only where the
   * native picker both exists and carries audio.
   */
  useSystemPicker: boolean
  /**
   * Whether the handler should answer with `audio: 'loopback'`. Meaningless when
   * `useSystemPicker` is true, because the handler does not run.
   */
  loopbackAudio: boolean
  /** Whether system audio is reachable at all here. */
  supported: boolean
  /**
   * Why, in words a user can act on. Shown when companion mode cannot hear the
   * call, so it names the platform limit rather than saying "no audio".
   */
  reason: string
}

/**
 * The macOS major version, or null if the string is not one.
 *
 * `process.getSystemVersion()` returns the marketing version on macOS ("15.3.1"),
 * which is the number Electron's own "macOS 15+" constraint is written against.
 * Anything unparseable is treated as unknown rather than as new: guessing high
 * turns a missing feature into a silent, empty audio track, and guessing low only
 * costs a user the picker they can still work around with the microphone.
 */
export function macOsMajor(systemVersion: string): number | null {
  const match = /^(\d+)(?:\.|$)/.exec(systemVersion.trim())
  if (!match) return null
  const major = Number(match[1])
  return Number.isSafeInteger(major) && major > 0 ? major : null
}

/** The macOS release that first exposes system audio through the native picker. */
export const MACOS_SYSTEM_PICKER_MAJOR = 15

export function displayCapturePolicy(
  platform: NodeJS.Platform,
  systemVersion: string
): DisplayCapturePolicy {
  if (platform === 'win32') {
    return {
      useSystemPicker: false,
      loopbackAudio: true,
      supported: true,
      reason: 'System audio is captured through Windows loopback.'
    }
  }

  if (platform === 'darwin') {
    const major = macOsMajor(systemVersion)
    if (major !== null && major >= MACOS_SYSTEM_PICKER_MAJOR) {
      return {
        useSystemPicker: true,
        loopbackAudio: false,
        supported: true,
        reason:
          'System audio is captured through the macOS screen-sharing picker. ' +
          'Choose the window or screen the call is in when macOS asks, and make ' +
          'sure its audio is shared.'
      }
    }
    return {
      useSystemPicker: false,
      loopbackAudio: false,
      supported: false,
      reason:
        `Capturing the call's audio needs macOS ${MACOS_SYSTEM_PICKER_MAJOR} or later` +
        (major === null ? '' : ` (this Mac reports macOS ${major})`) +
        '. Until then, set the audio source to Microphone: Hue will hear the call ' +
        'through your mic, which works but also picks up the room.'
    }
  }

  return {
    useSystemPicker: false,
    loopbackAudio: false,
    supported: false,
    reason:
      'Capturing the call’s audio is supported on Windows and on macOS ' +
      `${MACOS_SYSTEM_PICKER_MAJOR} or later. On this platform, set the audio ` +
      'source to Microphone.'
  }
}
