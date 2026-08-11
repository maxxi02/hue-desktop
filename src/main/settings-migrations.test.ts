import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateSettings, RETIRED_INGEST_HOSTS } from './settings-migrations.ts'
import { DEFAULT_SETTINGS } from '../shared/types.ts'

const withIngestUrl = (ingestBaseUrl: string): typeof DEFAULT_SETTINGS => ({
  ...DEFAULT_SETTINGS,
  ingestBaseUrl
})

test('a retired host is replaced, since a saved copy outlives the corrected default', () => {
  const migrated = migrateSettings(withIngestUrl('https://ingest.hue.app'))
  assert.equal(migrated.ingestBaseUrl, DEFAULT_SETTINGS.ingestBaseUrl)
})

test('a retired host is recognised through a trailing slash and stray whitespace', () => {
  const migrated = migrateSettings(withIngestUrl('  https://ingest.hue.app/  '))
  assert.equal(migrated.ingestBaseUrl, DEFAULT_SETTINGS.ingestBaseUrl)
})

test('the default itself is never rewritten, or every launch would churn the file', () => {
  const settings = withIngestUrl(DEFAULT_SETTINGS.ingestBaseUrl)
  assert.equal(migrateSettings(settings), settings)
})

test("a URL the user chose is left alone even when it is unreachable, since it's theirs to fix", () => {
  const chosen = 'https://ingest.mycompany.example'
  assert.equal(migrateSettings(withIngestUrl(chosen)).ingestBaseUrl, chosen)
})

test('no other setting is disturbed while healing the URL', () => {
  const before = { ...withIngestUrl('https://ingest.hue.app'), jobTitle: 'Staff Engineer' }
  const after = migrateSettings(before)
  assert.equal(after.jobTitle, 'Staff Engineer')
  assert.deepEqual(
    { ...after, ingestBaseUrl: '' },
    { ...before, ingestBaseUrl: '' },
    'migration must touch ingestBaseUrl and nothing else'
  )
})

test('the retired list does not contain the current default, which would erase it on read', () => {
  assert.ok(!RETIRED_INGEST_HOSTS.includes(DEFAULT_SETTINGS.ingestBaseUrl))
})
