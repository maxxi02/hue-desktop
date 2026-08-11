import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_STORED_SESSIONS,
  SESSION_HISTORY_KEY,
  createSession,
  isReviewable,
  loadSessions,
  parseSessionHistory,
  saveSession,
  toReviewTurns,
  type SessionStorage,
  type StoredSession
} from './sessionHistory.ts'
import type { ProfileStory } from '../../../shared/profile.ts'
import type { Grounding } from '../../../shared/grounding.ts'

function story(overrides: Partial<ProfileStory> = {}): ProfileStory {
  return {
    id: 'conflict-manager-roadmap',
    roleId: 'acme-robotics',
    competencies: ['conflict'],
    situation: 'Sprint planning kept slipping in Q3 2024.',
    task: 'Settle it.',
    action: 'Proposed a data-backed alternative.',
    result: 'My approach won.',
    metrics: [],
    source: 'resume',
    ...overrides
  }
}

const grounded: Grounding = { kind: 'grounded', story: story() }
const ungrounded: Grounding = { kind: 'ungrounded', claimedId: null }

/** An in-memory stand-in for localStorage, so the tests never need a browser. */
function memoryStorage(seed?: string): SessionStorage & { readonly value: string | null } {
  let value: string | null = seed ?? null
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
    },
    get value() {
      return value
    }
  }
}

function session(id: string): StoredSession {
  return createSession([{ role: 'assistant', grounding: grounded }], '2026-01-01T00:00:00.000Z', id)
}

test('a saved session is read back intact, so a review survives a restart', () => {
  const storage = memoryStorage()
  saveSession(session('a'), storage)
  const loaded = loadSessions(storage)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'a')
  assert.deepEqual(loaded[0].turns, [{ role: 'assistant', grounding: grounded }])
})

test('the newest session is first, because that is the one the user just finished', () => {
  const storage = memoryStorage()
  saveSession(session('older'), storage)
  saveSession(session('newer'), storage)
  assert.deepEqual(
    loadSessions(storage).map((s) => s.id),
    ['newer', 'older']
  )
})

test('history is capped, so localStorage cannot grow without bound across months of practice', () => {
  const storage = memoryStorage()
  for (let i = 0; i < MAX_STORED_SESSIONS + 5; i++) saveSession(session(`s${i}`), storage)
  const loaded = loadSessions(storage)
  assert.equal(loaded.length, MAX_STORED_SESSIONS)
  // Oldest-first pruning: the five earliest sessions are the ones that fell off.
  assert.equal(loaded[0].id, `s${MAX_STORED_SESSIONS + 4}`)
  assert.equal(loaded[loaded.length - 1].id, 's5')
})

test('an unparseable blob yields an empty history rather than throwing on boot', () => {
  assert.deepEqual(parseSessionHistory('{ not json'), [])
  assert.deepEqual(parseSessionHistory(''), [])
  assert.deepEqual(parseSessionHistory(null), [])
  // A valid JSON document of the wrong shape is just as unusable as broken JSON.
  assert.deepEqual(parseSessionHistory('{"sessions":[]}'), [])
  assert.deepEqual(loadSessions(memoryStorage('<<corrupt>>')), [])
})

test('one corrupt record is discarded without taking the readable sessions with it', () => {
  const raw = JSON.stringify([
    session('good'),
    { id: 'no-turns' },
    { id: 'bad-turn', endedAt: '2026-01-01T00:00:00.000Z', turns: [{ role: 'robot' }] },
    'not even an object'
  ])
  assert.deepEqual(
    parseSessionHistory(raw).map((s) => s.id),
    ['good']
  )
})

test('a session whose receipt is malformed is dropped whole, so no count is silently understated', () => {
  const raw = JSON.stringify([
    {
      id: 'half-valid',
      endedAt: '2026-01-01T00:00:00.000Z',
      turns: [
        { role: 'assistant', grounding: grounded },
        { role: 'assistant', grounding: { kind: 'grounded', story: { id: 'x' } } }
      ]
    }
  ])
  assert.deepEqual(parseSessionHistory(raw), [])
})

test('storage that refuses to write still returns the session, so the user sees the scorecard they earned', () => {
  const failing: SessionStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    }
  }
  const saved = saveSession(session('a'), failing)
  assert.deepEqual(
    saved.map((s) => s.id),
    ['a']
  )
})

test('an absent storage backend degrades to an empty in-memory history instead of crashing', () => {
  assert.deepEqual(loadSessions(null), [])
  assert.equal(saveSession(session('a'), null).length, 1)
})

test('the stored key is versioned so a future shape change cannot be read as this one', () => {
  const storage = memoryStorage()
  saveSession(session('a'), storage)
  assert.match(SESSION_HISTORY_KEY, /\.v\d+$/)
  assert.ok(storage.value?.includes('conflict-manager-roadmap'))
})

test('only role and grounding are persisted, never the interviewer question or the answer text', () => {
  const turns = toReviewTurns([
    { role: 'user', text: 'Tell me about a conflict at Acme Robotics.' } as never,
    { role: 'assistant', text: 'In Q3 2024 my manager and I…', grounding: grounded } as never
  ])
  assert.deepEqual(turns, [{ role: 'user' }, { role: 'assistant', grounding: grounded }])
  assert.ok(!JSON.stringify(turns).includes('Acme Robotics'))
})

test('a session with no receipts is not reviewable, so start-then-stop files no empty scorecard', () => {
  assert.equal(isReviewable([]), false)
  assert.equal(isReviewable([{ role: 'user' }]), false)
  assert.equal(isReviewable([{ role: 'assistant' }]), false)
  // Every answer unanchored is still a session worth reviewing — that is the
  // signal the review exists to deliver, not an empty one.
  assert.equal(isReviewable([{ role: 'assistant', grounding: ungrounded }]), true)
})
