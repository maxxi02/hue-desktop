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

// The cue sheet feature was removed on 2026-08-19. `selectedCueSheetId` named
// a sheet on disk that nothing reads any more, and without retiring it the key
// survives the merge in `readFromDisk` and is re-persisted on every write.
test('a settings file carrying a selected cue sheet loads without it', () => {
  const stale = {
    ...DEFAULT_SETTINGS,
    selectedCueSheetId: 'sheet-abc123'
  } as unknown as typeof DEFAULT_SETTINGS
  const migrated = migrateSettings(stale) as unknown as Record<string, unknown>
  assert.equal('selectedCueSheetId' in migrated, false)
})

// ── Speculation opt-in ─────────────────────────────────────────────────────

/**
 * Flipping the default is not enough on its own. `settings.ts` merges a saved
 * file *over* DEFAULT_SETTINGS, so an install that already has one would keep
 * speculation off forever and never get the latency the whole scheduler exists
 * to buy. Same reasoning the retired-keys migration above is built on.
 */
test('an existing install is opted into speculative drafting once', () => {
  const before = {
    ...DEFAULT_SETTINGS,
    speculativeDrafting: false,
    speculationOptInApplied: false
  }
  const after = migrateSettings(before)
  assert.equal(after.speculativeDrafting, true)
  assert.equal(after.speculationOptInApplied, true)
})

// A user who turns it back off must stay off. Without the marker key the
// migration would overrule them on every launch.
test('a user who turned speculation off is not re-flipped', () => {
  const before = {
    ...DEFAULT_SETTINGS,
    speculativeDrafting: false,
    speculationOptInApplied: true
  }
  assert.equal(migrateSettings(before).speculativeDrafting, false)
})

// The opt-in has to run whether or not there were retired keys to clean up.
// The migration used to return early when nothing was stale.
test('the opt-in runs even when there are no retired keys to drop', () => {
  const clean = { ...DEFAULT_SETTINGS, speculationOptInApplied: false }
  assert.equal(migrateSettings(clean).speculativeDrafting, true)
})

// The model default is deliberately NOT migrated: swapping the model behind a
// user who chose one is a quality change made without their consent.
test('an existing install keeps whatever model it had', () => {
  const before = { ...DEFAULT_SETTINGS, model: 'claude-opus-4-8' }
  assert.equal(migrateSettings(before).model, 'claude-opus-4-8')
})
