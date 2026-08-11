import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSheet, listSheets, deleteSheet } from './cuesheet-store.ts'
import type { CueSheet } from '../shared/cuesheet.ts'

const sheet: CueSheet = {
  id: 'abc', label: 'Apollo', sourceHash: 'h', createdAt: '2026-08-11T00:00:00.000Z',
  cards: [{ id: 'c', heading: 'h', cues: ['x'], script: 's', triggers: ['t'] }]
}

test('round-trips a sheet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-'))
  try {
    saveSheet(dir, sheet)
    assert.deepEqual(listSheets(dir), [sheet])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listing an absent directory returns empty rather than throwing', () => {
  assert.deepEqual(listSheets(join(tmpdir(), 'cue-does-not-exist-91827')), [])
})

test('a corrupt file is skipped, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-'))
  try {
    saveSheet(dir, sheet)
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    assert.equal(listSheets(dir).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete removes only the named sheet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-'))
  try {
    saveSheet(dir, sheet)
    saveSheet(dir, { ...sheet, id: 'def' })
    deleteSheet(dir, 'abc')
    assert.deepEqual(listSheets(dir).map((s) => s.id), ['def'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
