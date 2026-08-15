// src/main/job-spec-ingest.ts
/**
 * Job posting ingest: raw pasted text in, a verified `JobSpec` out.
 *
 * One model call, not a pipeline. A résumé is a whole career and needs the
 * extract → mine → gap-scan flow in `resume-pipeline.ts`; a posting is 1–2k
 * words and fits in a single request with room to spare. Splitting it would buy
 * nothing and cost the user three round trips instead of one.
 *
 * This module deliberately touches neither settings nor disk. The IPC layer
 * decides whether to persist the result — which matters, because the honest
 * failure mode here is "nothing in the reply traced back to your posting", and
 * that must reach the user as an error rather than as a stored spec with an
 * empty requirement list that quietly does nothing for every draft afterwards.
 *
 * The grounding direction is the one described at the top of
 * `../shared/job-spec.ts`: the risk is not a fabricated employer, it is a
 * fabricated REQUIREMENT — a skill the posting never asked for, sitting in the
 * prompt in confident employer language, waiting to become a claim the user
 * makes out loud. `jobSpecFromStructured` drops any requirement whose evidence
 * is not literally in the posting, and this file is careful never to route
 * around it.
 */
import { createHash } from 'node:crypto'
import { jobSpecFromStructured, type JobSpec } from '../shared/job-spec.ts'
import type { LlmClient } from './structured-llm.ts'
// `clientForSettings` and `quotaMessage` are imported lazily inside
// `analyzeJobDescription` rather than at module scope. `clientForSettings`
// reaches `./settings`, which pulls in real Electron `app`/`safeStorage`
// bindings; a static import here would drag Electron's runtime into every
// `node --test` run of this module and take the offline tests with it. The
// `import type` above is erased at runtime, so it costs nothing.

/**
 * Below this, it is not a posting.
 *
 * The number is arbitrary but the check is not: the common accident is pasting
 * a job TITLE, or an empty clipboard, and spending a model call plus twenty
 * seconds to be told there were no requirements is a worse answer than saying
 * so immediately.
 */
const MIN_POSTING_CHARS = 80

/**
 * The shape the provider must return.
 *
 * Every object carries `additionalProperties: false` and a complete `required`
 * array because the strict `json_schema` dialect demands both. Lengths are
 * bounded in `../shared/job-spec.ts` rather than here — `minItems`/`maxItems`
 * are not enforced by the dialect, and half these calls run in `json_object`
 * mode where the schema is a suggestion anyway.
 *
 * The three identity fields are nullable in the schema itself, so a posting
 * that never names the company produces a null rather than the model's best
 * guess at one.
 */
const JOB_SPEC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'company',
    'roleTitle',
    'seniority',
    'mustHaves',
    'niceToHaves',
    'responsibilities',
    'companySignals',
    'likelyQuestions'
  ],
  properties: {
    company: { type: ['string', 'null'] },
    roleTitle: { type: ['string', 'null'] },
    seniority: { type: ['string', 'null'] },
    mustHaves: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'evidence'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          evidence: { type: 'string' }
        }
      }
    },
    niceToHaves: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'evidence'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          evidence: { type: 'string' }
        }
      }
    },
    responsibilities: { type: 'array', items: { type: 'string' } },
    companySignals: { type: 'array', items: { type: 'string' } },
    likelyQuestions: { type: 'array', items: { type: 'string' } }
  }
}

/**
 * The prompt.
 *
 * The load-bearing sentence is the one about evidence. Verification is
 * containment — `verifyRequirement` checks the evidence span is literally in
 * the posting — so the model is told the consequence rather than merely the
 * rule: an invented requirement is not a risky requirement, it is a DISCARDED
 * one, and inventing it only loses the slot. Stating the mechanism is what
 * makes the instruction self-enforcing; "be accurate" is not.
 *
 * The lowercase word "json" appears deliberately: DeepSeek's `json_object` mode
 * refuses any request whose prompt does not contain it, and DeepSeek is one of
 * the configured providers.
 */
const SYSTEM = `You read a job posting and extract what it asks for. You are an extractor, not a writer. Everything you return must already be in the posting; you never compose a requirement the employer did not write.

Return json with these fields:
- company: the employer's name, or null if the posting does not name one.
- roleTitle: the title of the role, or null.
- seniority: the level named by the posting (for example "Senior", "Staff", "Entry level"), or null if it does not state one.
- mustHaves: the requirements stated as required, must-have, or essential.
- niceToHaves: the requirements stated as preferred, desirable, a bonus, or a plus.
- responsibilities: what this person will actually do day to day, in the posting's own terms. Short lines.
- companySignals: cues about the product, the team, or the values this employer states — the things a candidate's answer could honestly echo back.
- likelyQuestions: questions an interviewer FOR THIS POSTING would plausibly ask, derived from the requirements and responsibilities above. These are questions, not answers.

Each entry in mustHaves and niceToHaves is an object with three string fields:
- id: a short kebab-case slug, unique across both lists.
- text: the requirement in a few words — a short phrase naming it, not a sentence.
- evidence: the span of the posting this requirement came from, COPIED VERBATIM. Select a span of the posting; never paraphrase, summarise, tidy, or translate it.

The evidence rule is checked, not trusted. Every requirement whose evidence is not literally present in the posting text is DISCARDED before anyone sees it. So inventing a requirement does not smuggle it through — it only loses you that requirement. If the posting does not ask for something, leave it out; a short accurate list is the correct answer to a short posting.

Do not infer requirements from what roles like this one usually need. Do not restate the same requirement in both lists.`

/**
 * Analyse a pasted posting into a verified `JobSpec`.
 *
 * `client` is the test seam: pass a scripted `LlmClient` and the whole function
 * runs offline, with no key, no network, and nothing importing Electron.
 */
export async function analyzeJobDescription(
  text: string,
  onProgress: (p: { phase: string; pct: number }) => void,
  client?: LlmClient
): Promise<JobSpec> {
  const source = text.trim()
  if (source.length < MIN_POSTING_CHARS) {
    // Thrown before the client is even resolved, so a mis-paste costs nothing —
    // not a request, not a key check, not the wait.
    throw new Error("That doesn't look like a job posting — paste the full text.")
  }

  onProgress({ phase: 'Reading the posting', pct: 15 })

  const { clientForSettings, quotaMessage } = await import('./structured-llm.ts')
  const llm = client ?? (await clientForSettings('ingest'))

  onProgress({ phase: 'Extracting requirements', pct: 45 })
  let response: unknown
  try {
    response = await llm.structured<unknown>({
      label: 'job posting',
      system: SYSTEM,
      schema: JOB_SPEC_SCHEMA,
      // A posting is an order of magnitude smaller than a résumé, and the
      // output is a bounded list of phrases rather than a story bank.
      maxTokens: 4000,
      user: source
    })
  } catch (err) {
    // A quota failure reaches the renderer as the provider's raw JSON body
    // otherwise — organisation ids and token arithmetic, in a status line,
    // minutes before an interview. Rethrown rather than swallowed: this still
    // failed, and the caller must not persist anything.
    const quota = quotaMessage(err)
    throw quota ? new Error(quota) : err
  }

  onProgress({ phase: 'Checking against the posting', pct: 85 })
  const spec = jobSpecFromStructured(response, source, {
    sourceHash: createHash('sha256').update(source).digest('hex'),
    createdAt: new Date().toISOString()
  })

  if (!spec) {
    // Every requirement failed its evidence check, or the reply was unusable.
    // Returning an empty spec here would be the worst outcome available: the UI
    // would show a successful analysis, the user would stop worrying about the
    // posting, and every draft for the rest of the interview would be shaped by
    // nothing at all.
    throw new Error(
      "Nothing in the model's reply could be traced back to the posting text, so there is " +
        'no analysis to keep. Check you pasted the whole posting, then try again.'
    )
  }

  onProgress({ phase: 'Done', pct: 100 })
  return spec
}
