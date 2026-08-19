import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readEvents, writeEvents } from './usage-store.ts'
import type { UsageEvent } from '../shared/usage.ts'

/**
 * The usage log is written on a debounce during a live interview and read at
 * launch. Neither moment can afford a throw: a half-written file must cost you
 * your usage history, never your session. Most of these tests are about the
 * file being wrong in some way and the app carrying on regardless.
 *
 * `dir` is a parameter here so this can run without Electron.
 */

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hue-usage-'))
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const AT = Date.UTC(2026, 7, 15, 12, 0, 0)

function ev(at: number, provider = 'groq'): UsageEvent {
  return { at, kind: 'llm', provider, inputTokens: 10, outputTokens: 2 }
}

test('events written to disk come back the same', () => {
  const dir = tempDir()
  writeEvents(dir, [ev(AT), ev(AT - 1000)], AT)
  const back = readEvents(dir)
  assert.equal(back.length, 2)
  assert.equal(back[0].provider, 'groq')
  assert.equal(back[0].inputTokens, 10)
})

test('a first run with no file yet reads as no usage, not as an error', () => {
  assert.deepEqual(readEvents(tempDir()), [])
})

test('a corrupt file loses the usage history and nothing else', () => {
  // Killing the app mid-write leaves truncated JSON. Throwing here would take
  // out whatever called it — at launch, that is the whole app.
  const dir = tempDir()
  writeFileSync(join(dir, 'usage.json'), '{"events":[{"at":17', 'utf-8')
  assert.deepEqual(readEvents(dir), [])
})

test('a file holding the wrong shape entirely is discarded rather than trusted', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'usage.json'), '"a string"', 'utf-8')
  assert.deepEqual(readEvents(dir), [])
})

test('entries that are not shaped like usage events are dropped, not carried along', () => {
  // A hand-edited file, or a future version's format. One bad row must not
  // poison the totals — `summarize` would add `undefined` into every column.
  const dir = tempDir()
  writeFileSync(
    join(dir, 'usage.json'),
    JSON.stringify({ events: [ev(AT), { nonsense: true }, null, { at: 'soon', kind: 'llm' }] }),
    'utf-8'
  )
  const back = readEvents(dir)
  assert.equal(back.length, 1)
  assert.equal(back[0].at, AT)
})

test('writing prunes past the retention horizon, so the file cannot grow forever', () => {
  const dir = tempDir()
  const eightDays = AT - 8 * 24 * 3_600_000
  writeEvents(dir, [ev(eightDays), ev(AT)], AT)
  const back = readEvents(dir)
  assert.equal(back.length, 1)
  assert.equal(back[0].at, AT)
})

test('the directory is created on first write rather than assumed to exist', () => {
  const dir = join(tempDir(), 'not-yet')
  writeEvents(dir, [ev(AT)], AT)
  assert.equal(readEvents(dir).length, 1)
})
