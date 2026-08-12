import type { HueSettings } from '../shared/types.ts'

/**
 * Settings belonging to the `hue-ingest` service, which no longer exists.
 *
 * Deleting the fields from `HueSettings` is not enough on its own. A saved file
 * wins over `DEFAULT_SETTINGS` on merge, and `updateSettings` writes every key
 * back, so a dead value is re-saved on the next settings change and survives the
 * upgrade that was supposed to remove it.
 *
 * `ingestAccountToken` is the one that makes this urgent rather than tidy: it is
 * a live credential for a service the user no longer runs, and leaving it on
 * disk after its reason to exist is gone is nobody's job to clean up later.
 */
export const RETIRED_SETTING_KEYS = [
  'ingestBaseUrl',
  'ingestAccountId',
  'ingestAccountToken'
] as const

/** Heal settings read from disk, dropping keys no build can use any more. */
export function migrateSettings(settings: HueSettings): HueSettings {
  const record = settings as unknown as Record<string, unknown>
  const stale = RETIRED_SETTING_KEYS.filter((key) => key in record)
  if (stale.length === 0) return settings

  const next = { ...record }
  for (const key of stale) delete next[key]
  return next as unknown as HueSettings
}
