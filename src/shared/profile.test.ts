import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeBundle,
  isProfileBundle,
  parseProfileBundle,
  profilePromptBlock,
  type ProfileBundle
} from './profile.ts'

function bundle(overrides: Partial<ProfileBundle> = {}): ProfileBundle {
  return {
    version: 1,
    hash: 'a'.repeat(64),
    createdAt: '2026-08-09T12:00:00.000Z',
    profile: {
      identity: {
        name: 'Jordan Reyes',
        headline: 'Senior Platform Engineer',
        location: 'Zurich',
        email: 'jordan@example.com',
        links: []
      },
      roles: [
        {
          id: 'acme-robotics',
          company: 'Acme Robotics',
          title: 'Senior Platform Engineer',
          start: '2021',
          end: '2024',
          current: false,
          stack: ['Go'],
          summary: 'Owned the checkout platform.'
        },
        {
          id: 'northwind-data',
          company: 'Northwind Data',
          title: 'Backend Engineer',
          start: '2018',
          end: null,
          current: true,
          stack: [],
          summary: null
        }
      ],
      education: [
        { institution: 'ETH Zurich', credential: 'BSc', field: 'Computer Science', end: '2018' }
      ],
      skills: ['Go'],
      metrics: [{ roleId: 'acme-robotics', value: '40%', claim: 'p99 latency' }]
    },
    stories: [
      {
        id: 'conflict-manager-roadmap',
        roleId: 'acme-robotics',
        competencies: ['conflict'],
        situation: 'Sprint planning conflict.',
        task: 'Settle it.',
        action: 'Proposed a data-backed alternative.',
        result: 'My approach won.',
        metrics: ['40%'],
        source: 'resume'
      }
    ],
    gaps: [
      { id: 'gap-failure', competency: 'failure', question: 'Q?', status: 'open', storyId: null },
      { id: 'gap-ambiguity', competency: 'ambiguity', question: 'Q?', status: 'answered', storyId: 'x' }
    ],
    ...overrides
  }
}

test('the prompt block names every story id and forbids inventing one', () => {
  const block = profilePromptBlock(bundle())
  assert.match(block, /conflict-manager-roadmap/)
  assert.match(block, /story_id: null/)
  assert.match(block, /UNKNOWN/)
  assert.match(block, /Citable metrics/)
})

test('the prompt block is byte-stable, so the edge cache key describes what was sent', () => {
  const b = bundle()
  assert.equal(profilePromptBlock(b), profilePromptBlock(b))
})

test('a current role reads as present; sections with no content are omitted', () => {
  const block = profilePromptBlock(bundle())
  assert.match(block, /Backend Engineer, Northwind Data \(2018 – present\)/)

  const bare = profilePromptBlock(
    bundle({
      profile: {
        identity: { name: null, headline: null, location: null, email: null, links: [] },
        roles: [],
        education: [],
        skills: [],
        metrics: []
      }
    })
  )
  assert.doesNotMatch(bare, /## Education/)
  assert.doesNotMatch(bare, /## Skills/)
  assert.doesNotMatch(bare, /## Citable metrics/)
  // The story-bank heading stays — the instruction not to invent one is exactly
  // what an empty bank most needs.
  assert.match(bare, /## Story bank/)
})

test('a malformed bundle is rejected rather than reaching the prompt builder', () => {
  // Settings are user-editable JSON on disk; a half-written bundle must fail at
  // load, not mid-session.
  assert.equal(parseProfileBundle('{ not json'), null)
  assert.equal(parseProfileBundle(''), null)
  assert.equal(parseProfileBundle('{"version":1}'), null)
  assert.equal(parseProfileBundle(JSON.stringify({ ...bundle(), hash: '' })), null)
  assert.equal(parseProfileBundle(JSON.stringify({ ...bundle(), stories: 'no' })), null)
  assert.ok(isProfileBundle(bundle()))
})

test('a valid bundle round-trips through JSON', () => {
  const parsed = parseProfileBundle(JSON.stringify(bundle()))
  assert.equal(parsed?.hash, 'a'.repeat(64))
  assert.equal(parsed?.stories.length, 1)
})

test('the summary counts open gaps, since that is the only actionable half', () => {
  assert.equal(describeBundle(bundle()), '1 story across 2 roles · 1 gap left to fill')
  assert.equal(
    describeBundle(bundle({ gaps: [] })),
    '1 story across 2 roles'
  )
})
