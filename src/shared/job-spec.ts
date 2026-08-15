/**
 * The `JobSpec` — the job posting the user is interviewing against, structured.
 *
 * Hue already knew two things about an interview: `jobTitle`, one line, and the
 * candidate's `ProfileBundle`. It knew nothing about the role, so a
 * Kubernetes-heavy platform posting and a React-heavy product posting produced
 * the same answer to "tell me about a hard technical decision" — the strongest
 * story in the bank rather than the one this employer is measuring.
 *
 * ## The grounding problem runs the OTHER way here
 *
 * `resume-grounding.ts` defends against a model inventing the candidate's
 * history. A posting inverts that risk. It is a list of skills the candidate may
 * not have, sitting in the prompt, written in confident employer language — and
 * the failure to prevent is Hue reading "5+ years Kubernetes" off the posting
 * and drafting an answer in which the user claims it. That is worse than a
 * generic answer: it is a lie the user says out loud, to someone who will ask a
 * follow-up.
 *
 * Two guards, strongest first:
 *
 * 1. **Evidence spans.** Every requirement carries `evidence`, a verbatim span
 *    of the posting. `verifyRequirement` checks it is literally present in the
 *    source and drops the requirement when it is not, so the list cannot hold a
 *    requirement the employer never wrote. Same mechanism as `verifyCard` in
 *    `./cuesheet.ts`, and for the same reason: containment is the only kind of
 *    grounding check that cannot itself be wrong.
 * 2. **Provenance in the prompt.** `jobSpecPromptBlock` states that everything
 *    in it is what the employer WANTS, never what the user HAS, and that a
 *    requirement may only be spoken as experience when it also appears in the
 *    candidate profile. That block is always placed after the profile block so
 *    the reference resolves.
 *
 * Everything in this file is pure and runs under plain `node --test`.
 */

import { scriptIsExtractive as isVerbatimSpan } from './cuesheet.ts'

export interface JobRequirement {
  /** Short kebab-case slug, unique within the spec. */
  id: string
  /** The requirement in a few words — what the prompt and the UI show. */
  text: string
  /**
   * The span of the posting this was taken from, verbatim.
   *
   * Never shown to the user and never sent to the model. It exists so
   * `verifyRequirement` can prove the requirement came from the posting rather
   * than from the model's idea of what such a posting usually says.
   */
  evidence: string
}

export interface JobSpec {
  /** sha256 of the source text, so the UI can tell a stale spec from a fresh one. */
  sourceHash: string
  createdAt: string
  company: string | null
  roleTitle: string | null
  seniority: string | null
  mustHaves: JobRequirement[]
  niceToHaves: JobRequirement[]
  /** What the person will actually do, in the posting's own terms. */
  responsibilities: string[]
  /** Values, product, or team cues worth echoing back in an answer. */
  companySignals: string[]
  /** Questions this posting implies the interviewer will ask. */
  likelyQuestions: string[]
}

/**
 * Bounds, enforced here rather than in the JSON schema.
 *
 * The strict `json_schema` dialect does not enforce `maxItems` or `maxLength`,
 * and half these calls run in `json_object` mode where the schema is a
 * suggestion anyway. This block rides on EVERY draft on the hot path, so an
 * unbounded one is a latency regression on every answer of the interview.
 */
export const LIMITS = {
  mustHaves: 12,
  niceToHaves: 8,
  responsibilities: 8,
  companySignals: 5,
  likelyQuestions: 8,
  /** Per-item character caps. A requirement is a phrase, not a paragraph. */
  requirementText: 120,
  line: 180,
  identity: 120
} as const

/**
 * Hard ceiling on the assembled prompt block, in characters.
 *
 * The per-item caps above bound the realistic case but not the worst one:
 * twelve must-haves and eight nice-to-haves at their full length is already
 * past this on its own, before a single responsibility is added. Per-item
 * bounds alone therefore make the hot-path cost *probable* rather than
 * *guaranteed*, and this block is on every draft of the interview.
 *
 * So the block is assembled in priority order and stops when the budget runs
 * out. What survives truncation is the part that changes the answer — the
 * claim rule, the role, what the employer requires, and what the job actually
 * involves. What gets dropped first is the material that only colours it.
 */
export const JOB_SPEC_BLOCK_LIMIT = 3000

/** Raw posting text carried into the prompt when no analysis has been run. */
export const RAW_JD_PROMPT_LIMIT = 4000

/** What the IPC boundary will accept as a posting. Bounded: it crosses processes. */
export const JOB_DESCRIPTION_LIMIT = 20_000

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function nullableString(value: unknown): string | null {
  const text = clean(value, LIMITS.identity)
  // A model asked for null often writes the word instead. Treated as the null
  // it meant, rather than shown to the user as a company called "Unknown".
  if (!text || /^(null|none|unknown|n\/?a|not specified)$/i.test(text)) return null
  return text
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    const text = clean(item, LIMITS.line)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length === max) break
  }
  return out
}

/** Fallback id for a requirement the model gave an unusable one. */
function slugify(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || `requirement-${index + 1}`
}

/**
 * Keep the requirement only if its evidence is really in the posting.
 *
 * Returns null rather than a blanked requirement: unlike a cue card, which
 * degrades usefully when one cue is dropped, a requirement with no provenance
 * has nothing left worth showing. Whitespace is normalised on both sides
 * because PDF and web copy-paste re-wrap lines, and a line break in the middle
 * of "5+ years of\nexperience" is not a fabrication.
 */
export function verifyRequirement(req: JobRequirement, source: string): JobRequirement | null {
  if (!req.text) return null
  if (!req.evidence) return null
  return isVerbatimSpan(req.evidence, source) ? req : null
}

function requirementList(value: unknown, source: string, max: number): JobRequirement[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: JobRequirement[] = []

  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Partial<JobRequirement>
    const text = clean(raw.text, LIMITS.requirementText)
    const evidence = clean(raw.evidence, LIMITS.line)
    if (!text) continue

    const verified = verifyRequirement({ id: clean(raw.id, 60), text, evidence }, source)
    if (!verified) continue

    // Ids must be unique for the same reason cue card ids must: something
    // downstream will one day look one up, and a duplicate turns a correct
    // lookup into the wrong answer silently.
    let id = verified.id || slugify(text, index)
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }
    seen.add(id)

    out.push({ id, text, evidence })
    if (out.length === max) break
  }
  return out
}

/**
 * Read a spec out of the model's reply, tolerating fences and prose.
 *
 * Half these calls run in `json_object` mode, where nothing constrains
 * generation and a markdown fence is a formatting slip rather than a refusal.
 * Returns null on unusable output; the caller reports that honestly instead of
 * persisting a half-parsed spec.
 */
export function parseJobSpecJson(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const braced = trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)

  for (const candidate of [trimmed, fenced?.[1], braced]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next shape.
    }
  }
  return null
}

/**
 * Normalise, verify, bound and de-duplicate a model response into a `JobSpec`.
 *
 * `source` is the posting the response was extracted from, and every
 * requirement is checked against it. A response that yields no verified
 * requirement at all returns null: a spec whose whole requirement list was
 * fabricated is not a weaker spec, it is a fabrication, and persisting one
 * would put the fabrication into every draft of the interview.
 */
export function jobSpecFromStructured(
  response: unknown,
  source: string,
  meta: { sourceHash: string; createdAt: string }
): JobSpec | null {
  const raw =
    typeof response === 'string'
      ? parseJobSpecJson(response)
      : response && typeof response === 'object' && !Array.isArray(response)
        ? (response as Record<string, unknown>)
        : null
  if (!raw) return null

  const spec: JobSpec = {
    sourceHash: meta.sourceHash,
    createdAt: meta.createdAt,
    company: nullableString(raw.company),
    roleTitle: nullableString(raw.roleTitle),
    seniority: nullableString(raw.seniority),
    mustHaves: requirementList(raw.mustHaves, source, LIMITS.mustHaves),
    niceToHaves: requirementList(raw.niceToHaves, source, LIMITS.niceToHaves),
    responsibilities: stringList(raw.responsibilities, LIMITS.responsibilities),
    companySignals: stringList(raw.companySignals, LIMITS.companySignals),
    likelyQuestions: stringList(raw.likelyQuestions, LIMITS.likelyQuestions)
  }

  if (spec.mustHaves.length === 0 && spec.niceToHaves.length === 0) return null
  return spec
}

/** Round-trip a stored spec out of settings. Never throws; `''` yields null. */
export function parseJobSpec(json: string): JobSpec | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<JobSpec>
    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed.mustHaves) || !Array.isArray(parsed.niceToHaves)) return null
    return {
      sourceHash: typeof parsed.sourceHash === 'string' ? parsed.sourceHash : '',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      company: parsed.company ?? null,
      roleTitle: parsed.roleTitle ?? null,
      seniority: parsed.seniority ?? null,
      mustHaves: parsed.mustHaves,
      niceToHaves: parsed.niceToHaves,
      responsibilities: parsed.responsibilities ?? [],
      companySignals: parsed.companySignals ?? [],
      likelyQuestions: parsed.likelyQuestions ?? []
    }
  } catch {
    return null
  }
}

/**
 * The never-claim rule.
 *
 * Exported so the test suite asserts on the real string rather than on a copy
 * of it that could drift, and so the raw-posting fallback below carries the
 * identical rule — the fallback is the path a hurried user actually takes, and
 * it is the one where the model has the WHOLE posting in front of it, so it
 * needs the guard at least as much.
 */
export const JOB_CLAIM_RULE =
  'Everything in this section is what the EMPLOYER is asking for. None of it is ' +
  'something the user has done. Only present experience with one of these if it also ' +
  "appears in the candidate's background above; where it does not, use the honest " +
  'bridge you were already given rather than letting this section become a claim. ' +
  'Never state or imply that the user has a skill, a number of years, or a credential ' +
  'on the strength of this section alone.'

/**
 * The posting as a prompt block.
 *
 * Deliberately compact — this rides on every draft on the hot path, and the
 * bounds above are what keep it so. It is placed AFTER the candidate profile so
 * that "above" in `JOB_CLAIM_RULE` resolves to the profile.
 */
export function jobSpecPromptBlock(spec: JobSpec): string {
  // The header is never subject to the budget. A block that truncated away the
  // claim rule would be strictly worse than no block at all: the posting's
  // skill list would still be in the prompt, with nothing left saying the user
  // does not necessarily have any of it.
  const header = ['# The role being interviewed for', '', JOB_CLAIM_RULE]
  const heading = [spec.roleTitle, spec.company && `at ${spec.company}`].filter(Boolean).join(' ')
  if (heading) {
    header.push('')
    header.push(`Role: ${heading}${spec.seniority ? ` (${spec.seniority})` : ''}`)
  }

  /** Sections in the order they are worth keeping when the budget runs out. */
  const sections: { title: string; note?: string; items: string[] }[] = [
    { title: '## The employer requires', items: spec.mustHaves.map((r) => r.text) },
    {
      title: '## What the job actually involves',
      note: 'Weight the answer toward these. This is what the interviewer is measuring.',
      items: spec.responsibilities
    },
    { title: '## The employer would also like', items: spec.niceToHaves.map((r) => r.text) },
    {
      title: '## Questions this posting suggests they will ask',
      items: spec.likelyQuestions
    },
    { title: '## What this employer says it values', items: spec.companySignals }
  ]

  const lines = [...header]
  let budget = JOB_SPEC_BLOCK_LIMIT - header.join('\n').length

  for (const section of sections) {
    if (section.items.length === 0) continue
    const opening = ['', section.title, ...(section.note ? [section.note] : [])]
    const openingCost = opening.join('\n').length + 1
    // A heading with no items under it is noise; only open the section if at
    // least one item fits beneath it.
    const firstItem = `- ${section.items[0]}`
    if (openingCost + firstItem.length + 1 > budget) continue

    lines.push(...opening)
    budget -= openingCost
    for (const item of section.items) {
      const line = `- ${item}`
      if (line.length + 1 > budget) break
      lines.push(line)
      budget -= line.length + 1
    }
  }

  return lines.join('\n')
}

/**
 * The un-analysed posting as a prompt block.
 *
 * The point of keeping the raw text at all. Someone who pastes a posting a
 * minute before the call and never presses Analyse still gets most of the
 * value, and an analysis that fails does not leave them worse off than before
 * they pasted. Truncated because a posting can run to several thousand words
 * and this is the hot path.
 */
export function rawJobDescriptionBlock(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const body =
    trimmed.length > RAW_JD_PROMPT_LIMIT
      ? `${trimmed.slice(0, RAW_JD_PROMPT_LIMIT)}\n[posting truncated]`
      : trimmed
  return ['# The role being interviewed for', '', JOB_CLAIM_RULE, '', body].join('\n')
}

/** One line for the Settings summary, e.g. "Senior Frontend Engineer at Acme — 9 requirements". */
export function describeJobSpec(spec: JobSpec): string {
  const who = [spec.roleTitle ?? 'Role', spec.company && `at ${spec.company}`]
    .filter(Boolean)
    .join(' ')
  const count = spec.mustHaves.length + spec.niceToHaves.length
  return `${who} — ${count} requirement${count === 1 ? '' : 's'} found`
}
