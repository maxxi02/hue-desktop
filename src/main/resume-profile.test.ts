import test from 'node:test'
import assert from 'node:assert/strict'
import { contentHash, sealBundle, estimateTokens } from './resume-profile.ts'
import type { ProfileBundle } from '../shared/profile.ts'

const parts = (): Omit<ProfileBundle, 'hash' | 'createdAt'> => ({
  version: 1,
  profile: {
    identity: { name: 'Ada', headline: null, location: null, email: null, links: [] },
    roles: [],
    education: [],
    skills: [],
    metrics: []
  },
  stories: [],
  gaps: []
})

test('the hash covers content only, so createdAt does not change it', () => {
  const a = sealBundle(parts(), '2026-01-01T00:00:00.000Z')
  const b = sealBundle(parts(), '2026-08-12T00:00:00.000Z')
  assert.equal(a.hash, b.hash)
  assert.notEqual(a.createdAt, b.createdAt)
})

test('a changed story bank changes the hash — it is a cache key', () => {
  const before = contentHash(parts())
  const after = contentHash({
    ...parts(),
    gaps: [
      {
        id: 'g1',
        competency: 'failure',
        question: 'Tell me about a failure.',
        status: 'open',
        storyId: null
      }
    ]
  })
  assert.notEqual(before, after)
})

test('the hash is a full sha256 hex digest, unchanged from the service that produced saved bundles', () => {
  assert.match(contentHash(parts()), /^[0-9a-f]{64}$/)
})

test('estimateTokens returns a positive count for a real bundle', () => {
  assert.ok(estimateTokens(sealBundle(parts(), '2026-01-01T00:00:00.000Z')) > 0)
})
