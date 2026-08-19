import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  JOB_CLAIM_RULE,
  JOB_SPEC_BLOCK_LIMIT,
  LIMITS,
  RAW_JD_PROMPT_LIMIT,
  describeJobSpec,
  jobSpecFromStructured,
  jobSpecPromptBlock,
  parseJobSpec,
  parseJobSpecJson,
  rawJobDescriptionBlock,
  verifyRequirement,
  type JobRequirement,
  type JobSpec
} from './job-spec.ts'

/**
 * A short but genuine-looking posting. Realistic text matters here: the whole
 * guarantee is substring containment against the employer's actual words, and
 * a source of "foo bar" would let almost anything through.
 */
const POSTING = `Northwind Data — Senior Platform Engineer (Zurich, hybrid)

We are looking for a senior platform engineer to own the reliability of the
data ingestion platform that every product team at Northwind builds on.

What we are looking for
- 5+ years of experience building backend services in Go or Rust
- Deep hands-on experience running Kubernetes in production
- A track record of owning services end to end, including on-call
- Comfort with Terraform and infrastructure as code

Nice to have
- Experience with Apache Kafka or a similar streaming system
- Exposure to OpenTelemetry and distributed tracing

What you will do
- Run the migration of the ingestion pipeline off the legacy queue
- Set and defend service level objectives together with the product teams
- Mentor two junior engineers on the platform team

About us
We ship small changes daily and we write things down before we build them.
We are remote friendly across Europe and we pay for the travel.
`

const META = { sourceHash: 'b'.repeat(64), createdAt: '2026-08-14T09:00:00.000Z' }

function requirement(overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    id: 'kubernetes-production',
    text: 'Kubernetes in production',
    evidence: 'Deep hands-on experience running Kubernetes in production',
    ...overrides
  }
}

function spec(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    sourceHash: META.sourceHash,
    createdAt: META.createdAt,
    company: 'Northwind Data',
    roleTitle: 'Senior Platform Engineer',
    seniority: 'Senior',
    mustHaves: [requirement()],
    niceToHaves: [],
    responsibilities: [],
    companySignals: [],
    likelyQuestions: [],
    ...overrides
  }
}

test('a requirement whose evidence is really in the posting survives verification', () => {
  const req = requirement()
  assert.equal(verifyRequirement(req, POSTING), req)
})

test('a fabricated requirement is dropped, because it would become a claim the user says aloud', () => {
  // The central guarantee. A posting is a list of skills the user may NOT have,
  // and an unverified requirement is one the employer never wrote — Hue would
  // still draft an answer in which the user claims it, to someone who will ask
  // a follow-up.
  const invented = requirement({
    id: 'aws-certification',
    text: 'AWS Solutions Architect certification',
    evidence: 'Must hold a current AWS Solutions Architect certification'
  })
  assert.equal(verifyRequirement(invented, POSTING), null)
})

test('re-wrapped or re-cased evidence still verifies, since PDF and web paste break lines', () => {
  // A line break in the middle of "running Kubernetes in\nproduction" is a
  // copy-paste artefact, not a fabrication; rejecting it would throw away
  // genuinely grounded requirements from every PDF posting.
  for (const evidence of [
    'Deep hands-on experience running\nKubernetes    in production',
    'DEEP HANDS-ON EXPERIENCE RUNNING KUBERNETES IN PRODUCTION',
    '   Deep hands-on experience running Kubernetes in production   '
  ]) {
    assert.notEqual(verifyRequirement(requirement({ evidence }), POSTING), null, evidence)
  }
})

test('an empty posting or an empty evidence span verifies nothing', () => {
  // Empty evidence must never be read as "trivially contained": every string
  // contains the empty string, so that would wave through every requirement.
  assert.equal(verifyRequirement(requirement(), ''), null)
  assert.equal(verifyRequirement(requirement({ evidence: '' }), POSTING), null)
  assert.equal(verifyRequirement(requirement({ text: '' }), POSTING), null)
})

test('a well-formed response becomes a spec carrying the caller-supplied hash and timestamp', () => {
  const built = jobSpecFromStructured(
    {
      company: 'Northwind Data',
      roleTitle: 'Senior Platform Engineer',
      seniority: 'Senior',
      mustHaves: [
        {
          id: 'go-backend',
          text: '5+ years of backend services in Go or Rust',
          evidence: '5+ years of experience building backend services in Go or Rust'
        },
        requirement()
      ],
      niceToHaves: [
        {
          id: 'kafka',
          text: 'Kafka or similar streaming',
          evidence: 'Experience with Apache Kafka or a similar streaming system'
        }
      ],
      responsibilities: ['Run the migration of the ingestion pipeline off the legacy queue'],
      companySignals: ['We ship small changes daily'],
      likelyQuestions: ['Tell me about an on-call incident you owned end to end.']
    },
    POSTING,
    META
  )
  assert.ok(built)
  assert.equal(built.sourceHash, META.sourceHash)
  assert.equal(built.createdAt, META.createdAt)
  assert.equal(built.company, 'Northwind Data')
  assert.deepEqual(
    built.mustHaves.map((r) => r.id),
    ['go-backend', 'kubernetes-production']
  )
  assert.equal(built.niceToHaves.length, 1)
  assert.equal(built.responsibilities.length, 1)
  assert.equal(built.likelyQuestions.length, 1)
})

test('a response mixing one real and one invented requirement keeps only the real one', () => {
  const built = jobSpecFromStructured(
    {
      mustHaves: [
        requirement(),
        {
          id: 'aws-certification',
          text: 'AWS Solutions Architect certification',
          evidence: 'Must hold a current AWS Solutions Architect certification'
        }
      ]
    },
    POSTING,
    META
  )
  assert.ok(built)
  assert.deepEqual(
    built.mustHaves.map((r) => r.id),
    ['kubernetes-production']
  )
})

test('a response whose requirements are ALL invented yields null rather than a thin spec', () => {
  // Persisting this would put the fabrication into every draft of the
  // interview, so the caller must report the failure instead of storing it.
  const built = jobSpecFromStructured(
    {
      company: 'Northwind Data',
      mustHaves: [
        {
          id: 'aws-certification',
          text: 'AWS Solutions Architect certification',
          evidence: 'Must hold a current AWS Solutions Architect certification'
        }
      ],
      niceToHaves: [
        { id: 'phd', text: 'PhD preferred', evidence: 'A PhD in a related field is preferred' }
      ],
      responsibilities: ['Run the migration of the ingestion pipeline off the legacy queue']
    },
    POSTING,
    META
  )
  assert.equal(built, null)
})

test('a raw JSON string is accepted as well as an object, since json_object mode returns text', () => {
  const json = JSON.stringify({ mustHaves: [requirement()] })
  const built = jobSpecFromStructured(json, POSTING, META)
  assert.ok(built)
  assert.equal(built.mustHaves[0].text, 'Kubernetes in production')
  assert.equal(jobSpecFromStructured('not json at all', POSTING, META), null)
})

test('two requirements sharing an id end up with distinct ids, or a later lookup returns the wrong one', () => {
  const built = jobSpecFromStructured(
    {
      mustHaves: [
        requirement({ id: 'kubernetes' }),
        requirement({
          id: 'kubernetes',
          text: 'Terraform and infrastructure as code',
          evidence: 'Comfort with Terraform and infrastructure as code'
        })
      ]
    },
    POSTING,
    META
  )
  assert.ok(built)
  assert.deepEqual(
    built.mustHaves.map((r) => r.id),
    ['kubernetes', 'kubernetes-2']
  )
})

test('a requirement the model gave no id is slugged from its text rather than dropped', () => {
  const built = jobSpecFromStructured(
    { mustHaves: [{ text: 'Kubernetes in production', evidence: requirement().evidence }] },
    POSTING,
    META
  )
  assert.ok(built)
  assert.equal(built.mustHaves.length, 1)
  assert.match(built.mustHaves[0].id, /^[a-z0-9-]+$/)
  assert.equal(built.mustHaves[0].id, 'kubernetes-in-production')
})

test('the literal words "null", "unknown" and "N/A" become null, not a company called Unknown', () => {
  // A model asked for null often writes the word instead, and the identity
  // fields go straight to the UI and to the prompt heading.
  const built = jobSpecFromStructured(
    { company: 'unknown', roleTitle: 'N/A', seniority: 'null', mustHaves: [requirement()] },
    POSTING,
    META
  )
  assert.ok(built)
  assert.equal(built.company, null)
  assert.equal(built.roleTitle, null)
  assert.equal(built.seniority, null)
})

test('bounds are enforced: extra requirements truncated, long text clipped, duplicates dropped', () => {
  // This block rides on EVERY draft on the hot path, so an unbounded spec is a
  // latency regression on every answer of the interview.
  const skills = [
    'Go',
    'Rust',
    'Kubernetes',
    'Terraform',
    'Kafka',
    'PostgreSQL',
    'gRPC',
    'Prometheus',
    'OpenTelemetry',
    'Envoy',
    'Bazel',
    'ArgoCD',
    'Pulumi',
    'Redis'
  ]
  const source = skills
    .map((s) => `- Production experience with ${s} on a platform team`)
    .join('\n')
  const built = jobSpecFromStructured(
    {
      mustHaves: skills.map((s) => ({
        id: s.toLowerCase(),
        text: `Production experience with ${s}`,
        evidence: `Production experience with ${s} on a platform team`
      })),
      responsibilities: [
        'Own the platform',
        'own the platform',
        '  Own   the  platform  ',
        'Mentor two junior engineers'
      ]
    },
    source,
    META
  )
  assert.ok(built)
  // 14 verified must-haves, capped at 12.
  assert.equal(built.mustHaves.length, 12)
  // Case- and whitespace-insensitive de-duplication of plain string lists.
  assert.deepEqual(built.responsibilities, ['Own the platform', 'Mentor two junior engineers'])

  const longText = `Kubernetes ${'very '.repeat(80)}in production`
  const clipped = jobSpecFromStructured(
    { mustHaves: [requirement({ text: longText })] },
    POSTING,
    META
  )
  assert.ok(clipped)
  // Asserted against the constant rather than a copy of its value: the cap is
  // tuned against the hot-path budget and a literal here would silently stop
  // testing the real bound the first time it moves.
  assert.equal(clipped.mustHaves[0].text.length, LIMITS.requirementText)
})

test('the spec JSON is read out of bare output, out of a fence, and out of surrounding prose', () => {
  // Half these calls run in json_object mode, where a markdown fence is a
  // formatting slip rather than a refusal, and throwing the reply away would
  // lose an otherwise perfectly good analysis.
  const body = '{"company":"Northwind Data","mustHaves":[]}'
  assert.deepEqual(parseJobSpecJson(body), { company: 'Northwind Data', mustHaves: [] })
  assert.deepEqual(parseJobSpecJson('```json\n' + body + '\n```'), {
    company: 'Northwind Data',
    mustHaves: []
  })
  assert.deepEqual(parseJobSpecJson(`Sure — here is the analysis:\n${body}\nLet me know.`), {
    company: 'Northwind Data',
    mustHaves: []
  })
})

test('unusable output and a top-level array parse to null instead of a half-read spec', () => {
  assert.equal(parseJobSpecJson(''), null)
  assert.equal(parseJobSpecJson('I could not find a job posting in that text.'), null)
  assert.equal(parseJobSpecJson('{"company":"Northwind Data",'), null)
  // An array is a list of something, not a spec; reading raw.mustHaves off it
  // would silently produce an empty spec.
  assert.equal(parseJobSpecJson('["5+ years of Kubernetes"]'), null)
})

test('a serialised spec round-trips out of settings unchanged', () => {
  const original = spec({
    niceToHaves: [requirement({ id: 'kafka', text: 'Kafka', evidence: 'Apache Kafka' })],
    responsibilities: ['Run the migration'],
    companySignals: ['Ships small changes daily'],
    likelyQuestions: ['Tell me about an on-call incident.']
  })
  assert.deepEqual(parseJobSpec(JSON.stringify(original)), original)
})

test('an absent, malformed or shapeless stored spec yields null rather than throwing', () => {
  // This runs on settings load; a throw here would take the whole app down on
  // a value the user cannot see or edit.
  assert.equal(parseJobSpec(''), null)
  assert.equal(parseJobSpec('{"sourceHash":"abc",'), null)
  assert.equal(parseJobSpec('null'), null)
  // The requirement arrays are the spec; an object without them is some other
  // object that happened to be stored under this key.
  assert.equal(parseJobSpec('{"sourceHash":"abc","createdAt":"2026-08-14T09:00:00.000Z"}'), null)
  assert.equal(parseJobSpec(JSON.stringify({ mustHaves: [] })), null)
})

test('the prompt block carries the never-claim rule verbatim, alongside the requirement text', () => {
  const block = jobSpecPromptBlock(spec())
  assert.ok(block.includes(JOB_CLAIM_RULE))
  assert.ok(block.includes('Kubernetes in production'))
  assert.ok(block.includes('Senior Platform Engineer at Northwind Data'))
})

test('evidence spans never reach the prompt, because provenance is for us, not for the model', () => {
  // Evidence exists so verifyRequirement can prove the requirement came from
  // the posting. Sending it would double the block for no benefit and hand the
  // model more employer language to echo as the user's own.
  const block = jobSpecPromptBlock(spec())
  assert.ok(!block.includes('Deep hands-on experience running Kubernetes in production'))
})

test('a maximal spec still fits a sane budget, since this block rides on every draft', () => {
  const filled = spec({
    mustHaves: Array.from({ length: 12 }, (_, i) => ({
      id: `must-${i}`,
      text: `Production experience with platform tool number ${i}`,
      evidence: 'unused'
    })),
    niceToHaves: Array.from({ length: 8 }, (_, i) => ({
      id: `nice-${i}`,
      text: `Familiarity with streaming system number ${i}`,
      evidence: 'unused'
    })),
    responsibilities: Array.from({ length: 8 }, (_, i) => `Own and operate service number ${i}`),
    companySignals: Array.from({ length: 5 }, (_, i) => `We value engineering habit number ${i}`),
    likelyQuestions: Array.from({ length: 8 }, (_, i) => `Tell me about incident number ${i}.`)
  })
  const block = jobSpecPromptBlock(filled)
  assert.ok(block.length <= JOB_SPEC_BLOCK_LIMIT, `block was ${block.length} chars`)
})

test('the WORST-CASE spec is truncated to the budget, keeping the rule and the requirements', () => {
  // The per-item caps alone do not bound this: twelve must-haves and eight
  // nice-to-haves at full length exceed the budget before a single
  // responsibility is added. So the block truncates, and what it must never
  // truncate away is the claim rule — a block that dropped it would be worse
  // than no block, leaving the employer's skill list in the prompt with
  // nothing left saying the user does not necessarily have any of it.
  const pad = (prefix: string, n: number): string =>
    `${prefix} ${'x'.repeat(LIMITS.requirementText)}`.slice(0, LIMITS.requirementText) + n
  const huge = spec({
    mustHaves: Array.from({ length: 12 }, (_, i) => ({
      id: `must-${i}`,
      text: pad('must', i),
      evidence: 'unused'
    })),
    niceToHaves: Array.from({ length: 8 }, (_, i) => ({
      id: `nice-${i}`,
      text: pad('nice', i),
      evidence: 'unused'
    })),
    responsibilities: Array.from({ length: 8 }, (_, i) => pad('own', i)),
    companySignals: Array.from({ length: 5 }, (_, i) => pad('value', i)),
    likelyQuestions: Array.from({ length: 8 }, (_, i) => pad('question', i))
  })

  const block = jobSpecPromptBlock(huge)
  assert.ok(block.length <= JOB_SPEC_BLOCK_LIMIT, `block was ${block.length} chars`)
  assert.ok(block.includes(JOB_CLAIM_RULE))
  // Requirements outrank colour: what the employer asks for survives, and the
  // sections that only shade the answer are the ones that go.
  assert.ok(block.includes('## The employer requires'))
  assert.ok(!block.includes('## What this employer says it values'))
})

test('a section is never opened with no items beneath it', () => {
  // A bare heading is pure noise in a prompt, and the budget makes it a real
  // possibility: the heading can fit when the first item does not.
  const block = jobSpecPromptBlock(
    spec({ mustHaves: [], niceToHaves: [], responsibilities: [], companySignals: [] })
  )
  assert.ok(!block.includes('## The employer requires'))
  assert.ok(!block.includes('## What the job actually involves'))
})

test('the prompt block is stable across calls, so an identical spec never re-primes the cache', () => {
  assert.equal(jobSpecPromptBlock(spec()), jobSpecPromptBlock(spec()))
})

test('an un-analysed posting still gets the never-claim rule, which is the path most users take', () => {
  // Someone who pastes a posting a minute before the call and never presses
  // Analyse has the model looking at the WHOLE posting, so it needs the guard
  // at least as much as the structured block does.
  const block = rawJobDescriptionBlock(POSTING)
  assert.ok(block.includes(JOB_CLAIM_RULE))
  assert.ok(block.includes('Senior Platform Engineer'))
})

test('an empty or whitespace-only posting produces no block at all', () => {
  assert.equal(rawJobDescriptionBlock(''), '')
  assert.equal(rawJobDescriptionBlock('   \n\t  '), '')
})

test('an over-long posting is truncated and says so, rather than quietly losing its tail', () => {
  const huge = `${'A long sentence about the ingestion platform. '.repeat(400)}FINAL LINE`
  assert.ok(huge.length > RAW_JD_PROMPT_LIMIT)
  const block = rawJobDescriptionBlock(huge)
  assert.ok(block.includes('[posting truncated]'))
  assert.ok(!block.includes('FINAL LINE'))
  assert.ok(block.length < RAW_JD_PROMPT_LIMIT + JOB_CLAIM_RULE.length + 200)
})

test('the settings summary counts requirements and gets the singular right', () => {
  assert.equal(
    describeJobSpec(spec()),
    'Senior Platform Engineer at Northwind Data — 1 requirement found'
  )
  assert.equal(
    describeJobSpec(spec({ niceToHaves: [requirement({ id: 'kafka' })] })),
    'Senior Platform Engineer at Northwind Data — 2 requirements found'
  )
  assert.equal(
    describeJobSpec(spec({ roleTitle: null, company: null, mustHaves: [] })),
    'Role — 0 requirements found'
  )
})

// The evidence containment check used to live in `cuesheet.ts` and was imported
// here. These pin its behaviour through `verifyRequirement`, the public API that
// depends on it, so the move out of that module cannot silently weaken it.
const posting =
  'We are looking for an engineer to own our billing integration. ' +
  'Five years of experience with distributed systems required.'

test('a requirement whose evidence is verbatim in the posting is kept', () => {
  const req = {
    id: 'billing',
    text: 'Own billing integration',
    evidence: 'own our billing integration'
  }
  assert.deepEqual(verifyRequirement(req, posting), req)
})

test('a requirement whose evidence was composed rather than quoted is dropped', () => {
  const req = { id: 'k8s', text: 'Kubernetes', evidence: 'deep Kubernetes expertise required' }
  assert.equal(verifyRequirement(req, posting), null)
})

test('re-wrapped whitespace and case do not reject real evidence', () => {
  const req = {
    id: 'exp',
    text: 'Five years',
    evidence: 'Five years of\nexperience   with distributed systems'
  }
  assert.deepEqual(verifyRequirement(req, posting), req)
})
