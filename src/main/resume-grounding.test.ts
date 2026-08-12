import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkProfile, checkStories, containsClaim, normalise, pruneUngrounded } from './resume-grounding.ts'
import { emptyProfile, type Profile, type Story } from '../shared/profile.ts'

const RESUME = `
Jordan Reyes — Senior Platform Engineer
Zurich, Switzerland

Acme Robotics, Inc.            2021 – 2024
Senior Platform Engineer
Cut p99 checkout latency by 40% by replacing the synchronous pricing call.
Led the migration of 30 services to Kubernetes.

Northwind Data                 2018 – 2021
Backend Engineer
Built the ingestion pipeline handling 2.4M events per day in Go and Postgres.

Education
BSc Computer Science, ETH Zurich, 2018
`

function profileWith(partial: Partial<Profile>): Profile {
  return { ...emptyProfile(), ...partial }
}

function role(overrides: Partial<Profile['roles'][number]> = {}): Profile['roles'][number] {
  return {
    id: 'r1',
    company: 'Acme Robotics',
    title: 'Senior Platform Engineer',
    start: '2021-01',
    end: '2024-01',
    current: false,
    stack: [],
    summary: null,
    ...overrides
  }
}

test('normalise folds accents, dash variants, and punctuation', () => {
  assert.equal(normalise('ETH Zürich'), 'eth zurich')
  assert.equal(normalise('2021 – 2024'), '2021 - 2024')
  assert.equal(normalise('Acme Robotics, Inc.'), 'acme robotics inc')
})

test('containsClaim matches across an interleaved two-column layout', () => {
  // A PDF text layer routinely interleaves the date range between the words of
  // a company name. Requiring contiguity here rejects a correct extraction.
  assert.ok(containsClaim('Acme  2021-2024  Robotics', 'Acme Robotics'))
})

test('containsClaim does not pass a fabrication on filler tokens alone', () => {
  assert.equal(containsClaim(RESUME, 'Bank of Ireland'), false)
})

test('containsClaim rejects the empty needle', () => {
  assert.equal(containsClaim(RESUME, '   '), false)
})

test('a grounded profile produces no errors', () => {
  const profile = profileWith({
    roles: [role(), role({ id: 'r2', company: 'Northwind Data', title: 'Backend Engineer' })],
    education: [{ institution: 'ETH Zurich', credential: 'BSc', field: 'Computer Science', end: '2018' }],
    metrics: [{ roleId: 'r1', value: '40%', claim: 'p99 checkout latency reduction' }]
  })
  const issues = checkProfile(profile, RESUME).filter((i) => i.severity === 'error')
  assert.deepEqual(issues, [])
})

test('a hallucinated employer is an error', () => {
  const profile = profileWith({ roles: [role({ company: 'Globex Corporation' })] })
  const issues = checkProfile(profile, RESUME).filter((i) => i.severity === 'error')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'company')
  assert.match(issues[0].message, /Globex Corporation/)
})

test('a corporate suffix absent from the body text is not a hallucination', () => {
  // "Northwind Data LLC" against a resume that writes "Northwind Data".
  const profile = profileWith({ roles: [role({ company: 'Northwind Data LLC', title: 'Backend Engineer' })] })
  const issues = checkProfile(profile, RESUME).filter((i) => i.severity === 'error')
  assert.deepEqual(issues, [])
})

test('a hallucinated title is an error even at a real employer', () => {
  const profile = profileWith({ roles: [role({ title: 'VP of Engineering' })] })
  const issues = checkProfile(profile, RESUME).filter((i) => i.severity === 'error')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].field, 'title')
})

test('an invented metric is an error; a reworded real one is not', () => {
  const invented = profileWith({ metrics: [{ roleId: 'r1', value: '73%', claim: 'cost saving' }] })
  assert.equal(checkProfile(invented, RESUME).filter((i) => i.severity === 'error').length, 1)

  const reworded = profileWith({ metrics: [{ roleId: 'r1', value: '40% faster p99', claim: 'checkout' }] })
  assert.deepEqual(checkProfile(reworded, RESUME).filter((i) => i.severity === 'error'), [])
})

test('a metric written with a thousands separator still matches', () => {
  const profile = profileWith({ metrics: [{ roleId: 'r2', value: '2.4M events/day', claim: 'ingestion' }] })
  assert.deepEqual(checkProfile(profile, RESUME).filter((i) => i.severity === 'error'), [])
})

test('an unstated skill is a warning, not an error', () => {
  const profile = profileWith({ skills: ['Rust'] })
  const issues = checkProfile(profile, RESUME)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].severity, 'warning')
})

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: 's1',
    roleId: 'r1',
    competencies: ['scaling'],
    situation: 'Checkout was slow.',
    task: 'Make it fast.',
    action: 'Replaced the synchronous pricing call.',
    result: 'It got faster.',
    metrics: [],
    source: 'resume',
    ...overrides
  }
}

test('a story citing an unverified metric is an error', () => {
  const profile = profileWith({ roles: [role()], metrics: [] })
  const issues = checkStories([story({ metrics: ['92% adoption'] })], profile, RESUME)
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /unverified metric/)
})

test('a story from a gap answer may cite a metric the resume never had', () => {
  // The whole point of the gap scan is to capture what the resume omitted.
  const profile = profileWith({ roles: [role()] })
  const issues = checkStories(
    [story({ source: 'gap-answer', metrics: ['92% adoption'] })],
    profile,
    RESUME
  )
  assert.deepEqual(issues, [])
})

test('a story attached to an unknown role is an error', () => {
  const profile = profileWith({ roles: [role()] })
  const issues = checkStories([story({ roleId: 'r9' })], profile, RESUME)
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /unknown role/)
})

test('pruning drops the fabricated role and keeps the real one', () => {
  const profile = profileWith({
    roles: [role(), role({ id: 'r9', company: 'Globex Corporation', title: 'Architect' })],
    metrics: [
      { roleId: 'r1', value: '40%', claim: 'latency' },
      { roleId: 'r9', value: '73%', claim: 'invented' }
    ]
  })
  const stories = [story(), story({ id: 's2', roleId: 'r9' })]

  const pruned = pruneUngrounded(profile, stories, RESUME)

  assert.deepEqual(pruned.profile.roles.map((r) => r.id), ['r1'])
  assert.deepEqual(pruned.profile.metrics.map((m) => m.value), ['40%'])
  assert.ok(pruned.dropped.length > 0)
  // The story survives, detached — the narrative is still the user's own.
  assert.equal(pruned.stories.length, 2)
  assert.equal(pruned.stories[1].roleId, null)
})

test('pruning strips an unverified metric from a mined story but keeps the story', () => {
  const profile = profileWith({ roles: [role()] })
  const pruned = pruneUngrounded(profile, [story({ metrics: ['40%', '92% adoption'] })], RESUME)
  assert.deepEqual(pruned.stories[0].metrics, ['40%'])
})
