/**
 * Ask Chromium to mark this origin's storage bucket persistent.
 *
 * transformers.js keeps the on-device models (Whisper ~70 MB, Kokoro ~92 MB) in
 * the `transformers-cache` CacheStorage bucket. By default that bucket is
 * "best-effort": Chromium may evict it whenever it wants disk back, and an
 * eviction silently costs the user a ~190 MB re-download from HuggingFace on the
 * next launch — on features that are meant to run offline.
 *
 * `persist()` flips the bucket to durable. It only succeeds because the main
 * process grants the `persistent-storage` permission (see main/permissions.ts);
 * without that grant it resolves false and the models stay evictable.
 *
 * Safe to call more than once — an already-persistent bucket just resolves true.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted()) return true

    const granted = await navigator.storage.persist()
    if (!granted) {
      console.warn(
        '[storage] persistent storage denied — the on-device model cache may be evicted, ' +
          'forcing a full re-download of Whisper and Kokoro on a later launch'
      )
    }
    return granted
  } catch (err) {
    console.warn('[storage] could not request persistent storage:', err)
    return false
  }
}
