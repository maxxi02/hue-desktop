import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
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
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

let cache: HueSettings | null = null

function readFromDisk(): HueSettings {
  const file = SETTINGS_FILE()
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<HueSettings>
    const merged = { ...DEFAULT_SETTINGS, ...raw }
    for (const key of SECRET_SETTING_KEYS) {
      merged[key] = decryptSecret(merged[key] as string)
    }
    return migrateSettings(merged)
  } catch {
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
  writeFileSync(SETTINGS_FILE(), JSON.stringify(onDisk, null, 2), 'utf-8')
  return { ...next }
}
