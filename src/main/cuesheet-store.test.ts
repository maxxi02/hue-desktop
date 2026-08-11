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

test('id containing a path separator throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-'))
  try {
    assert.throws(
      () => saveSheet(dir, { ...sheet, id: 'a/b' }),
      /Invalid cue sheet id/
    )
    assert.throws(
      () => saveSheet(dir, { ...sheet, id: '../escape' }),
      /Invalid cue sheet id/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('empty id throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-'))
  try {
    assert.throws(
      () => saveSheet(dir, { ...sheet, id: '' }),
      /Invalid cue sheet id/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two distinct ids that would previously collide no longer both resolve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-'))
  try {
    // First id with a slash would previously collide with second id
    assert.throws(
      () => saveSheet(dir, { ...sheet, id: 'a/b' }),
      /Invalid cue sheet id/
    )
    // The second id that would have collided should still work
    saveSheet(dir, { ...sheet, id: 'ab' })
    const sheets = listSheets(dir)
    assert.equal(sheets.length, 1)
    assert.equal(sheets[0].id, 'ab')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a normal UUID-shaped id round-trips unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-'))
  try {
    const uuidSheet = { ...sheet, id: '550e8400-e29b-41d4-a716-446655440000' }
    saveSheet(dir, uuidSheet)
    const retrieved = listSheets(dir)
    assert.equal(retrieved.length, 1)
    assert.equal(retrieved[0].id, uuidSheet.id)
    deleteSheet(dir, uuidSheet.id)
    assert.equal(listSheets(dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file in the directory whose name does not match the pattern does not break listSheets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-'))
  try {
    saveSheet(dir, sheet)
    // Write files with bad names but invalid sheet structure - they should be skipped
    writeFileSync(join(dir, 'malformed-name!!!.json'), '{ "not": "a sheet" }')
    writeFileSync(join(dir, 'another@bad.json'), '{ "id": "test" }')
    // listSheets should skip the invalid files and return only the valid sheet
    const sheets = listSheets(dir)
    assert.equal(sheets.length, 1)
    assert.equal(sheets[0].id, 'abc')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
