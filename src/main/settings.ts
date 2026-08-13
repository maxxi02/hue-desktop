import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'fs'
import { DEFAULT_SETTINGS, SECRET_SETTING_KEYS, HueSettings } from '../shared/types'
import { migrateSettings } from './settings-migrations.ts'

const SETTINGS_FILE = (): string => join(app.getPath('userData'), 'hue-settings.json')
const ENC_PREFIX = 'enc:v1:'

type SecretKey = (typeof SECRET_SETTING_KEYS)[number]
const isSecretKey = (k: string): k is SecretKey =>
  (SECRET_SETTING_KEYS as readonly string[]).includes(k)

function encryptSecret(value: string): string {
  if (!value) return ''
  if (!safeStorage.isEncryptionAvailable()) return value
  return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(stored: string): string {
  // Typed as a string, but this value came off disk: a hand-edited file (which
  // the settings format invites) can hold a number or an object here, and
  // calling startsWith on one used to throw all the way out of readFromDisk —
  // which discarded the entire file, résumé bundle and API keys included.
  if (typeof stored !== 'string') return ''
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

let cache: HueSettings | null = null
/**
 * True when the file existed but could not be read. The distinction matters:
 * "no settings yet" and "your settings are there but I couldn't read them" are
 * the same value in memory and must not be the same action on disk.
 */
let loadFailed = false

function readFromDisk(): HueSettings {
  const file = SETTINGS_FILE()
  loadFailed = false
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<HueSettings>
    const merged = { ...DEFAULT_SETTINGS, ...raw }
    for (const key of SECRET_SETTING_KEYS) {
      merged[key] = decryptSecret(merged[key] as string)
    }
    return migrateSettings(merged)
  } catch (e) {
    // On Windows a read here fails for reasons that have nothing to do with the
    // contents — an AV scanner or a sync client holding the file (EBUSY/EACCES)
    // at launch. Falling back to defaults is right for this run; overwriting the
    // file with those defaults is not, and that combination is what silently
    // destroyed the résumé bundle and every API key on one unlucky launch.
    console.error('could not read settings; this run uses defaults:', e)
    loadFailed = true
    return { ...DEFAULT_SETTINGS }
  }
}

export function getSettings(): HueSettings {
  if (!cache) cache = readFromDisk()
  return { ...cache }
}

export function updateSettings(partial: Partial<HueSettings>): HueSettings {
  const next = { ...getSettings(), ...partial }
  cache = next

  const onDisk: Record<string, unknown> = { ...next }
  for (const key of Object.keys(onDisk)) {
    if (isSecretKey(key)) onDisk[key] = encryptSecret(onDisk[key] as string)
  }

  const file = SETTINGS_FILE()

  // The unreadable original is preserved rather than overwritten. It may hold a
  // résumé bundle that took a minute and an API call to produce, and there is no
  // second copy of it anywhere.
  if (loadFailed) {
    try {
      renameSync(file, `${file}.unreadable`)
      console.error(`kept the unreadable settings file as ${file}.unreadable`)
    } catch (e) {
      console.error('could not preserve the unreadable settings file:', e)
    }
    loadFailed = false
  }

  writeAtomic(file, JSON.stringify(onDisk, null, 2))
  return { ...next }
}

/**
 * Write via a temp file and a rename.
 *
 * `writeFileSync` truncates first, so a crash, a power loss, or a full disk
 * partway through leaves a truncated file — and this one file holds the résumé
 * bundle, every API key, and the hotkeys. The next launch would parse-fail on
 * it and present a factory-fresh app with no error and no way back. A rename is
 * atomic on both Windows and POSIX, so the file on disk is only ever the old
 * complete version or the new complete one.
 */
function writeAtomic(file: string, contents: string): void {
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, contents, 'utf-8')
    renameSync(tmp, file)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Leaving a stray .tmp is harmless; the next write overwrites it.
    }
    throw e
  }
}
