import { checkBundle, pruneUngrounded, type GroundingIssue } from './resume-grounding.ts'
import type { LlmClient } from './structured-llm.ts'
import type { JobBrief } from '../shared/job-brief.ts'
// Sealing and token estimation live in main, not in `shared/`: they need
// `node:crypto`, which the renderer bundle cannot have.
import { estimateTokens, sealBundle } from './resume-profile.ts'
import {
  BUNDLE_VERSION,
  COMPETENCIES,
  HIGH_RISK_COMPETENCIES,
  type Competency
} from '../shared/profile.ts'
import type { Gap, Profile, ProfileBundle, Story } from './resume-types.ts'
import {
  GAP_ANSWER_SCHEMA,
  GAP_QUESTIONS_SCHEMA,
  JD_SCHEMA,
  PROFILE_SCHEMA,
  STORIES_SCHEMA,
  TECH_QUESTIONS_SCHEMA
} from './resume-schemas.ts'

/**
 * The ingest pipeline: resume text in, versioned `ProfileBundle` out.
 *
 * Runs once per upload, asynchronously, and nothing here is on the hot path —
 * that is the entire design. Work that would otherwise happen while an
 * interviewer is mid-sentence happens at upload time instead.
 *
 * Every model call is followed by a deterministic pass that bounds it: counts
 * clamped, competencies filtered to the known set, ids made unique, claims
 * checked against the source document. The model proposes; this file decides.
 */

/** ADR-004 budgets the whole bundle at ~3k tokens. Past this it stops being cheap to cache. */
export const MAX_BUNDLE_TOKENS = 6000
/** Profile & Ingest specifies 15–25 mined stories. */
export const MAX_STORIES = 25
export const MIN_STORIES = 15
/** "5–8 targeted questions in-app" — more than that and nobody finishes the flow. */
export const MAX_GAP_QUESTIONS = 8

/**
 * How many of the eight slots the behavioral competency scan may take.
 *
 * It used to take all of them, and that was the complaint: every question the
 * feature produced was situational ("tell me about a time you disagreed"),
 * because every question was generated from a list of twelve behavioral
 * competencies and nothing else. A resume's most interrogable content — the
 * stack against each role — reached the question writer as context and was
 * never asked about.
 *
 * The budget is exactly the size of `HIGH_RISK_COMPETENCIES`, and derived from
 * it rather than written as a number, because that is the principle rather than
 * a taste: those four are the competencies a resume cannot evidence, they sort
 * first in `findGaps`, and they are where a model invents when asked in a live
 * interview. Every one of them must fit.
 *
 * It was briefly a literal 3, which was one short — `influence-without-authority`
 * is the fourth high-risk competency and it fell off the end silently, which is
 * precisely the failure the source-aware coverage rule exists to stop. Tying the
 * two together is what stops that recurring if the list ever changes.
 *
 * The remaining four slots go to technical probes, which is where the resume
 * actually has substance.
 */
export const MAX_BEHAVIORAL_GAP_QUESTIONS = HIGH_RISK_COMPETENCIES.length

/**
 * Technologies named in a single technical question.
 *
 * One per technology produces eight variations of "what did you use X for",
 * which is a checklist. Two or three lets the question ask about the *choice* —
 * why this cache next to that database — which is the thing only the person who
 * built it can answer, and the thing an interviewer actually asks.
 */
const MAX_TECHNOLOGIES_PER_PROBE = 3

const MAX_FIELD_CHARS = 1200
const MAX_METRICS_PER_STORY = 6

/**
 * Output budget per step, sized to what that step actually emits.
 *
 * These are not a safety net, they are a cost. Several providers — Groq's free
 * tier is the one this was found on — bill the *requested* ceiling against a
 * tokens-per-minute quota rather than what the model returns, so a blanket
 * 32k budget on a call that emits four questions gets the whole ingest refused
 * with a rate-limit error. The observed failure was 33,322 tokens requested
 * against an 8,000 TPM limit, on a job whose real output was under 3,000.
 *
 * Even without a quota it was wrong: a ceiling should describe the work.
 *
 * Sized from the shape of each output, with headroom: a profile is a page of
 * structured fields; a bank of 15–25 STAR stories is the only genuinely large
 * one; a gap scan is at most eight questions; a gap answer is a single story.
 * Too small is not silent — the client raises `LlmRefusal` on a truncated
 * response, because a half-extracted profile looks complete and silently omits
 * a job.
 */
const STEP_TOKENS = {
  extraction: 4_000,
  mining: 8_000,
  gapScan: 1_000,
  techProbe: 1_500,
  gapAnswer: 1_500,
  jobDescription: 3_000
} as const

export interface IngestReport {
  /** Every grounding problem found, including the advisory ones. */
  issues: GroundingIssue[]
  /** Claims removed because they were not in the document. */
  dropped: GroundingIssue[]
  storiesMined: number
  storiesKept: number
  estimatedTokens: number
  /** True when the bank came in under the mining floor — the UI nudges the user to add detail. */
  thin: boolean
  /**
   * Competencies carried by so many stories that the tag no longer selects
   * anything, with the fraction of the bank each covers.
   *
   * A tag is a selection key: at interview time the model is asked for a
   * *conflict* story and picks by tag. A tag on 100% of the bank returns the
   * whole bank, which is the same as having no tag — and it is invisible from
   * inside a single story, so nothing else in this pipeline would catch it.
   * Observed on a real resume: `technical-tradeoff` on 17 of 17 stories.
   *
   * Reported rather than corrected. Which of seventeen tags is the wrong one is
   * a judgement this code cannot make, and silently dropping tags would lose
   * real ones; surfacing it lets the prompt be tuned against a number.
   */
  overusedTags: { competency: Competency; fraction: number }[]
}

/**
 * Above this share of the bank, a tag has stopped discriminating.
 *
 * Two thirds is a judgement, not a derivation: a competency genuinely central
 * to someone's career can honestly cover half their stories, but past two
 * thirds "select by tag" and "return everything" are the same query.
 */
const TAG_SATURATION = 2 / 3

export interface IngestResult {
  bundle: ProfileBundle
  report: IngestReport
}

const EXTRACT_SYSTEM = `You extract a structured career profile from a resume.

The single rule that outranks every other: **you may only record what the document says.**
If a field is not in the document, its value is null (or an empty array). Never infer a
date from context, never expand an abbreviation into a company you assume it means, never
round or restate a number, and never supply a job title that "must" have applied.

An unfilled field is not a failure. A fabricated one is — this profile is read aloud by
the candidate in a live job interview, and a wrong employer or an invented metric is
unrecoverable for them.

Specifics:
- Company and title must appear verbatim in the document (spelling and casing may differ).
- Dates are "YYYY-MM", or "YYYY" when only a year is given, or null. Do not guess a month.
- \`metrics\` holds only figures actually printed in the document, each with the claim it
  supports. This list is what the candidate is later permitted to state out loud.
- \`stack\` holds the technologies the document attributes **to that role**. A resume's
  general skills section is not a stack: it belongs in \`skills\`, once, and copying it into
  every role makes the profile longer without making it more true, and makes it impossible
  to tell which role a technology was actually used in.
- Give every role a short stable id derived from the company, e.g. "acme-robotics".`

const MINE_SYSTEM = `You mine STAR stories from a candidate's resume and structured profile.

Each story must be traceable to something the document actually describes. Elaborating the
phrasing of an accomplishment the resume states is expected; inventing an accomplishment it
does not state is not. Where the resume is terse, write the story terse — a thin, true story
is useful, and a rich, invented one is a liability the candidate discovers mid-interview.

For each story:
- \`id\`: a readable slug naming the competency and the subject, e.g. "conflict-manager-roadmap".
  The candidate sees this id in the live UI as the receipt for where an answer came from.
- \`roleId\`: the id of the role it happened at, or null if the document does not make that clear.
- \`competencies\`: every tag an interviewer would actually file this story under, and no
  others. A tag is a selection key, not a description: at interview time the model is asked
  for a *conflict* story and must get the conflict story back. So the test for each tag is
  "if an interviewer asked about this competency, is this the story I would tell?" — not
  "does this story touch on it".

  Do not cap yourself at one tag. A story that genuinely answers three questions should
  carry three; dropping the real ones to look disciplined makes the bank less useful, not
  more. What to avoid is the opposite failure: a tag that fits every engineering story
  ever written, applied to every entry, which selects nothing.
- \`situation\` / \`task\` / \`action\` / \`result\`: two or three sentences each, first person.
- \`metrics\`: only figures printed in the resume. Empty is the correct answer when the
  resume quantifies nothing — the candidate will be asked to fill that in later.

Cover the roles broadly rather than exhausting the most recent one, and prefer distinct
situations over several angles on the same project.`

const GAP_SYSTEM = `You find what a candidate's story bank cannot answer, and ask about it.

You are given the competencies with no story behind them. Write one question per competency,
in the voice of a friendly coach rather than an interviewer: short, concrete, and easy to
answer out loud in thirty seconds.

A good question names the shape of the answer ("a project that didn't ship — what happened,
and what did you do next?"). A bad one restates the competency ("tell me about failure").

You are also given the projects the candidate has already described. Use them. Name two or
three in the question so the candidate knows where in their memory to look — a question that
could have come from any list of interview questions wastes the one thing you know that such
a list does not, which is what this person actually worked on.

Name them as reminders, never as claims. Ask whether something happened; do not state that it
did. "You worked on the lead pipeline, the scoring weights and the assistant — was there a
point on any of those where you and someone else disagreed about the approach?" is right.
"On the scoring weights you disagreed with your manager — what happened?" is wrong: it decides
the answer before the candidate has spoken, and a candidate who had no such disagreement is
being invited to invent one.

Ask only about the competencies given. Do not invent the answers.`

const TECH_SYSTEM = `You write technical questions about the specific systems one candidate has actually built.

Each target you are given is a role from their resume plus the technologies listed against
that role that none of their stories explain. Write exactly one question per target, and
put the target's \`id\` on it so it can be matched back.

The test every question must pass: **only the person who did this work could answer it.**
If the question would make sense addressed to any engineer with the same resume keywords,
it is the wrong question and you must rewrite it.

That means each question:
- names the company verbatim (or the project its summary names), never "your last role";
- names the technologies from that target verbatim, never a category like "your database";
- asks for a decision and its reason — what that technology was doing in that system, what
  it was chosen over, which constraint made it the right call, how it was sized, shaped, or
  configured for that particular workload, or what it made harder.

Good: "At Northwind you list Kafka alongside Postgres on the billing pipeline — what was
Kafka carrying that Postgres couldn't, and how did you land on the partition count?"
Good: "Your Vertex work lists Terraform and GitHub Actions — walk me through what actually
happens between a merge and a running deploy, and where that pipeline was most fragile."

Bad: "Tell me about a technical tradeoff you've made." (generic, and it is a competency,
not a system)
Bad: "What is your experience with Kafka?" (a keyword check, answerable from the resume)
Bad: "How do you approach designing scalable systems?" (belongs to no project at all)

Hard rules:
- Never introduce a technology, service, metric, team size, or traffic figure the target
  does not give you. If you want to know the scale, ask what it was — do not assert it.
- Never assume the architecture. "How did you use Redis there?" is honest; "how did your
  Redis cache-aside layer handle invalidation?" invents a design they may not have built.
- One question, two sentences at most. It is read on screen and answered out loud.
- Do not suggest, hint at, or begin the answer.`

const GAP_ANSWER_SYSTEM = `You turn a candidate's spoken answer into one STAR story.

Use only what the candidate said. Do not smooth over a gap by supplying a plausible detail
they did not give — an unstated result stays vague, and that is correct.

If the answer does not contain a usable story — they declined, drew a blank, or said
something unrelated — set \`usable\` to false, explain briefly in \`reason\`, and set
\`story\` to null. Recording "no story here" honestly is the point of asking: a competency
the candidate has no experience of is exactly the one a model would otherwise invent.

When the question was a technical one, the STAR frame still applies — the situation is the
system, the task is the problem it had to solve, the action is what they built or chose,
the result is what it did. Keep every technology name, version, and figure they said,
spelled the way they spelled it: those are the details that make the story theirs, and
paraphrasing "Postgres 14 with logical replication" into "a relational database" throws
away the only part an interviewer will follow up on.`

const JD_SYSTEM = `You prepare a candidate for one specific job description.

Predict the questions this role's interviewers will actually ask, and for each one name the
story bank entry that answers it. If nothing in the bank fits, set \`storyId\` to null —
that is the most valuable output here, because it tells the candidate their weak flank
before they walk in rather than after.

Most of these questions should be **technical and specific to this posting**, because most
interviews are. Read the job description for the systems, technologies, and scale it names,
read the candidate's stack, and ask what the interviewer will actually ask at the
intersection: how they have used the thing this job runs on, what they did instead where
their stack differs, how they would approach the problem this team clearly has. Name the
technology, and where the candidate has used it, name the employer too.

Good: "This team runs Kafka for event delivery and your Postgres pipeline at Northwind did
the same job — what would you carry over, and what would you do differently on Kafka?"
Good: "The posting asks for Terraform across multiple accounts; how was your Acme Terraform
setup structured, and what broke as it grew?"
Bad: "Tell me about a time you learned a new technology." (asks nothing about this job)
Bad: "Do you have experience with Kubernetes?" (answerable from the résumé)

Keep a few behavioral questions where the posting genuinely signals them — a lead role will
be asked about conflict and mentorship — but do not fill the list with them.

Never invent a technology, and never map a question to a story that does not really answer
it. Then list requirements in the job description that no story supports. Be direct.`

/**
 * How much of a story travels to the gap scan.
 *
 * The situation is the memory jogger — enough to name the project. The task,
 * action, and result are what the *answer* will contain, so sending them pays
 * tokens for text the model does not need in order to write a question. The bank
 * is capped at MAX_STORIES, so this is what keeps the payload bounded.
 */
const STORY_ANCHOR_CHARS = 200

/**
 * The gap scan's user payload, shared by ingest and rescan.
 *
 * Shared because the two must give the same model the same evidence; built
 * separately, they drift, and the questions differ depending on which button the
 * user pressed.
 *
 * The story bank is included because roles alone cannot make a question
 * specific — a role is a job title and a stack list. Asked for a conflict
 * question with only that, the model can do no better than "tell me about a
 * disagreement", which is what any list of interview questions would have given
 * the candidate for free. The situations are what let it name work this person
 * actually did, which is the only thing this pipeline knows that a generic list
 * does not.
 */
function gapScanUser(profile: Profile, stories: Story[], wanted: Competency[]): string {
  const bank = stories.map((s) => ({
    role: s.roleId,
    competencies: s.competencies,
    situation: clamp(s.situation, STORY_ANCHOR_CHARS)
  }))
  return (
    `Roles:\n${JSON.stringify(profile.roles, null, 2)}\n\n` +
    `Projects the candidate has already described:\n${JSON.stringify(bank, null, 2)}\n\n` +
    `Competencies with no story: ${wanted.join(', ')}`
  )
}

function clamp(text: unknown, limit = MAX_FIELD_CHARS): string {
  return typeof text === 'string' ? text.slice(0, limit).trim() : ''
}

function clampNullable(text: unknown, limit = MAX_FIELD_CHARS): string | null {
  const value = clamp(text, limit)
  return value.length > 0 ? value : null
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, limit)
}

/**
 * A slug the user could read aloud, made unique within its bank.
 *
 * The model is asked for a readable id and usually gives one, but it has no way
 * to guarantee uniqueness across a long list — and a duplicate id silently
 * breaks the grounding receipt, since two different stories would answer to the
 * same name.
 */
function uniqueId(raw: unknown, fallback: string, taken: Set<string>): string {
  const base =
    clamp(raw, 64)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  taken.add(id)
  return id
}

const KNOWN_COMPETENCIES = new Set<string>(COMPETENCIES)

function competencies(value: unknown): Competency[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<Competency>()
  for (const item of value) {
    if (typeof item === 'string' && KNOWN_COMPETENCIES.has(item)) seen.add(item as Competency)
  }
  return [...seen]
}

/** Normalises whatever the extractor returned into a `Profile`. */
export function normaliseProfile(raw: unknown): Profile {
  const source = (raw ?? {}) as Record<string, unknown>
  const identity = (source.identity ?? {}) as Record<string, unknown>
  const taken = new Set<string>()

  const roles = (Array.isArray(source.roles) ? source.roles : [])
    .map((entry, i) => {
      const role = (entry ?? {}) as Record<string, unknown>
      const company = clamp(role.company, 200)
      const title = clamp(role.title, 200)
      if (!company || !title) return null
      return {
        id: uniqueId(role.id, `role-${i + 1}`, taken),
        company,
        title,
        start: clampNullable(role.start, 16),
        end: clampNullable(role.end, 16),
        current: role.current === true,
        stack: stringList(role.stack, 40),
        summary: clampNullable(role.summary)
      }
    })
    .filter((role): role is NonNullable<typeof role> => role !== null)

  const roleIds = new Set(roles.map((r) => r.id))

  return {
    identity: {
      name: clampNullable(identity.name, 200),
      headline: clampNullable(identity.headline, 300),
      location: clampNullable(identity.location, 200),
      email: clampNullable(identity.email, 320),
      links: stringList(identity.links, 10)
    },
    roles,
    education: (Array.isArray(source.education) ? source.education : [])
      .map((entry) => {
        const edu = (entry ?? {}) as Record<string, unknown>
        const institution = clamp(edu.institution, 200)
        if (!institution) return null
        return {
          institution,
          credential: clampNullable(edu.credential, 200),
          field: clampNullable(edu.field, 200),
          end: clampNullable(edu.end, 16)
        }
      })
      .filter((edu): edu is NonNullable<typeof edu> => edu !== null),
    skills: stringList(source.skills, 60),
    metrics: (Array.isArray(source.metrics) ? source.metrics : [])
      .map((entry) => {
        const metric = (entry ?? {}) as Record<string, unknown>
        const value = clamp(metric.value, 120)
        if (!value) return null
        const roleId = clampNullable(metric.roleId, 64)
        return {
          // A metric pointing at a role that did not survive normalisation is
          // still a real metric; detach rather than drop it.
          roleId: roleId && roleIds.has(roleId) ? roleId : null,
          value,
          claim: clamp(metric.claim, 300)
        }
      })
      .filter((metric): metric is NonNullable<typeof metric> => metric !== null)
      .slice(0, 40)
  }
}

export function normaliseStories(raw: unknown, source: Story['source'] = 'resume'): Story[] {
  const list = Array.isArray((raw as { stories?: unknown })?.stories)
    ? (raw as { stories: unknown[] }).stories
    : []
  const taken = new Set<string>()

  return list
    .map((entry, i) => {
      const story = (entry ?? {}) as Record<string, unknown>
      const situation = clamp(story.situation)
      const action = clamp(story.action)
      // A story with no situation and no action is not a story; keeping it
      // would give the model an empty slot to improvise into.
      if (!situation || !action) return null
      return {
        id: uniqueId(story.id, `story-${i + 1}`, taken),
        roleId: clampNullable(story.roleId, 64),
        competencies: competencies(story.competencies),
        situation,
        task: clamp(story.task),
        action,
        result: clamp(story.result),
        metrics: stringList(story.metrics, MAX_METRICS_PER_STORY),
        source
      }
    })
    .filter((story): story is Story => story !== null)
    .slice(0, MAX_STORIES)
}

/**
 * Tags that cover more than [TAG_SATURATION] of the bank.
 *
 * Sorted commonest first so the report leads with the worst offender.
 */
export function overusedTags(stories: Story[]): { competency: Competency; fraction: number }[] {
  if (stories.length === 0) return []
  const counts = new Map<Competency, number>()
  for (const story of stories) {
    // Count each competency once per story even if a story repeats it, so the
    // fraction is 'share of the bank' rather than 'share of tag mentions'.
    for (const tag of new Set(story.competencies)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([competency, n]) => ({ competency, fraction: n / stories.length }))
    .filter((entry) => entry.fraction > TAG_SATURATION)
    .sort((a, b) => b.fraction - a.fraction)
}

/**
 * Whether `haystack` (already lowercased) names `term` as a term rather than as
 * a substring of a longer word.
 *
 * `includes` is wrong here and wrong in a way that silently suppresses
 * questions: "Go" is inside "going", "R" is inside every third word, and "C" is
 * inside "click". Each false positive marks a technology as already explained
 * and drops the one question about it. A word boundary regex is also wrong,
 * because half of these names are not words — `C++`, `.NET`, `Node.js`, `F#` all
 * fail `\b`. So the check is explicit: the characters either side of the match
 * must not be alphanumeric.
 */
function mentionsTerm(haystack: string, term: string): boolean {
  const needle = term.toLowerCase().trim()
  if (!needle) return false
  const alphanumeric = /[a-z0-9]/
  for (let from = 0; ; from += 1) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    const before = haystack[at - 1]
    const after = haystack[at + needle.length]
    if (!(before && alphanumeric.test(before)) && !(after && alphanumeric.test(after))) return true
    from = at
  }
}

/** One technical question's worth of subject matter, chosen before any model sees it. */
export interface TechProbeTarget {
  /** Short handle the model echoes back so the question can be anchored. */
  id: string
  roleId: string | null
  /** Null on the catch-all target for skills the resume attributes to no role. */
  company: string | null
  title: string | null
  summary: string | null
  /** Verbatim from the resume, via the profile — so a question may safely name them. */
  technologies: string[]
  /** Figures the resume attributes to this role, so the question can ask about the real one. */
  metrics: string[]
}

/** Everything a role's own stories say, lowercased, for the "is this explained" test. */
function roleNarrative(stories: Story[], roleId: string | null): string {
  return stories
    .filter((story) => story.roleId === roleId)
    .map((story) => `${story.situation} ${story.task} ${story.action} ${story.result}`)
    .join(' ')
    .toLowerCase()
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * What to ask technical questions about.
 *
 * Deterministic, and the same shape of judgement as `findGaps`: a technology
 * listed against a role that none of that role's stories mention is a gap. The
 * story bank is what the candidate can already speak to; the stack is what the
 * resume claims. The difference is the interrogable surface, and it is where an
 * interviewer will go first.
 *
 * Two rules make the output worth eight slots rather than eight keywords:
 *
 *  - **Deduplicated across roles.** React at three employers is one question,
 *    asked about the most recent one. Asking three times spends the budget on a
 *    word rather than on a system.
 *  - **Round-robin across roles.** A candidate with a forty-item stack at their
 *    current job and three earlier roles should not get eight questions about
 *    the current job. One chunk per role, then round again — so the whole
 *    resume is covered before any part of it is covered twice.
 *
 * Skills the resume lists but attaches to no role come last, as a single
 * catch-all: they are the weakest evidence on the page and the likeliest thing
 * an interviewer catches the candidate out on.
 */
export function technicalProbeTargets(
  profile: Profile,
  stories: Story[],
  limit: number
): TechProbeTarget[] {
  if (limit <= 0) return []

  // Deduped case-insensitively but reported verbatim: the question must print
  // the technology the way the resume spells it.
  const claimed = new Set<string>()
  const queues: TechProbeTarget[][] = []

  for (const role of profile.roles) {
    const narrative = roleNarrative(stories, role.id)
    const unexplained = role.stack.filter((tech) => {
      const key = tech.toLowerCase().trim()
      if (!key || claimed.has(key)) return false
      if (mentionsTerm(narrative, tech)) return false
      claimed.add(key)
      return true
    })
    if (unexplained.length === 0) continue

    const metrics = profile.metrics
      .filter((metric) => metric.roleId === role.id)
      .map((metric) => `${metric.value} — ${metric.claim}`)
      .slice(0, 4)

    queues.push(
      chunk(unexplained, MAX_TECHNOLOGIES_PER_PROBE).map((technologies, i) => ({
        id: `${role.id}-${i + 1}`,
        roleId: role.id,
        company: role.company,
        title: role.title,
        summary: role.summary,
        technologies,
        metrics
      }))
    )
  }

  // Skills with no role behind them and no story mentioning them anywhere.
  const everything = stories
    .map((story) => `${story.situation} ${story.task} ${story.action} ${story.result}`)
    .join(' ')
    .toLowerCase()
  const orphans = profile.skills.filter((skill) => {
    const key = skill.toLowerCase().trim()
    if (!key || claimed.has(key)) return false
    if (mentionsTerm(everything, skill)) return false
    claimed.add(key)
    return true
  })
  if (orphans.length > 0) {
    queues.push(
      chunk(orphans, MAX_TECHNOLOGIES_PER_PROBE)
        // One catch-all, not a tail of them: a long skills section would
        // otherwise crowd out every question anchored to real work.
        .slice(0, 1)
        .map((technologies) => ({
          id: 'unattributed-skills',
          roleId: null,
          company: null,
          title: null,
          summary: null,
          technologies,
          metrics: []
        }))
    )
  }

  const targets: TechProbeTarget[] = []
  for (let round = 0; targets.length < limit; round += 1) {
    const available = queues.filter((queue) => queue.length > round)
    if (available.length === 0) break
    for (const queue of available) {
      if (targets.length >= limit) break
      targets.push(queue[round])
    }
  }
  return targets
}

/** Anchors each returned question to the target it was written for. */
function buildTechnicalGaps(raw: unknown, targets: TechProbeTarget[], taken: Set<string>): Gap[] {
  const list = Array.isArray((raw as { questions?: unknown })?.questions)
    ? (raw as { questions: unknown[] }).questions
    : []
  const byId = new Map(targets.map((target) => [target.id, target]))
  const gaps: Gap[] = []

  for (const entry of list) {
    const item = (entry ?? {}) as Record<string, unknown>
    const target = byId.get(clamp(item.targetId, 128))
    const question = clamp(item.question, 400)
    // A question for a target we did not ask about is a question about
    // something the resume may not contain — the one thing this pipeline
    // never ships. Drop it rather than repair it.
    if (!target || !question) continue
    byId.delete(target.id)
    gaps.push({
      id: uniqueId(`tech-${target.id}`, `tech-${gaps.length + 1}`, taken),
      kind: 'technical',
      // Every technical probe is a tradeoff question by construction: it asks
      // why this technology, in this system, over the alternative. Tagging it
      // so means an answered probe lands in the bank where the live session
      // looks for a technical story.
      competency: 'technical-tradeoff',
      subject: target.technologies.join(', '),
      roleId: target.roleId,
      question,
      status: 'open',
      storyId: null
    })
  }

  return gaps
}

/**
 * Competencies with no evidence worth trusting behind them.
 *
 * Deterministic rather than a model call: it is a set difference, and asking a
 * model to compute one is both slower and less reliable than computing it.
 *
 * The difference is taken over *trustworthy* evidence, not over tags. For the
 * high-risk competencies only a `gap-answer` story counts, because `profile.ts`
 * defines those four as ones "a resume essentially never evidences on its own" —
 * so a tag on a resume-mined story is precisely the signal that should not
 * silence the question. Observed on a real bundle: one resume-sourced `conflict`
 * story in twenty suppressed the conflict question permanently, and the bank had
 * nothing real behind it at interview time.
 *
 * `existingGaps` excludes anything already asked, whatever its status. `skipped`
 * is the load-bearing case — it is the only thing that makes "I don't have one"
 * permanent. `open` matters too: the question is already on screen and the
 * competency is still uncovered, so without this a rescan appends a duplicate
 * every time. `answered` is belt-and-braces, since its story covers the
 * competency anyway.
 *
 * High-risk competencies sort first — they are where the model would otherwise
 * invent, which is the failure the gap scan exists to prevent.
 */
export function findGaps(stories: Story[], existingGaps: Gap[] = []): Competency[] {
  const covered = new Set<Competency>()
  for (const story of stories) {
    const trustworthy = story.source === 'gap-answer'
    for (const tag of story.competencies) {
      if (trustworthy || !HIGH_RISK_COMPETENCIES.includes(tag)) covered.add(tag)
    }
  }

  const asked = new Set<Competency>(existingGaps.map((g) => g.competency))
  const missing = COMPETENCIES.filter((c) => !covered.has(c) && !asked.has(c))
  const risky = missing.filter((c) => HIGH_RISK_COMPETENCIES.includes(c))
  const rest = missing.filter((c) => !HIGH_RISK_COMPETENCIES.includes(c))
  return [...risky, ...rest]
}

function buildGaps(
  questions: unknown,
  missing: Competency[],
  taken: Set<string> = new Set(),
  /**
   * How many questions this call may produce.
   *
   * Defaults to the behavioral budget, which is what an ingest wants: three
   * slots, with the rest of the eight going to technical probes. `rescanGaps`
   * passes its own, because it has already worked out how much of the
   * bundle-wide budget is left and must not be cut to three again on top.
   */
  limit: number = MAX_BEHAVIORAL_GAP_QUESTIONS
): Gap[] {
  const raw = Array.isArray((questions as { questions?: unknown })?.questions)
    ? (questions as { questions: unknown[] }).questions
    : []
  const wanted = new Set<Competency>(missing)
  const gaps: Gap[] = []

  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>
    const competency = item.competency
    const question = clamp(item.question, 400)
    // Only ask about competencies that are genuinely missing — a question about
    // a covered one wastes the user's attention and one of eight slots.
    if (typeof competency !== 'string' || !wanted.has(competency as Competency)) continue
    if (!question) continue
    wanted.delete(competency as Competency)
    gaps.push({
      id: uniqueId(`gap-${competency}`, `gap-${gaps.length + 1}`, taken),
      kind: 'behavioral',
      competency: competency as Competency,
      subject: null,
      roleId: null,
      question,
      status: 'open',
      storyId: null
    })
    if (gaps.length >= limit) break
  }

  return gaps
}

/** The phases a caller can report while an ingest runs. One per model call. */
export type IngestPhaseName = 'mining-profile' | 'mining-stories' | 'gap-scan' | 'tech-probe'

export interface IngestOptions {
  /** Injected so bundle timestamps are deterministic in tests. */
  now?: () => Date
  /**
   * Called before each model call.
   *
   * A local ingest is otherwise a silent minute, and a Settings pane showing
   * nothing for that long is indistinguishable from a hang. Each phase maps to
   * exactly one model call, so the label is a true statement about what the
   * wait is buying rather than a spinner with a caption on it.
   */
  onPhase?: (phase: IngestPhaseName) => void
}

export async function runIngest(
  sourceText: string,
  llm: LlmClient,
  opts: IngestOptions = {}
): Promise<IngestResult> {
  const now = opts.now ?? (() => new Date())

  opts.onPhase?.('mining-profile')
  const extracted = await llm.structured<unknown>({
    label: 'profile extraction',
    maxTokens: STEP_TOKENS.extraction,
    system: EXTRACT_SYSTEM,
    schema: PROFILE_SCHEMA,
    user: `Resume:\n\n${sourceText}`
  })
  const rawProfile = normaliseProfile(extracted)

  opts.onPhase?.('mining-stories')
  const mined = await llm.structured<unknown>({
    label: 'story mining',
    maxTokens: STEP_TOKENS.mining,
    system: MINE_SYSTEM,
    schema: STORIES_SCHEMA,
    user:
      `Structured profile:\n${JSON.stringify(rawProfile, null, 2)}\n\n` +
      `Resume:\n\n${sourceText}\n\n` +
      `Mine ${MIN_STORIES}–${MAX_STORIES} stories.`
  })
  const rawStories = normaliseStories(mined)

  // The grounding gate. Everything above is a proposal; nothing past this line
  // has a claim in it that the document does not support.
  const pruned = pruneUngrounded(rawProfile, rawStories, sourceText)

  // Ids are unique across both kinds of question, so the two builders share one
  // `taken` set — the UI addresses a gap by id and cannot tell them apart.
  const taken = new Set<string>()

  const missing = findGaps(pruned.stories).slice(0, MAX_BEHAVIORAL_GAP_QUESTIONS)
  // A statement rather than the ternary this used to be, so the progress hook
  // fires only on the branch that actually calls the model: a bank with no gaps
  // must not display "looking for gaps" for a step it is skipping.
  let behavioral: Gap[] = []
  if (missing.length > 0) {
    opts.onPhase?.('gap-scan')
    behavioral = buildGaps(
      await llm.structured<unknown>({
        label: 'gap scan',
        maxTokens: STEP_TOKENS.gapScan,
        system: GAP_SYSTEM,
        schema: GAP_QUESTIONS_SCHEMA,
        user: gapScanUser(pruned.profile, pruned.stories, missing),
        effort: 'medium'
      }),
      missing,
      taken
    )
  }

  // The technical axis. Targets are chosen here, deterministically, from the
  // pruned profile — so every technology a question names is one the document
  // actually printed, and the model's only job is phrasing.
  const targets = technicalProbeTargets(
    pruned.profile,
    pruned.stories,
    MAX_GAP_QUESTIONS - behavioral.length
  )
  let technical: Gap[] = []
  if (targets.length > 0) {
    opts.onPhase?.('tech-probe')
    technical = buildTechnicalGaps(
      await llm.structured<unknown>({
        label: 'technical probe',
        maxTokens: STEP_TOKENS.techProbe,
        system: TECH_SYSTEM,
        schema: TECH_QUESTIONS_SCHEMA,
        user:
          `Targets:\n${JSON.stringify(targets, null, 2)}\n\n` +
          `Write exactly ${targets.length} question${targets.length === 1 ? '' : 's'}, one per target, ` +
          `each carrying its target's id.`,
        effort: 'medium'
      }),
      targets,
      taken
    )
  }

  // Technical first. They are what the user came for, and they are the easier
  // ones to answer — a flow that opens with "tell me about a time you failed"
  // is a flow people close. The behavioral questions still get asked, by
  // someone who is three answers in rather than nought.
  const gaps = [...technical, ...behavioral]

  const bundle = sealBundle(
    { version: BUNDLE_VERSION, profile: pruned.profile, stories: pruned.stories, gaps },
    now().toISOString()
  )

  const verdict = checkBundle(bundle, sourceText)

  return {
    bundle,
    report: {
      issues: verdict.issues,
      dropped: pruned.dropped,
      storiesMined: rawStories.length,
      storiesKept: pruned.stories.length,
      estimatedTokens: estimateTokens(bundle),
      thin: pruned.stories.length < MIN_STORIES,
      overusedTags: overusedTags(pruned.stories)
    }
  }
}

export interface GapAnswerResult {
  bundle: ProfileBundle
  /** False when the user had no story to give — recorded, not invented. */
  accepted: boolean
  reason: string | null
}

/**
 * Folds one answered gap question back into the bank.
 *
 * Returns a **new** bundle with a new hash: the bank changed, so the prompt
 * cache key and the device sync key must change with it. Mutating in place
 * would leave every cached copy silently stale.
 */
/**
 * Regenerate the gap questions for a bundle that already exists.
 *
 * The gap scan otherwise runs only inside `runIngest`, so a change to what
 * counts as coverage reaches an existing user only if they re-upload their
 * resume — a full re-mine, a minute of wall time, and the whole bank replaced.
 * This runs the scan alone: one model call, the stories untouched.
 *
 * Existing gaps are carried through unchanged rather than regenerated. An
 * answered gap has a story behind it and a skipped one is a decision the user
 * made; both are facts, not proposals, and rebuilding them would discard the
 * only record that they happened.
 */
export async function rescanGaps(
  bundle: ProfileBundle,
  llm: LlmClient,
  opts: IngestOptions = {}
): Promise<ProfileBundle> {
  const now = opts.now ?? ((): Date => new Date())
  const missing = findGaps(bundle.stories, bundle.gaps)
  if (missing.length === 0) return bundle

  // The cap is a budget for the bundle, not for the scan: eight questions total,
  // however many times this is run.
  const wanted = missing.slice(0, Math.max(0, MAX_GAP_QUESTIONS - bundle.gaps.length))
  if (wanted.length === 0) return bundle

  const fresh = buildGaps(
    await llm.structured<unknown>({
      label: 'gap scan',
      maxTokens: STEP_TOKENS.gapScan,
      system: GAP_SYSTEM,
      schema: GAP_QUESTIONS_SCHEMA,
      user: gapScanUser(bundle.profile, bundle.stories, wanted),
      effort: 'medium'
    }),
    wanted,
    // Seeded with the ids already in the bundle: `buildGaps` mints
    // `gap-${competency}`, and the pane tracks the question on screen by id, so
    // a collision would render the wrong question.
    new Set(bundle.gaps.map((g) => g.id)),
    // `wanted` is already the remaining bundle-wide budget, worked out above.
    // Letting it fall back to the behavioral default would cut every rescan to
    // three questions on top of a limit that had already been applied.
    wanted.length
  )

  return sealBundle(
    {
      version: bundle.version,
      profile: bundle.profile,
      stories: bundle.stories,
      gaps: [...bundle.gaps, ...fresh]
    },
    now().toISOString()
  )
}

export async function answerGap(
  bundle: ProfileBundle,
  gapId: string,
  answerText: string,
  llm: LlmClient,
  opts: IngestOptions = {}
): Promise<GapAnswerResult> {
  const now = opts.now ?? (() => new Date())
  const gap = bundle.gaps.find((g) => g.id === gapId)
  if (!gap) throw new Error(`Unknown gap: ${gapId}`)

  const raw = await llm.structured<{ usable?: unknown; reason?: unknown; story?: unknown }>({
    label: 'gap answer',
    maxTokens: STEP_TOKENS.gapAnswer,
    system: GAP_ANSWER_SYSTEM,
    schema: GAP_ANSWER_SCHEMA,
    user:
      `Competency: ${gap.competency}\n` +
      (gap.subject ? `Technologies the question was about: ${gap.subject}\n` : '') +
      (gap.roleId ? `Role it was anchored to: ${gap.roleId}\n` : '') +
      `Question asked: ${gap.question}\n` +
      `Roles: ${JSON.stringify(bundle.profile.roles.map((r) => ({ id: r.id, company: r.company, title: r.title })))}\n\n` +
      `The candidate answered:\n${answerText}`,
    effort: 'medium'
  })

  if (raw.usable !== true || raw.story === null || typeof raw.story !== 'object') {
    const reason = clampNullable(raw.reason, 300)
    const gaps = bundle.gaps.map((g) => (g.id === gapId ? { ...g, status: 'skipped' as const } : g))
    return {
      bundle: sealBundle(
        { version: bundle.version, profile: bundle.profile, stories: bundle.stories, gaps },
        now().toISOString()
      ),
      accepted: false,
      reason
    }
  }

  const [story] = normaliseStories({ stories: [raw.story] }, 'gap-answer')
  if (!story) {
    return { bundle, accepted: false, reason: 'That answer did not contain a story we could use.' }
  }

  // Re-run uniqueness against the existing bank, which `normaliseStories` could
  // not see — it only deduplicates within the list it was handed.
  const taken = new Set(bundle.stories.map((s) => s.id))
  const id = uniqueId(story.id, `gap-${gap.competency}`, taken)
  const stored: Story = {
    ...story,
    id,
    // A technical probe already knows which role it asked about; that is better
    // evidence than the model's guess, and a story with no role loses the
    // company name the candidate needs when they tell it.
    roleId: story.roleId ?? gap.roleId ?? null,
    // Answer the question that was asked: the competency is why we asked, so it
    // belongs on the story even if the model tagged it differently.
    competencies: story.competencies.includes(gap.competency)
      ? story.competencies
      : [gap.competency, ...story.competencies]
  }

  const gaps = bundle.gaps.map((g) =>
    g.id === gapId ? { ...g, status: 'answered' as const, storyId: id } : g
  )

  return {
    bundle: sealBundle(
      {
        version: bundle.version,
        profile: bundle.profile,
        stories: [...bundle.stories, stored],
        gaps
      },
      now().toISOString()
    ),
    accepted: true,
    reason: null
  }
}

/**
 * Defined in `shared/job-brief.ts` so the renderer can carry it into the
 * prompt. Aliased rather than re-declared: two structurally identical types
 * drift the moment one of them gains a field.
 */
export type JobDescriptionBrief = JobBrief

/**
 * Just the part of a bundle this pass reads.
 *
 * There are two parallel `ProfileBundle` types — the main-process one in
 * `resume-types.ts` and the wider one in `shared/profile.ts` the settings blob
 * parses into — and they differ only in how tightly `competencies` is typed.
 * This pass reads three fields and writes none, so naming those three lets both
 * satisfy it structurally and avoids the unsafe cast `answerGap` needs (see
 * ingest.ts). Asking for less is what makes the caller's choice of bundle
 * irrelevant.
 */
interface StoryBankView {
  stories: { id: string; competencies: readonly string[]; situation: string }[]
  /**
   * The stack, so the brief can anticipate technical questions and not only
   * behavioral ones. Without it this pass could only ever ask about the twelve
   * competencies, which is how a job description full of Kafka and Kubernetes
   * produced "tell me about a time you handled ambiguity".
   */
  profile: {
    roles: readonly { id: string; company: string; title: string; stack: readonly string[] }[]
    skills: readonly string[]
  }
}

/**
 * The optional job-description pass.
 *
 * Cached by the caller against the JD hash — it is deterministic input, run
 * before an interview rather than during one.
 */
export async function jobDescriptionBrief(
  bundle: StoryBankView,
  jobDescription: string,
  llm: LlmClient
): Promise<JobDescriptionBrief> {
  const raw = await llm.structured<{ likelyQuestions?: unknown; uncoveredRequirements?: unknown }>({
    label: 'job description pass',
    maxTokens: STEP_TOKENS.jobDescription,
    system: JD_SYSTEM,
    schema: JD_SCHEMA,
    user:
      `Candidate's stack, by role:\n${JSON.stringify(
        bundle.profile.roles.map((r) => ({
          id: r.id,
          company: r.company,
          title: r.title,
          stack: r.stack
        })),
        null,
        2
      )}\n\n` +
      `Other skills listed: ${bundle.profile.skills.join(', ') || '(none)'}\n\n` +
      `Story bank:\n${JSON.stringify(
        bundle.stories.map((s) => ({
          id: s.id,
          competencies: s.competencies,
          situation: s.situation
        })),
        null,
        2
      )}\n\nJob description:\n\n${jobDescription}`
  })

  const known = new Set(bundle.stories.map((s) => s.id))
  const questions = Array.isArray(raw.likelyQuestions) ? raw.likelyQuestions : []
  const uncovered = Array.isArray(raw.uncoveredRequirements) ? raw.uncoveredRequirements : []

  return {
    likelyQuestions: questions
      .map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>
        const question = clamp(item.question, 400)
        if (!question) return null
        const storyId = clampNullable(item.storyId, 64)
        const [competency] = competencies([item.competency])
        return {
          question,
          // A story id that is not in the bank is the ungrounded case, and it
          // must read as "no story" rather than as a broken reference.
          storyId: storyId && known.has(storyId) ? storyId : null,
          competency: competency ?? 'ownership'
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, 20),
    uncoveredRequirements: uncovered
      .map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>
        const requirement = clamp(item.requirement, 300)
        if (!requirement) return null
        return { requirement, note: clamp(item.note, 400) }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, 12)
  }
}

export { MAX_BUNDLE_TOKENS as BUNDLE_TOKEN_BUDGET }
