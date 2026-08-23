/**
 * Does this question want code rather than a story?
 *
 * Runs on the *interim* transcript, before the provider is chosen, so it is a
 * local heuristic rather than a model call: a classifier round-trip would add
 * its own latency to the front of the slowest answer type in the app.
 *
 * It matches on question *intent*, never on vocabulary alone. "Tell me about a
 * hard technical decision" is dense with technical words and is a behavioural
 * question; firing on it would bury a STAR answer under a code block while the
 * user is mid-interview. So a behavioural opener disqualifies the line outright,
 * whatever else it contains.
 *
 * It will still be wrong sometimes. That is designed for rather than argued
 * away: the answer card carries a one-click override that re-runs the question
 * through the other path. The escape hatch is the feature; this is a tuning
 * exercise on top of it.
 */

import type { HueSettings } from './types.ts'

/**
 * Openers that mark a question as being about the candidate's past, not about
 * code. Checked first and allowed to veto: they are the reliable signal, and
 * the technical vocabulary that follows them is a description of the work, not
 * a request to write any.
 */
const BEHAVIOURAL_OPENERS = [
  'tell me about',
  'describe a time',
  'give me an example',
  'what did you learn',
  'why do you want',
  'how do you handle',
  'how do you approach',
  'what is the hardest',
  "what's the hardest",
  'have you ever'
]

/** Phrases that ask for something to be built, designed, or analysed. */
const CODING_INTENT = [
  'how would you implement',
  'how would you design',
  'how would you build',
  'how would you structure',
  'how would you write',
  'how would you solve',
  'write a function',
  'write a method',
  'write some code',
  'code up',
  'implement a',
  'implement an',
  'implement fizzbuzz',
  'design a function',
  'time complexity',
  'space complexity',
  'big o',
  'walk me through the algorithm',
  'what data structure',
  'which data structure',
  'database schema',
  'reverse a linked list'
]

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function looksLikeCodingQuestion(text: string): boolean {
  const line = normalise(text)
  if (line.length === 0) return false
  if (BEHAVIOURAL_OPENERS.some((opener) => line.includes(opener))) return false
  return CODING_INTENT.some((phrase) => line.includes(phrase))
}

export interface AssessmentRouting {
  assessment: boolean
  speak: boolean
  speculate: boolean
  maxTokens: number
}

/**
 * The routing decision for one question, as a pure function.
 *
 * Separate from `pipeline.ts` because that module imports browser globals and
 * cannot be loaded under `node --test`, which is the same reason
 * `answer-shape.ts` and `memory-policy.ts` live here. The decision is the part
 * worth pinning: everything else in the path is wiring.
 *
 * A code answer never speaks. TTS reading a code block aloud is noise at best,
 * and at worst it is audible to the interviewer through the user's own mic.
 *
 * It never speculates either. Speculation fires several drafts from the interim
 * transcript and throws away the ones that turn out wrong, which is a good trade
 * for short prose against the cheap drafting model and a bad one for the longest
 * answers in the app routed to the most expensive.
 */
export function assessmentRouting(s: HueSettings, question: string): AssessmentRouting {
  const assessment = s.assessmentEnabled && looksLikeCodingQuestion(question)
  return {
    assessment,
    // `speak` and `speculate` are permissions, not commands. False on an
    // assessment answer is absolute; true means "no objection from here", and
    // the caller still ANDs with its own state, so a companion-mode session
    // stays silent exactly as it does today.
    speak: !assessment,
    speculate: !assessment,
    maxTokens: assessment ? 1500 : 700
  }
}
