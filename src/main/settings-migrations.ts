import { DEFAULT_SETTINGS, type HueSettings } from '../shared/types.ts'

/**
 * Hosts an earlier build shipped as the `ingestBaseUrl` default and which never
 * existed. hue-ingest is a service the user runs, not one we host.
 *
 * Correcting the default is not enough on its own. A saved file wins over
 * `DEFAULT_SETTINGS` on merge, and `updateSettings` writes every key back, so a
 * dead value is re-saved on the next settings change and survives the upgrade
 * that was supposed to remove it.
 */
export const RETIRED_INGEST_HOSTS = ['https://ingest.hue.app']

const canonical = (raw: string): string => raw.trim().replace(/\/+$/, '')

/**
 * Heal settings read from disk. Only ever replaces a value the user cannot have
 * chosen deliberately — a URL we shipped and then retired. A URL the user typed
 * is left alone even when it is unreachable, because a wrong address they own is
 * theirs to fix and silently rewriting it would hide the mistake.
 */
export function migrateSettings(settings: HueSettings): HueSettings {
  if (RETIRED_INGEST_HOSTS.includes(canonical(settings.ingestBaseUrl))) {
    return { ...settings, ingestBaseUrl: DEFAULT_SETTINGS.ingestBaseUrl }
  }
  return settings
}
