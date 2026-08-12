import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LlmClient, StructuredRequest } from './structured-llm.ts'
import {
  COMPETENCIES,
  profilePromptBlock as promptBlock,
  storyIds,
  type ProfileBundle
} from '../shared/profile.ts'
import { contentHash } from './resume-profile.ts'
import {
  answerGap,
  findGaps,
  jobDescriptionBrief,
  MAX_GAP_QUESTIONS,
  normaliseProfile,
  normaliseStories,
  overusedTags,
  runIngest
} from './resume-pipeline.ts'

/**
 * A scripted `LlmClient`. Every test here runs offline with no API key — the
 * pipeline's job is deciding what to do with model output, and that decision
 * logic is exactly what a live model would make untestable.
 */
function fakeLlm(byLabel: Record<string, unknown>): LlmClient & { calls: StructuredRequest[] } {
  const calls: StructuredRequest[] = []
  return {
    calls,
    async structured<T>(request: StructuredRequest): Promise<T> {
      calls.push(request)
      if (!(request.label in byLabel)) throw new Error(`unscripted call: ${request.label}`)
      return byLabel[request.label] as T
    }
  }
}

const RESUME = `
Jordan Reyes — Senior Platform Engineer
Zurich, Switzerland · jordan@example.com

Acme Robotics 2021 – 2024
Senior Platform Engineer
Cut p99 checkout latency by 40% by replacing the synchronous pricing call with a cache.
Led the migration of 30 services to Kubernetes, in Go and Terraform.
Disagreed with my manager on the Q3 roadmap and ran an A/B test to settle it.

Northwind Data 2018 – 2021
Backend Engineer
Built the ingestion pipeline handling 2.4M events per day in Go and Postgres.
Mentored two junior engineers through their first on-call rotation.

Education
BSc Computer Science, ETH Zurich, 2018
`

const EXTRACTED = {
  identity: {
    name: 'Jordan Reyes',
    headline: 'Senior Platform Engineer',
    location: 'Zurich, Switzerland',
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
      stack: ['Go', 'Terraform', 'Kubernetes'],
      summary: 'Owned the checkout platform.'
    },
    {
      id: 'northwind-data',
      company: 'Northwind Data',
      title: 'Backend Engineer',
      start: '2018',
      end: '2021',
      current: false,
      stack: ['Go', 'Postgres'],
      summary: null
    }
  ],
  education: [
    { institution: 'ETH Zurich', credential: 'BSc', field: 'Computer Science', end: '2018' }
  ],
  skills: ['Go', 'Kubernetes'],
  metrics: [
    { roleId: 'acme-robotics', value: '40%', claim: 'p99 checkout latency reduction' },
    { roleId: 'northwind-data', value: '2.4M events per day', claim: 'ingestion throughput' }
  ]
}

function story(
  id: string,
  roleId: string | null,
  tags: string[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    roleId,
    competencies: tags,
    situation: `Situation for ${id}.`,
    task: `Task for ${id}.`,
    action: `Action for ${id}.`,
    result: `Result for ${id}.`,
    metrics: [],
    ...extra
  }
}

const MINED = {
  stories: [
    story('conflict-manager-roadmap', 'acme-robotics', ['conflict', 'influence-without-authority']),
    story('scaling-kubernetes-migration', 'acme-robotics', ['scaling', 'technical-tradeoff'], {
      metrics: ['30 services']
    }),
    story('mentorship-oncall', 'northwind-data', ['mentorship', 'leadership'])
  ]
}

const GAP_QUESTIONS = {
  questions: [
    {
      competency: 'failure',
      question: "Tell me about a project that didn't ship — what happened?"
    },
    {
      competency: 'ambiguity',
      question: 'When did you have to start work with the goal still unclear?'
    },
    { competency: 'deadline-pressure', question: 'When did a date force a hard call?' },
    // Covered already — must be discarded rather than take a slot.
    { competency: 'conflict', question: 'Tell me about a disagreement.' }
  ]
}

function scripted(overrides: Record<string, unknown> = {}): LlmClient & { calls: StructuredRequest[] } {
  return fakeLlm({
    'profile extraction': EXTRACTED,
    'story mining': MINED,
    'gap scan': GAP_QUESTIONS,
    ...overrides
  })
}

const FIXED_NOW = (): Date => new Date('2026-08-09T12:00:00.000Z')

test('a resume produces a sealed, grounded bundle', async () => {
  const { bundle, report } = await runIngest(RESUME, scripted(), { now: FIXED_NOW })

  assert.equal(bundle.version, 1)
  assert.equal(bundle.hash.length, 64)
  assert.equal(bundle.createdAt, '2026-08-09T12:00:00.000Z')
  assert.deepEqual(
    bundle.profile.roles.map((r) => r.company),
    ['Acme Robotics', 'Northwind Data']
  )
  assert.equal(bundle.stories.length, 3)
  assert.deepEqual(
    report.issues.filter((i) => i.severity === 'error'),
    []
  )
})

test('the hash is content-only, so a re-run of the same resume is the same bundle', async () => {
  const first = await runIngest(RESUME, scripted(), { now: FIXED_NOW })
  const second = await runIngest(RESUME, scripted(), {
    // A later run must not change the cache key just because time passed.
    now: () => new Date('2027-01-01T00:00:00.000Z')
  })
  assert.equal(first.bundle.hash, second.bundle.hash)
  assert.notEqual(first.bundle.createdAt, second.bundle.createdAt)
})

test('editing the resume invalidates the hash', async () => {
  const base = await runIngest(RESUME, scripted(), { now: FIXED_NOW })
  const edited = await runIngest(
    RESUME,
    scripted({
      'profile extraction': {
        ...EXTRACTED,
        roles: [{ ...EXTRACTED.roles[0], title: 'Staff Platform Engineer' }]
      }
    }),
    { now: FIXED_NOW }
  )
  assert.notEqual(base.bundle.hash, edited.bundle.hash)
})

test('a hallucinated employer never reaches the bundle', async () => {
  const { bundle, report } = await runIngest(
    RESUME,
    scripted({
      'profile extraction': {
        ...EXTRACTED,
        roles: [
          ...EXTRACTED.roles,
          {
            id: 'globex',
            company: 'Globex Corporation',
            title: 'Principal Architect',
            start: '2016',
            end: '2018',
            current: false,
            stack: [],
            summary: null
          }
        ]
      }
    }),
    { now: FIXED_NOW }
  )

  assert.deepEqual(
    bundle.profile.roles.map((r) => r.company),
    ['Acme Robotics', 'Northwind Data']
  )
  assert.ok(report.dropped.some((d) => d.value === 'Globex Corporation'))
  // And the bundle that survives is itself clean.
  assert.deepEqual(
    report.issues.filter((i) => i.severity === 'error'),
    []
  )
})

test('an invented metric on a real role is dropped', async () => {
  const { bundle } = await runIngest(
    RESUME,
    scripted({
      'profile extraction': {
        ...EXTRACTED,
        metrics: [
          ...EXTRACTED.metrics,
          { roleId: 'acme-robotics', value: '$4.2M saved', claim: 'infrastructure cost' }
        ]
      }
    }),
    { now: FIXED_NOW }
  )
  assert.deepEqual(
    bundle.profile.metrics.map((m) => m.value),
    ['40%', '2.4M events per day']
  )
})

test('gaps are the set difference, with the invention-prone competencies first', () => {
  const stories = normaliseStories(MINED)
  const gaps = findGaps(stories)

  assert.ok(!gaps.includes('conflict'))
  assert.ok(gaps.includes('failure'))
  // failure / ambiguity / influence-without-authority are what a model invents
  // when the resume has none, so they get asked first.
  assert.equal(gaps[0], 'failure')
})

test('gap questions are capped and never ask about a covered competency', async () => {
  const { bundle } = await runIngest(RESUME, scripted(), { now: FIXED_NOW })
  assert.ok(bundle.gaps.length <= MAX_GAP_QUESTIONS)
  assert.deepEqual(
    bundle.gaps.map((g) => g.competency),
    ['failure', 'ambiguity', 'deadline-pressure']
  )
  assert.ok(bundle.gaps.every((g) => g.status === 'open'))
})

test('the gap scan is skipped entirely when the bank covers everything', async () => {
  const llm = scripted({
    'story mining': {
      stories: [
        story('everything', 'acme-robotics', [
          'conflict',
          'failure',
          'leadership',
          'ambiguity',
          'scaling',
          'deadline-pressure',
          'influence-without-authority',
          'technical-tradeoff',
          'mentorship',
          'customer-focus',
          'data-driven-decision',
          'ownership'
        ])
      ]
    }
  })
  const { bundle } = await runIngest(RESUME, llm, { now: FIXED_NOW })

  assert.deepEqual(bundle.gaps, [])
  assert.ok(!llm.calls.some((c) => c.label === 'gap scan'))
})

async function ingestFixture(): Promise<ProfileBundle> {
  const { bundle } = await runIngest(RESUME, scripted(), { now: FIXED_NOW })
  return bundle
}

test('an answered gap becomes a story and a new hash', async () => {
  const before = await ingestFixture()
  const gap = before.gaps[0]

  const result = await answerGap(
    before,
    gap.id,
    'We shipped a rewrite that nobody used, and I killed it after six weeks.',
    fakeLlm({
      'gap answer': {
        usable: true,
        reason: null,
        story: story('failure-rewrite-nobody-used', 'acme-robotics', ['failure'], {
          metrics: ['six weeks']
        })
      }
    }),
    { now: FIXED_NOW }
  )

  assert.equal(result.accepted, true)
  assert.equal(result.bundle.stories.length, before.stories.length + 1)
  assert.notEqual(result.bundle.hash, before.hash)

  const added = result.bundle.stories.at(-1)!
  assert.equal(added.source, 'gap-answer')
  assert.ok(added.competencies.includes('failure'))
  // A gap answer may carry a figure the resume never had — that is the point.
  assert.deepEqual(added.metrics, ['six weeks'])

  const answered = result.bundle.gaps.find((g) => g.id === gap.id)!
  assert.equal(answered.status, 'answered')
  assert.equal(answered.storyId, added.id)
})

test('"I do not have one" is recorded, not invented into a story', async () => {
  const before = await ingestFixture()
  const gap = before.gaps[0]

  const result = await answerGap(
    before,
    gap.id,
    "I can't think of one.",
    fakeLlm({
      'gap answer': { usable: false, reason: 'The candidate had no example to give.', story: null }
    }),
    { now: FIXED_NOW }
  )

  assert.equal(result.accepted, false)
  assert.equal(result.bundle.stories.length, before.stories.length)
  assert.equal(result.bundle.gaps.find((g) => g.id === gap.id)!.status, 'skipped')
  assert.match(result.reason ?? '', /no example/)
})

test('a gap answer colliding with an existing story id is renamed, not merged', async () => {
  const before = await ingestFixture()
  const result = await answerGap(
    before,
    before.gaps[0].id,
    'A story.',
    fakeLlm({
      'gap answer': {
        usable: true,
        reason: null,
        // Deliberately reuses an id already in the bank.
        story: story('conflict-manager-roadmap', 'acme-robotics', ['failure'])
      }
    }),
    { now: FIXED_NOW }
  )

  const ids = result.bundle.stories.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('normalisation makes story ids unique within one mining pass', () => {
  const stories = normaliseStories({
    stories: [story('same-id', null, ['conflict']), story('same-id', null, ['failure'])]
  })
  assert.deepEqual(
    stories.map((s) => s.id),
    ['same-id', 'same-id-2']
  )
})

test('normalisation drops unknown competency tags rather than storing them', () => {
  const [only] = normaliseStories({
    stories: [story('x', null, ['conflict', 'vibes', 'conflict'])]
  })
  assert.deepEqual(only.competencies, ['conflict'])
})

test('a role missing a company or title is discarded', () => {
  const profile = normaliseProfile({
    roles: [
      { id: 'a', company: 'Acme', title: '', current: false, stack: [], summary: null },
      { id: 'b', company: 'Northwind', title: 'Engineer', current: false, stack: [], summary: null }
    ]
  })
  assert.deepEqual(
    profile.roles.map((r) => r.company),
    ['Northwind']
  )
})

test('a metric pointing at a discarded role is detached, not deleted', () => {
  const profile = normaliseProfile({
    roles: [],
    metrics: [{ roleId: 'gone', value: '40%', claim: 'latency' }]
  })
  assert.deepEqual(profile.metrics, [{ roleId: null, value: '40%', claim: 'latency' }])
})

test('the prompt block is byte-identical across calls, so the cache holds', async () => {
  const bundle = await ingestFixture()
  assert.equal(promptBlock(bundle), promptBlock(bundle))
  assert.equal(contentHash(bundle), bundle.hash)
})

test('the prompt block names every story id and forbids inventing one', async () => {
  const bundle = await ingestFixture()
  const block = promptBlock(bundle)
  for (const id of storyIds(bundle)) assert.ok(block.includes(id), `missing ${id}`)
  assert.match(block, /story_id: null/)
  assert.match(block, /must not be fabricated|must not be stated|UNKNOWN/)
})

test('the bundle stays inside its token budget', async () => {
  const { report } = await runIngest(RESUME, scripted(), { now: FIXED_NOW })
  assert.ok(report.estimatedTokens > 0)
  assert.ok(report.estimatedTokens < 6000, `bundle was ${report.estimatedTokens} tokens`)
})

test('a thin bank is reported rather than padded out', async () => {
  const { report } = await runIngest(RESUME, scripted(), { now: FIXED_NOW })
  assert.equal(report.thin, true)
  assert.equal(report.storiesMined, 3)
  assert.equal(report.storiesKept, 3)
})

test('a job description maps questions to stories and flags what nothing covers', async () => {
  const bundle = await ingestFixture()
  const brief = await jobDescriptionBrief(
    bundle,
    'Staff engineer. Must have led incident response.',
    fakeLlm({
      'job description pass': {
        likelyQuestions: [
          {
            question: 'Tell me about a disagreement.',
            storyId: 'conflict-manager-roadmap',
            competency: 'conflict'
          },
          // A story id that is not in the bank must read as "no story".
          {
            question: 'Walk me through an outage.',
            storyId: 'incident-response',
            competency: 'ownership'
          }
        ],
        uncoveredRequirements: [
          { requirement: 'led incident response', note: 'No story covers this.' }
        ]
      }
    })
  )

  assert.equal(brief.likelyQuestions[0].storyId, 'conflict-manager-roadmap')
  assert.equal(brief.likelyQuestions[1].storyId, null)
  assert.equal(brief.uncoveredRequirements.length, 1)
})

test('a tag on nearly every story is reported as no longer selecting anything', () => {
  // The failure this catches, observed on a real resume: `technical-tradeoff`
  // on 17 of 17 mined stories. Every story is individually plausible, so
  // nothing checking one story at a time can see it.
  const saturated = normaliseStories({
    stories: Array.from({ length: 6 }, (_, i) =>
      story(`s${i}`, null, i < 5 ? ['technical-tradeoff'] : ['conflict'])
    )
  })
  assert.deepEqual(
    overusedTags(saturated).map((t) => t.competency),
    ['technical-tradeoff']
  )
})

test('a competency genuinely central to a career is not reported', () => {
  // Half the bank is a real career shape, not a tagging failure. Flagging it
  // would train whoever reads the report to ignore the field.
  const balanced = normaliseStories({
    stories: Array.from({ length: 6 }, (_, i) =>
      story(`s${i}`, null, i < 3 ? ['scaling'] : ['conflict'])
    )
  })
  assert.deepEqual(overusedTags(balanced), [])
})

test('tag saturation is measured per story, not per mention', () => {
  const repeated = normaliseStories({
    stories: [story('a', null, ['conflict', 'conflict']), story('b', null, ['failure'])]
  })
  // `conflict` covers one story of two, not two mentions of three.
  assert.deepEqual(overusedTags(repeated), [])
})

test('an empty bank reports nothing rather than dividing by zero', () => {
  assert.deepEqual(overusedTags([]), [])
})

// --- Progress reporting (desktop addition) ---

test('onPhase fires once per model call, in order, so the label can never lie', async () => {
  const seen: string[] = []
  await runIngest(RESUME, scripted(), { now: FIXED_NOW, onPhase: (p) => seen.push(p) })
  assert.deepEqual(seen, ['mining-profile', 'mining-stories', 'gap-scan'])
})

test('a bank with no gaps never reports a gap scan it did not run', async () => {
  const seen: string[] = []
  // Covers every competency, so `findGaps` returns nothing and the scan is skipped.
  const noGaps = scripted({ 'gap scan': { questions: [] } })
  const full = {
    stories: COMPETENCIES.map((c, i) => ({
      id: `story-${i}`,
      roleId: 'acme-robotics',
      competencies: [c],
      situation: 'Cut p99 checkout latency by 40% at Acme Robotics.',
      task: 'Replace the synchronous pricing call.',
      action: 'Introduced a cache.',
      result: 'Latency fell by 40%.',
      metrics: []
    }))
  }
  await runIngest(RESUME, scripted({ 'story mining': full, ...noGaps }), {
    now: FIXED_NOW,
    onPhase: (p) => seen.push(p)
  })
  assert.ok(!seen.includes('gap-scan'), `gap-scan reported but not run: ${seen.join(', ')}`)
})
