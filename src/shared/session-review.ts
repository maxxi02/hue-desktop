/**
 * The post-session scorecard.
 *
 * Until this module existed the app was purely a live crutch: you finished a
 * session and everything vanished, so twenty rehearsals taught you no more than
 * one. Practice only compounds if something survives the session and says what
 * changed — which competencies came up, which of your own stories you actually
 * reached for, and what is still unanswered.
 *
 * The whole model is built out of the grounding receipts, and that is the point.
 * `Grounding` already records, per answer, exactly which bank entry the model
 * cited or that it cited nothing (see grounding.ts). "Stories you used" is
 * therefore not an inference: it is the set of grounded receipts, and the
 * ungrounded count is a real quality signal rather than a guess — a session
 * where most answers were unanchored is a session spent rehearsing improvisation,
 * which is worth knowing even when every individual answer sounded fine.
 *
 * ## What is deliberately *not* inferred
 *
 * A gap is counted as "touched" only when the session cited a story sharing its
 * competency tag. It is tempting to also keyword-match the interviewer's question
 * text ("failure" against the `failure` gap), and it would be wrong: a real
 * interviewer asks "tell me about a time something went badly", which matches no
 * tag, while the word "conflict" turns up in answers about merge conflicts. A
 * scorecard that guesses wrong tells the user a gap is handled when it isn't.
 * Structured evidence only, exactly as grounding.ts refuses to fuzzy-match ids.
 *
 * Pure TypeScript. No React, no Electron, no I/O, no clock — the turns and the
 * bundle are passed in, so the whole thing is a unit-testable function.
 */

import type { ProfileBundle, ProfileGap, ProfileStory } from './profile'
// Explicit .ts extension: this is the first module in src/shared to import a
// *value* (not just a type) from a sibling. Type-only imports are erased, so
// they resolve under `node --test` without one — a runtime import does not.
// Both tsconfigs allow the extension (they typecheck with --noEmit), and Vite
// resolves it, so this is the one spelling that satisfies the runner, the
// compiler and the bundler at once.
import { describeStory, type Grounding } from './grounding.ts'

/**
 * One turn of a finished session, reduced to the only field the review reads.
 *
 * `grounding` is absent on user turns and on an assistant turn that never
 * finished streaming, and those two cases collapse on purpose: a turn with no
 * receipt is not an answer this review can say anything about, and counting it
 * as ungrounded would inflate the failure rate with the user's own questions.
 */
export interface ReviewTurn {
  role: 'user' | 'assistant'
  grounding?: Grounding
}

/** A story the session actually cited, with how often. */
export interface StoryUse {
  storyId: string
  /** The story named the way the user recognises it — see describeStory. */
  label: string
  competencies: string[]
  count: number
}

/** A story in the bank that never came up. */
export interface StoryRest {
  storyId: string
  label: string
  competencies: string[]
}

/** An open gap, carried with its question so the panel can show what to answer. */
export interface OpenGap {
  id: string
  competency: string
  question: string
}

export interface AnswerCounts {
  /** Answers that carried a receipt. User turns and unfinished turns are excluded. */
  total: number
  grounded: number
  ungrounded: number
}

export interface SessionReview {
  /**
   * False when there is no profile bundle at all — a legacy install, or someone
   * who never uploaded a resume. The UI renders this as "no profile, so no
   * scorecard" rather than as a session in which nothing went right.
   */
  hasProfile: boolean
  answers: AnswerCounts
  /** Competency tags of the cited stories only, deduped and sorted. */
  competencies: string[]
  /** Cited stories, most-used first; a story cited twice appears once. */
  storiesUsed: StoryUse[]
  /** Bank entries never cited, in bank order. */
  storiesUnused: StoryRest[]
  /** Open gaps whose competency the session did cover — adjacent ground was walked. */
  openGapsTouched: OpenGap[]
  /** Open gaps the session never approached at all. The real to-do list. */
  openGapsUntouched: OpenGap[]
}

function toOpenGap(gap: ProfileGap): OpenGap {
  return { id: gap.id, competency: gap.competency, question: gap.question }
}

function rest(story: ProfileStory): StoryRest {
  return {
    storyId: story.id,
    label: describeStory(story),
    competencies: [...story.competencies]
  }
}

/**
 * Builds the review for a finished session.
 *
 * `bundle` is nullable rather than required: the review is computed at the
 * moment a session ends, which is the one moment the app must not throw, and an
 * install with no profile is a perfectly ordinary state.
 */
export function reviewSession(
  turns: readonly ReviewTurn[],
  bundle: ProfileBundle | null
): SessionReview {
  const receipts: Grounding[] = []
  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.grounding) receipts.push(turn.grounding)
  }

  // Counted before the bundle check so an install with no profile still gets an
  // honest "5 answers, none of them anchored" rather than a silent zero.
  const grounded = receipts.filter((r) => r.kind === 'grounded')
  const answers: AnswerCounts = {
    total: receipts.length,
    grounded: grounded.length,
    ungrounded: receipts.length - grounded.length
  }

  if (!bundle) {
    return {
      hasProfile: false,
      answers,
      competencies: [],
      storiesUsed: [],
      storiesUnused: [],
      openGapsTouched: [],
      openGapsUntouched: []
    }
  }

  // Count by id, keeping the story object from the receipt itself. The receipt
  // carries the whole entry, so a story that has since been removed from the
  // bank still describes itself rather than degrading to a bare slug.
  const uses = new Map<string, StoryUse>()
  for (const receipt of grounded) {
    if (receipt.kind !== 'grounded') continue
    const existing = uses.get(receipt.story.id)
    if (existing) {
      existing.count += 1
      continue
    }
    uses.set(receipt.story.id, {
      storyId: receipt.story.id,
      label: describeStory(receipt.story),
      competencies: [...receipt.story.competencies],
      count: 1
    })
  }

  // Most-used first; ties broken by label so the order is stable across renders
  // and across a reload of the same stored session.
  const storiesUsed = [...uses.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label)
  )

  const competencies = [...new Set(storiesUsed.flatMap((u) => u.competencies))].sort()
  const covered = new Set(competencies)

  const storiesUnused = bundle.stories.filter((s) => !uses.has(s.id)).map(rest)

  // 'skipped' is not open: the user was asked and declined, so listing it as
  // outstanding work would nag them with a decision they already made.
  const open = bundle.gaps.filter((g) => g.status === 'open')

  return {
    hasProfile: true,
    answers,
    competencies,
    storiesUsed,
    storiesUnused,
    openGapsTouched: open.filter((g) => covered.has(g.competency)).map(toOpenGap),
    openGapsUntouched: open.filter((g) => !covered.has(g.competency)).map(toOpenGap)
  }
}

/**
 * A one-line summary, in the shape `describeBundle` established for Settings.
 *
 * Leads with the anchored count rather than the total, because "9 of 12 answers
 * came from your own history" is the sentence that tells the user whether the
 * session was rehearsal or invention.
 */
export function describeReview(review: SessionReview): string {
  if (review.answers.total === 0) return 'No answers in this session'
  if (!review.hasProfile) {
    return `${review.answers.total} ${review.answers.total === 1 ? 'answer' : 'answers'} · no profile`
  }
  const parts = [`${review.answers.grounded} of ${review.answers.total} answers from your bank`]
  const c = review.competencies.length
  if (c > 0) parts.push(`${c} ${c === 1 ? 'competency' : 'competencies'}`)
  return parts.join(' · ')
}
