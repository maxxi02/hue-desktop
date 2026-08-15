import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderError } from './structured-llm-openai.ts'
import type { LlmClient, StructuredRequest } from './structured-llm.ts'
import { analyzeJobDescription } from './job-spec-ingest.ts'

/**
 * A scripted `LlmClient`, as in `resume-pipeline.test.ts`. Everything here runs
 * offline with no key: what this module is actually responsible for is deciding
 * what to do with the model's reply, and a live model is exactly what would make
 * that decision untestable.
 */
function fakeLlm(reply: unknown): LlmClient & { calls: StructuredRequest[] } {
  const calls: StructuredRequest[] = []
  return {
    calls,
    async structured<T>(request: StructuredRequest): Promise<T> {
      calls.push(request)
      if (reply instanceof Error) throw reply
      return reply as T
    }
  }
}

const POSTING = `Northwind Analytics — Senior Backend Engineer (Berlin, hybrid)

We are a twelve-person team building the reporting layer that our customers open
every Monday morning. We ship small and we review every change.

What we require:
- 5+ years building production services in Go or Java
- Strong experience with PostgreSQL, including query tuning under load
- You must be comfortable owning a service end to end, including on-call

Nice to have:
- Experience with Kubernetes in a production environment
- Familiarity with dbt or a similar analytics transformation tool

What you will do:
- Own the ingestion pipeline that moves customer events into the warehouse
- Work directly with two data analysts to shape the reporting schema
- Take part in a weekly on-call rotation shared across the team

We care about writing things down, and we would rather fix the cause than the symptom.`

/** Every `evidence` below is a literal span of POSTING — that is the point. */
const GOOD_REPLY = {
  company: 'Northwind Analytics',
  roleTitle: 'Senior Backend Engineer',
  seniority: 'Senior',
  mustHaves: [
    {
      id: 'go-or-java',
      text: 'Production Go or Java',
      evidence: '5+ years building production services in Go or Java'
    },
    {
      id: 'postgres-tuning',
      text: 'PostgreSQL query tuning',
      evidence: 'Strong experience with PostgreSQL, including query tuning under load'
    },
    {
      id: 'service-ownership',
      text: 'End-to-end service ownership',
      evidence: 'You must be comfortable owning a service end to end, including on-call'
    }
  ],
  niceToHaves: [
    {
      id: 'kubernetes',
      text: 'Kubernetes in production',
      evidence: 'Experience with Kubernetes in a production environment'
    }
  ],
  responsibilities: [
    'Own the ingestion pipeline that moves customer events into the warehouse',
    'Work directly with two data analysts to shape the reporting schema'
  ],
  companySignals: ['We ship small and we review every change', 'We care about writing things down'],
  likelyQuestions: ['Tell me about a Postgres query you had to tune under load.']
}

/** Progress must never go backwards; a bar that does is a bar nobody trusts. */
interface Progress {
  phase: string
  pct: number
}

function progressRecorder(): { seen: Progress[]; on: (p: Progress) => void } {
  const seen: Progress[] = []
  return { seen, on: (p) => seen.push(p) }
}

test('a posting and a well-formed reply produce a grounded spec', async () => {
  const llm = fakeLlm(GOOD_REPLY)
  const progress = progressRecorder()

  const spec = await analyzeJobDescription(POSTING, progress.on, llm)

  assert.equal(spec.company, 'Northwind Analytics')
  assert.equal(spec.roleTitle, 'Senior Backend Engineer')
  assert.equal(spec.seniority, 'Senior')
  assert.deepEqual(
    spec.mustHaves.map((r) => r.id),
    ['go-or-java', 'postgres-tuning', 'service-ownership']
  )
  assert.deepEqual(
    spec.niceToHaves.map((r) => r.id),
    ['kubernetes']
  )
  assert.equal(spec.responsibilities.length, 2)
  assert.equal(spec.companySignals.length, 2)
  assert.equal(spec.likelyQuestions.length, 1)

  // sha256 of the trimmed posting, so the UI can tell a stale spec from a fresh one.
  assert.equal(spec.sourceHash.length, 64)
  assert.ok(spec.createdAt.length > 0)

  // One call, not a pipeline — a posting is small enough to read in one pass.
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].maxTokens, 4000)
  // DeepSeek's json_object mode refuses a prompt that never says "json".
  assert.match(llm.calls[0].system, /json/)

  const pcts = progress.seen.map((p) => p.pct)
  assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b))
  assert.equal(pcts.at(-1), 100)
})

test('a fabricated requirement is dropped and the genuine one survives', async () => {
  // THE CENTRAL GUARANTEE OF THIS MODULE. The failure it prevents is not a
  // cosmetic one: a requirement the employer never wrote would sit in the
  // prompt on every draft, in confident employer language, and become something
  // the user claims out loud to someone who will ask a follow-up. Containment
  // against the source text is the only check that cannot itself be wrong.
  const llm = fakeLlm({
    ...GOOD_REPLY,
    mustHaves: [
      {
        id: 'postgres-tuning',
        text: 'PostgreSQL query tuning',
        evidence: 'Strong experience with PostgreSQL, including query tuning under load'
      },
      {
        id: 'aws-certification',
        text: 'AWS certification',
        // Plausible for a role like this, and nowhere in the posting.
        evidence: 'Must hold a current AWS Solutions Architect certification'
      }
    ],
    niceToHaves: []
  })

  const spec = await analyzeJobDescription(POSTING, () => {}, llm)

  assert.deepEqual(
    spec.mustHaves.map((r) => r.id),
    ['postgres-tuning']
  )
  assert.ok(!JSON.stringify(spec).includes('AWS'))
})

test('a reply whose requirements are all fabricated rejects rather than returning an empty spec', async () => {
  // An empty spec would be the worst available outcome: the UI reports success,
  // the user stops worrying about the posting, and nothing shapes any draft.
  const llm = fakeLlm({
    ...GOOD_REPLY,
    mustHaves: [
      { id: 'aws', text: 'AWS certification', evidence: 'Must hold an AWS certification' },
      { id: 'phd', text: 'PhD', evidence: 'A PhD in computer science is required' }
    ],
    niceToHaves: [{ id: 'rust', text: 'Rust', evidence: 'Rust experience is a plus' }]
  })

  await assert.rejects(
    () => analyzeJobDescription(POSTING, () => {}, llm),
    /traced back to the posting/
  )
})

test('empty or too-short input rejects without spending a model call', async () => {
  const empty = fakeLlm(GOOD_REPLY)
  await assert.rejects(
    () => analyzeJobDescription('   \n  ', () => {}, empty),
    /doesn't look like a job posting/
  )
  assert.equal(empty.calls.length, 0)

  const stub = fakeLlm(GOOD_REPLY)
  await assert.rejects(
    () => analyzeJobDescription('Senior Backend Engineer', () => {}, stub),
    /doesn't look like a job posting/
  )
  assert.equal(stub.calls.length, 0)
})

test('a provider quota failure surfaces the friendly message, not the raw body', async () => {
  const raw = JSON.stringify({
    error: {
      message:
        'Rate limit reached for model gpt-oss-120b in organization org_01abc on tokens per minute (TPM): Limit 8000, Used 0, Requested 11423.',
      type: 'tokens',
      code: 'rate_limit_exceeded'
    }
  })
  const llm = fakeLlm(new ProviderError(429, raw))

  await assert.rejects(
    () => analyzeJobDescription(POSTING, () => {}, llm),
    (err: Error) => {
      assert.match(err.message, /different Ingest provider in Settings/)
      // The organisation id and the token arithmetic must not reach the user.
      assert.ok(!err.message.includes('org_01abc'))
      assert.ok(!err.message.includes('11423'))
      return true
    }
  )
})
