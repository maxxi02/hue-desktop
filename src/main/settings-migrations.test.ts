import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateSettings, RETIRED_SETTING_KEYS } from './settings-migrations.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'

test('the retired ingest service keys are deleted from a settings file read off disk', () => {
  const stale = {
    ...DEFAULT_SETTINGS,
    ingestBaseUrl: 'http://localhost:8788',
    ingestAccountId: 'acct_123',
    ingestAccountToken: 'secret'
  } as unknown as typeof DEFAULT_SETTINGS
  const migrated = migrateSettings(stale) as unknown as Record<string, unknown>
  for (const key of RETIRED_SETTING_KEYS) {
    assert.equal(key in migrated, false, `${key} survived the migration`)
  }
})

test('the account token in particular does not linger — it is a live credential', () => {
  const stale = {
    ...DEFAULT_SETTINGS,
    ingestAccountToken: 'secret'
  } as unknown as typeof DEFAULT_SETTINGS
  const migrated = migrateSettings(stale) as unknown as Record<string, unknown>
  assert.equal(migrated.ingestAccountToken, undefined)
})

test('an existing profile bundle is untouched — the whole point is no re-upload', () => {
  const bundleJson = '{"version":1,"hash":"abc","createdAt":"2026-01-01T00:00:00.000Z"}'
  const migrated = migrateSettings({ ...DEFAULT_SETTINGS, profileBundleJson: bundleJson })
  assert.equal(migrated.profileBundleJson, bundleJson)
})

test('settings with nothing retired are returned unchanged, or every launch churns the file', () => {
  const clean = { ...DEFAULT_SETTINGS }
  assert.equal(migrateSettings(clean), clean)
})
