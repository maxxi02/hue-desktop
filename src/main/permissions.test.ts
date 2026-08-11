import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPermissionAllowed, ALLOWED_PERMISSIONS } from './permissions.ts'

test('the microphone and loopback capture the voice pipeline needs are granted', () => {
  assert.equal(isPermissionAllowed('media'), true)
  assert.equal(isPermissionAllowed('display-capture'), true)
})

test('persistent-storage is granted, or the ~190 MB model cache stays evictable', () => {
  // navigator.storage.persist() resolves false unless this permission is
  // granted, which leaves the transformers.js CacheStorage bucket best-effort
  // and lets Chromium evict the on-device models between launches.
  assert.equal(isPermissionAllowed('persistent-storage'), true)
})

test('everything Hue does not use stays denied', () => {
  for (const denied of [
    'geolocation',
    'notifications',
    'clipboard-read',
    'midi',
    'midiSysex',
    'openExternal',
    'pointerLock',
    'fullscreen',
    'idle-detection',
    'window-management'
  ]) {
    assert.equal(isPermissionAllowed(denied), false, `${denied} should be denied`)
  }
})

test('the allowlist is exactly the three capabilities Hue uses', () => {
  // A guard against quietly widening the renderer's reach: adding a permission
  // here should be a deliberate edit with a reason, not a drive-by.
  assert.deepEqual([...ALLOWED_PERMISSIONS].sort(), [
    'display-capture',
    'media',
    'persistent-storage'
  ])
})
