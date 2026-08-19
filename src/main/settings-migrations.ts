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
  'ingestAccountToken',
  // The cue sheet feature, removed 2026-08-19.
  'selectedCueSheetId'
] as const

/** Heal settings read from disk, dropping keys no build can use any more. */
export function migrateSettings(settings: HueSettings): HueSettings {
  const record = settings as unknown as Record<string, unknown>
  const stale = RETIRED_SETTING_KEYS.filter((key) => key in record)
  const needsOptIn = record.speculationOptInApplied !== true
  // Identity when there is nothing to do, or every launch rewrites the file.
  if (stale.length === 0 && !needsOptIn) return settings

  const next = { ...record }
  for (const key of stale) delete next[key]

  // One-time speculative-drafting opt-in.
  //
  // Flipping the default in DEFAULT_SETTINGS reaches new installs only: a saved
  // file wins on merge (see `settings.ts`), so an existing install would keep
  // speculation off forever. The marker key is what keeps this a one-time
  // change rather than a setting the app re-imposes on every launch, which is
  // the difference between an opt-in and overruling the user.
  //
  // The model default is deliberately NOT migrated alongside it. Speculation is
  // a strict improvement; a different model is a quality tradeoff, and making
  // that choice on someone's behalf is not this function's business.
  if (needsOptIn) {
    next.speculativeDrafting = true
    next.speculationOptInApplied = true
  }

  return next as unknown as HueSettings
}
