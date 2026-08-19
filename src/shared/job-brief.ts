import type { Competency } from './profile.ts'

/**
 * The job brief: questions this posting implies, each pointed at the story in
 * the user's own bank that answers it.
 *
 * Generated once per posting by `jobDescriptionBrief` (main/resume-pipeline.ts)
 * from the story bank plus the posting, and carried into every companion draft
 * as context. There is deliberately no matcher: the questions and their story
 * ids go into the prompt whole, and the model decides which one the interviewer
 * actually asked. A runtime matcher would be a second, weaker copy of a
 * judgement the model is already making with more context than it would have.
 *
 * `storyId` is validated against the bank at generation time, so it either
 * names a real story or is honestly null. That is what keeps the `story_id`
 * grounding receipt working: the brief can only point at material that exists.
 */
export interface JobBriefQuestion {
  question: string
  /** A story in the user's bank, or null when nothing in it fits. */
  storyId: string | null
  competency: Competency
}

export interface JobBrief {
  likelyQuestions: JobBriefQuestion[]
  uncoveredRequirements: { requirement: string; note: string }[]
}

/**
 * Caps, and they are load-bearing rather than tidiness.
 *
 * This block rides on EVERY draft on the hot path — the same warning the job
 * spec block carries. The generator allows up to 20 questions, and 20 questions
 * with their story ids is a latency regression on every answer of an interview,
 * paid to list questions the interviewer has mostly not asked.
 */
export const JOB_BRIEF_QUESTION_LIMIT = 10
export const JOB_BRIEF_BLOCK_LIMIT = 1800

/** One line per question, so a truncation loses whole questions and never half of one. */
function line(q: JobBriefQuestion): string {
  const target = q.storyId ? `story: ${q.storyId}` : 'no story in the bank covers this'
  return `- "${q.question}" -> ${target}`
}

export function parseJobBrief(json: string): JobBrief | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<JobBrief>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    // The question list is the brief. Without it there is nothing to carry, and
    // a half-parsed brief in the prompt is worse than none.
    if (!Array.isArray(parsed.likelyQuestions)) return null
    return {
      likelyQuestions: parsed.likelyQuestions,
      uncoveredRequirements: Array.isArray(parsed.uncoveredRequirements)
        ? parsed.uncoveredRequirements
        : []
    }
  } catch {
    return null
  }
}

/**
 * The brief, as prompt context.
 *
 * Returns '' when there is nothing to say, so the caller can push it
 * unconditionally and an empty brief costs the prompt nothing.
 */
export function jobBriefPromptBlock(brief: JobBrief): string {
  const questions = brief.likelyQuestions.slice(0, JOB_BRIEF_QUESTION_LIMIT)
  if (questions.length === 0) return ''

  const header = [
    '## Questions this posting implies, and the story that answers each',
    '',
    'Anticipated from the posting and matched against the user’s own story bank. ' +
      'When the interviewer asks something close to one of these, prefer the story named for ' +
      'it. Treat the mapping as a hint and not a rule: a question that merely resembles one ' +
      'below is still a different question, and forcing the named story onto it is worse than ' +
      'answering from the profile. Never invent a story id that is not in the bank, and never ' +
      'read this list aloud or mention that you were expecting a question.',
    ''
  ]

  const out = [...header]
  let used = out.join('\n').length
  for (const q of questions) {
    const rendered = line(q)
    // Whole lines only. A truncated question reads as a different question.
    if (used + rendered.length + 1 > JOB_BRIEF_BLOCK_LIMIT) break
    out.push(rendered)
    used += rendered.length + 1
  }

  // Every question fell outside the budget, so the header would stand over an
  // empty list and promise material that is not there.
  if (out.length === header.length) return ''
  return out.join('\n')
}
