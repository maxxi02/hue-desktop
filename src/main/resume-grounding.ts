import type { Profile, ProfileBundle, Story } from './resume-types.ts'

/**
 * Ingest-time grounding. **Not** the same thing as `shared/grounding.ts`.
 *
 * The two share a name and nothing else. `shared/grounding.ts` reads `story_id`
 * receipts off a live draft and decides, at render time, whether an answer is
 * grounded in the bank. This file runs once at upload and asks a different
 * question: is the claim the extractor produced actually present in the
 * document it read? Merging them would break live grounding.
 *
 * Verifies that what the extractor returned is actually in the document it read.
 *
 * The system prompt tells the model not to invent employers. This file assumes
 * it did anyway. That is not pessimism about a particular model — it is that the
 * cost is wildly asymmetric: a hallucinated employer is read aloud, with
 * confidence, in a job interview. A deterministic check at ingest time is cheap
 * and catches the failure once, before it can ever reach a live session.
 *
 * Only *identity-bearing* fields are checked — company, title, institution,
 * metric values. Prose summaries and STAR narratives are paraphrase by design,
 * so a substring check on them would reject correct output.
 */

export type Severity = 'error' | 'warning'

export interface GroundingIssue {
  severity: Severity
  /** Dotted path into the bundle, e.g. `profile.roles[1].company`. */
  path: string
  field: string
  value: string
  message: string
}

export interface GroundingReport {
  ok: boolean
  issues: GroundingIssue[]
}

/**
 * Collapses the differences a PDF text layer introduces without collapsing the
 * differences that matter.
 *
 * Extractors emit ligatures, non-breaking spaces, and three kinds of dash; a
 * model normalises them. Comparing raw strings therefore flags correct
 * extractions as hallucinations, which is worse than not checking at all — a
 * check that cries wolf gets switched off.
 */
export function normalise(text: string): string {
  return (
    text
      .normalize('NFKD')
      // Strip combining marks so "Zürich" matches "Zurich".
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Every dash variant, including the minus sign and the non-breaking hyphen.
      .replace(/[‐-―−\u00ad]/g, '-')
      .replace(/[‘’‛′]/g, "'")
      .replace(/[“”″]/g, '"')
      .replace(/\u00a0/g, ' ')
      // Punctuation carries no identity: "Inc." and "Inc" are the same employer.
      .replace(/[.,;:!?()[\]{}'"`|/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** Corporate suffixes that appear on a letterhead and not in the body text. */
const SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|gmbh|plc|co|sa|ag|bv|pty|srl)\b/g

function looseCompany(text: string): string {
  return normalise(text).replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Is `needle` present in `haystack`?
 *
 * Whole-string containment first, then an all-tokens fallback. The fallback
 * exists because a two-column resume layout routinely interleaves the title and
 * the date range between the words of a company name, so "Acme Robotics" arrives
 * in the text layer as "Acme  2021–2024  Robotics". Requiring contiguity there
 * would reject a correct extraction.
 *
 * Tokens shorter than 3 characters are dropped from the fallback: "of", "&" and
 * "de" match everything and would let a fabricated name pass on its filler alone.
 */
export function containsClaim(haystack: string, needle: string): boolean {
  const hay = normalise(haystack)
  const need = normalise(needle)
  if (!need) return false
  if (hay.includes(need)) return true
  const tokens = need.split(' ').filter((t) => t.length >= 3)
  if (tokens.length === 0) return false
  return tokens.every((t) => hay.includes(t))
}

function companyPresent(haystack: string, company: string): boolean {
  if (containsClaim(haystack, company)) return true
  const loose = looseCompany(company)
  return loose.length > 0 && containsClaim(haystack, loose)
}

/**
 * Digits from a metric, in order.
 *
 * A metric is checked on its numbers rather than its wording, because "cut p99
 * latency 40%" and "40% p99 reduction" are the same verified fact and only one
 * of them is in the document. If the numbers aren't there, the figure is
 * invented — and an invented figure stated in an interview is unrecoverable.
 */
function digitsOf(text: string): string[] {
  return (
    (text.match(/\d[\d.,]*/g) ?? [])
      // Trailing separators belong to the sentence, not the number.
      .map((d) => d.replace(/[.,]+$/, ''))
      // Drop the separators themselves so "2.4M" and "2,400" compare on digits
      // alone — the resume's formatting is not part of the fact being checked.
      .map((d) => d.replace(/[.,]/g, ''))
  )
}

function metricPresent(haystack: string, value: string): boolean {
  const digits = digitsOf(value)
  // No digits at all means it isn't really a metric; let the text check decide.
  if (digits.length === 0) return containsClaim(haystack, value)
  const present = new Set(digitsOf(haystack))
  return digits.every((d) => present.has(d))
}

/**
 * Checks a profile against its source document.
 *
 * Companies, titles, and institutions are errors — they name real entities and a
 * wrong one is a fabrication. Metrics are errors too, for the same reason.
 * Dates and skills are warnings: date formats get normalised past recognition
 * ("Jan 2021" → "2021-01") and skills are frequently implied by a project
 * description rather than listed, so failing the ingest on either would reject
 * good bundles.
 */
export function checkProfile(profile: Profile, sourceText: string): GroundingIssue[] {
  const issues: GroundingIssue[] = []

  profile.roles.forEach((role, i) => {
    if (!companyPresent(sourceText, role.company)) {
      issues.push({
        severity: 'error',
        path: `profile.roles[${i}].company`,
        field: 'company',
        value: role.company,
        message: `Employer "${role.company}" does not appear in the source document.`
      })
    }
    if (!containsClaim(sourceText, role.title)) {
      issues.push({
        severity: 'error',
        path: `profile.roles[${i}].title`,
        field: 'title',
        value: role.title,
        message: `Job title "${role.title}" does not appear in the source document.`
      })
    }
    for (const tech of role.stack) {
      if (!containsClaim(sourceText, tech)) {
        issues.push({
          severity: 'warning',
          path: `profile.roles[${i}].stack`,
          field: 'stack',
          value: tech,
          message: `Technology "${tech}" is not stated in the source document.`
        })
      }
    }
  })

  profile.education.forEach((edu, i) => {
    if (!containsClaim(sourceText, edu.institution)) {
      issues.push({
        severity: 'error',
        path: `profile.education[${i}].institution`,
        field: 'institution',
        value: edu.institution,
        message: `Institution "${edu.institution}" does not appear in the source document.`
      })
    }
  })

  profile.metrics.forEach((metric, i) => {
    if (!metricPresent(sourceText, metric.value)) {
      issues.push({
        severity: 'error',
        path: `profile.metrics[${i}].value`,
        field: 'metric',
        value: metric.value,
        message: `Metric "${metric.value}" is not supported by the source document.`
      })
    }
  })

  profile.skills.forEach((skill, i) => {
    if (!containsClaim(sourceText, skill)) {
      issues.push({
        severity: 'warning',
        path: `profile.skills[${i}]`,
        field: 'skill',
        value: skill,
        message: `Skill "${skill}" is not stated in the source document.`
      })
    }
  })

  return issues
}

/**
 * Checks mined stories.
 *
 * A story's prose is paraphrase and is not checked. Two things are: the role it
 * claims to have happened at must exist, and any metric it says it may cite must
 * be one of the profile's verified metrics. The second is the one that matters —
 * `metrics` is exactly the list the model is told it may read aloud.
 *
 * Stories sourced from a gap answer are exempt from the metric check: the user
 * supplied a figure the resume never contained, which is the entire purpose of
 * the gap scan.
 */
export function checkStories(
  stories: Story[],
  profile: Profile,
  sourceText: string
): GroundingIssue[] {
  const issues: GroundingIssue[] = []
  const roleIds = new Set(profile.roles.map((r) => r.id))
  const verified = new Set(profile.metrics.map((m) => normalise(m.value)))

  stories.forEach((story, i) => {
    if (story.roleId !== null && !roleIds.has(story.roleId)) {
      issues.push({
        severity: 'error',
        path: `stories[${i}].roleId`,
        field: 'roleId',
        value: story.roleId,
        message: `Story "${story.id}" is attached to unknown role "${story.roleId}".`
      })
    }
    if (story.source === 'gap-answer') return
    for (const metric of story.metrics) {
      if (verified.has(normalise(metric))) continue
      if (metricPresent(sourceText, metric)) continue
      issues.push({
        severity: 'error',
        path: `stories[${i}].metrics`,
        field: 'metric',
        value: metric,
        message: `Story "${story.id}" cites unverified metric "${metric}".`
      })
    }
  })

  return issues
}

export function checkBundle(bundle: ProfileBundle, sourceText: string): GroundingReport {
  const issues = [
    ...checkProfile(bundle.profile, sourceText),
    ...checkStories(bundle.stories, bundle.profile, sourceText)
  ]
  return { ok: !issues.some((i) => i.severity === 'error'), issues }
}

/**
 * Removes everything that failed grounding, so an imperfect extraction still
 * produces a usable bundle.
 *
 * Dropping beats failing the whole ingest: a resume with one unparseable
 * employer should still give the user eleven good stories, and a bundle that
 * silently kept the bad row would poison every session it was cached for.
 * Warnings are left alone — they are advisory by construction.
 */
export function pruneUngrounded(
  profile: Profile,
  stories: Story[],
  sourceText: string
): { profile: Profile; stories: Story[]; dropped: GroundingIssue[] } {
  const dropped: GroundingIssue[] = []

  const keptRoles = profile.roles.filter((role, i) => {
    const bad = checkProfile(
      { ...profile, roles: [role], education: [], metrics: [], skills: [] },
      sourceText
    ).filter((issue) => issue.severity === 'error')
    if (bad.length) dropped.push(...bad.map((b) => ({ ...b, path: `profile.roles[${i}]` })))
    return bad.length === 0
  })

  const keptEducation = profile.education.filter((edu) =>
    containsClaim(sourceText, edu.institution)
  )
  const keptMetrics = profile.metrics.filter((m) => metricPresent(sourceText, m.value))

  const prunedProfile: Profile = {
    ...profile,
    roles: keptRoles,
    education: keptEducation,
    metrics: keptMetrics
  }

  const roleIds = new Set(keptRoles.map((r) => r.id))
  const keptStories = stories
    // A story whose role was dropped loses its anchor. Keep the story but
    // detach it rather than deleting it — the narrative is still the user's
    // own, and a story bank with holes in it is what makes the model improvise.
    .map((s) => (s.roleId !== null && !roleIds.has(s.roleId) ? { ...s, roleId: null } : s))
    .map((s) => ({
      ...s,
      metrics:
        s.source === 'gap-answer'
          ? s.metrics
          : s.metrics.filter((m) => metricPresent(sourceText, m))
    }))

  return { profile: prunedProfile, stories: keptStories, dropped }
}
