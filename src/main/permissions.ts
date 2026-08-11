/**
 * The only browser permissions Hue grants its renderer. Everything else —
 * geolocation, notifications, clipboard, midi, … — is denied.
 *
 * - `media`: the voice pipeline's microphone (getUserMedia).
 * - `display-capture`: system loopback audio for Companion mode (getDisplayMedia).
 * - `persistent-storage`: marks the CacheStorage bucket holding the on-device
 *   models as persistent. Whisper and Kokoro together are ~190 MB of ONNX
 *   weights that transformers.js keeps in `caches`. Without this permission
 *   `navigator.storage.persist()` resolves false and the bucket stays
 *   "best-effort", which Chromium is free to evict under disk pressure — and an
 *   evicted bucket means the user re-downloads ~190 MB from HuggingFace on the
 *   next launch, on a feature that is supposed to work offline.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'display-capture',
  'persistent-storage'
])

/** True when the renderer is allowed to use `permission`. */
export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}
