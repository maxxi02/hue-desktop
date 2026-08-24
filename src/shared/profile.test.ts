import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUNDLE_VERSION,
  COMPETENCIES,
  HIGH_RISK_COMPETENCIES,
  canonicalJson,
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
      {
        id: 'gap-ambiguity',
        competency: 'ambiguity',
        question: 'Q?',
        status: 'answered',
        storyId: 'x'
      }
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

// Tenure is the number the model inflates when nothing governs it: it is not an
// absent field, so "never infer an unknown field" does not cover it, and it is
// not a citable metric either. Left ungoverned it turned one year of experience
// into "a couple of years" — a claim the interviewer can check against the same
// resume, and one the candidate rather than the assistant gets caught on.
test('the prompt block governs tenure, not just fields and metrics', () => {
  const block = profilePromptBlock(bundle())
  assert.match(block, /couple of years/, 'the inflating phrase has to be named to be banned')
  assert.match(block, /rounding DOWN/)
})

test('the prompt block uses no dash PUNCTUATION, which has no sound read aloud', () => {
  // This text is prompt input the model reads every turn, and punctuation it
  // sees repeatedly is punctuation it imitates into answers that get spoken.
  //
  // Date ranges are the deliberate exception: "(2018 – present)" is data, not
  // prose, the en dash there is correct typography, and the format is shared
  // with hue-mobile's renderer. So the rule is checked per line, and only lines
  // that are not a parenthesised range have to be clean.
  const block = profilePromptBlock(bundle())
  assert.doesNotMatch(block, /—/, 'em dashes have no place in prompt prose')
  const offenders = block
    .split('\n')
    .filter((line) => line.includes('–') && !/\([^)]*–[^)]*\)/.test(line))
  assert.deepEqual(offenders, [], 'en dashes are only allowed inside a date range')
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
  assert.equal(describeBundle(bundle({ gaps: [] })), '1 story across 2 roles')
})

// --- Ingest contract additions (ported from hue-ingest/src/profile.ts) ---

/*
 * This used to assert `BUNDLE_VERSION === 1`, which pinned the constant rather
 * than the property the name describes. The version moved to 2 when mined
 * stories gained a verified `evidence` quote, and the contract that actually
 * matters survived it: a bundle written by an older build still loads.
 *
 * Asserting the property instead means the next bump is free where it is
 * harmless, and still fails here the moment one of them stops old bundles
 * loading — which is the only thing this test was ever for.
 */
test('a bundle written by an older version still loads', () => {
  const old = { ...bundle(), version: 1 }
  // No `evidence` on its stories, because the field did not exist yet.
  assert.ok(old.stories.every((s) => !('evidence' in s)))

  const parsed = parseProfileBundle(JSON.stringify(old))
  assert.ok(parsed, 'a version 1 bundle no longer parses')
  assert.equal(parsed.version, 1)
  assert.equal(parsed.stories.length, old.stories.length)
})

test('BUNDLE_VERSION only ever moves forward', () => {
  assert.ok(Number.isInteger(BUNDLE_VERSION))
  assert.ok(BUNDLE_VERSION >= 1)
})

test('every high-risk competency is a real competency', () => {
  for (const c of HIGH_RISK_COMPETENCIES) {
    assert.ok((COMPETENCIES as readonly string[]).includes(c), `${c} is not in COMPETENCIES`)
  }
})

test('canonicalJson sorts keys, so hash input does not depend on insertion order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
})

test('canonicalJson preserves array order, which is meaningful', () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
})

// ── Bundles that used to pass validation and throw later ───────────────────
//
// Each of these satisfied the original check — version, hash, roles, stories —
// and then threw the first time something read the field it was missing. The
// point of validating at all is that a malformed bundle is rejected at load, so
// the failure is "no profile" in Settings rather than an exception mid-session.

test('a bundle with no gaps list is rejected, not left to throw inside a render', () => {
  const b: Record<string, unknown> = { ...bundle() }
  delete b.gaps
  assert.equal(isProfileBundle(b), false)
})

test('a bundle with no identity is rejected, since the prompt builder reads it at session start', () => {
  const b = bundle()
  const profile: Record<string, unknown> = { ...b.profile }
  delete profile.identity
  assert.equal(isProfileBundle({ ...b, profile }), false)
})

test('a bundle missing education, skills or metrics is rejected rather than half-usable', () => {
  for (const key of ['education', 'skills', 'metrics'] as const) {
    const b = bundle()
    const profile = { ...b.profile }
    delete (profile as Record<string, unknown>)[key]
    assert.equal(isProfileBundle({ ...b, profile }), false, `${key} was not checked`)
  }
})

test('one malformed role is enough to reject the bundle, because one is enough to throw', () => {
  const b = bundle()
  const roles = [b.profile.roles[0], { ...b.profile.roles[1], stack: undefined }]
  assert.equal(isProfileBundle({ ...b, profile: { ...b.profile, roles } }), false)
})

test('a story without its metrics list is rejected, not discovered on the turn that cites it', () => {
  const b = bundle()
  const stories = [{ ...b.stories[0], metrics: undefined }]
  assert.equal(isProfileBundle({ ...b, stories }), false)
})

test('a story without competencies is rejected, since selection joins that list', () => {
  const b = bundle()
  const stories = [{ ...b.stories[0], competencies: 'conflict' }]
  assert.equal(isProfileBundle({ ...b, stories }), false)
})

test('an otherwise-empty but well-formed bundle is still accepted, since a thin resume is not a broken one', () => {
  const b = bundle()
  assert.equal(
    isProfileBundle({
      ...b,
      profile: { ...b.profile, roles: [], education: [], skills: [], metrics: [] },
      stories: [],
      gaps: []
    }),
    true
  )
})
