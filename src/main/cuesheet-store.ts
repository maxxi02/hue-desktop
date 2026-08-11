/**
 * Cue sheets on disk, one file each.
 *
 * Deliberately not in `hue-settings.json` alongside `profileBundleJson`.
 * `settings.ts` writes that file whole on every update; cue sheets are plural
 * and each carries a full document, so folding them in would rewrite every
 * sheet on every unrelated settings change.
 *
 * Stored in plaintext, matching `profileBundleJson`, which is not in
 * `SECRET_SETTING_KEYS` either. That is a consistency choice about content
 * class — personal, not credential — and not an oversight. `safeStorage` is
 * reserved for API keys and the ingest token.
 *
 * `dir` is a parameter rather than read from `app` so this module tests
 * without Electron.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CueSheet } from '../shared/cuesheet'

export function sheetsDir(): string {
  const { app } = require('electron')
  return join(app.getPath('userData'), 'cue-sheets')
}

function fileFor(dir: string, id: string): string {
  // Ids are minted by ingest, but a path separator arriving here would write
  // outside the directory, so the name is derived rather than trusted.
  return join(dir, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`)
}

export function saveSheet(dir: string, sheet: CueSheet): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(fileFor(dir, sheet.id), JSON.stringify(sheet, null, 2), 'utf-8')
}

export function listSheets(dir: string): CueSheet[] {
  if (!existsSync(dir)) return []
  const out: CueSheet[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const sheet = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as CueSheet
      if (typeof sheet?.id === 'string' && Array.isArray(sheet?.cards)) out.push(sheet)
    } catch {
      // A corrupt sheet loses that sheet, not the session. Throwing here would
      // mean one bad file makes the whole feature unavailable mid-interview.
    }
  }
  return out
}

export function deleteSheet(dir: string, id: string): void {
  rmSync(fileFor(dir, id), { force: true })
}
