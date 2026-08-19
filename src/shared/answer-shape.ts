import type { InterviewMode } from './types.ts'

/**
 * The shape of a companion answer, per interview mode.
 *
 * Pure, and separate from `pipeline.ts` so it can be tested: the pipeline
 * imports browser globals and cannot be loaded under plain `node --test`, which
 * left the prompt's most load-bearing rules unpinned. Same arrangement as
 * `job-spec.ts` and `memory-policy.ts`, for the same reason.
 *
 * No em dashes or en dashes anywhere in this file. `HUMAN_VOICE_GUIDANCE`
 * forbids them in Hue's output, and an instruction that teaches a shape teaches
 * its own punctuation along with it. A test in `answer-shape.test.ts` enforces
 * this, because it has been got wrong before.
 */

/**
 * Labelled sections, and a real scenario as the second half.
 *
 * The glance surface is read aloud while the interviewer is watching, so the
 * user looks down for a fraction of a second and needs to find their place
 * again. An unbroken paragraph gives the eye nothing to land on.
 *
 * This replaces an earlier instruction that asked for four blank-line-separated
 * beats. That one was ignored in practice, and the cause was not the shape: it
 * sat at the end of a single run-on system prompt that had already told the
 * model to weave its example in "as part of the flow". Flow and separate blocks
 * cannot both be obeyed, and flow won. The prompt is sectioned now (see
 * `buildCompanionPrompt`) so this contract stops competing with a rule that
 * happens to sit beside it.
 *
 * The markers are app chrome, not speech. `answer-beats.ts` strips them and the
 * card renders them in the margin, so what the user reads aloud is the prose
 * underneath. Same contract `story_id` already keeps, for the same reason:
 * anything on this surface that is not speakable is a hazard.
 *
 * The scenario is deliberately optional. A mandatory half is a standing
 * instruction to invent one when the story bank has nothing that fits, which is
 * the exact failure the grounding rules exist to prevent.
 */
export const LABELLED_SHAPE =
  'Write the answer in labelled sections. Each section begins with a marker alone on its own ' +
  'line: "## what", "## why", "## how", "## when", or "## scenario". Use only those five ' +
  'markers, and choose the two or three that genuinely fit the question rather than using all ' +
  'of them. ' +
  'Under each marker write one or two sentences of plain speakable prose in the first person. ' +
  'The app strips the markers before the user sees the answer, so never mention them in the ' +
  'prose, and never write a heading, a label, a number, or a bullet of your own. ' +
  'The first section must stand alone as a complete answer if the user says nothing else. ' +
  'Close with "## scenario": one real, specific moment from the background below, named ' +
  'concretely rather than described in general terms. Size the answer so the scenario is about ' +
  'half of it and the sections above are the other half. ' +
  'If no story in the background genuinely fits the question, omit the "## scenario" section ' +
  'entirely and let the answer be the sections above. Never invent a scenario to fill the ' +
  'space, and never bend a story that does not apply. ' +
  'Keep the whole answer under about 90 words, which is roughly 40 seconds said out loud. ' +
  'The user has to speak the whole thing in a live interview while reading it at a glance, so a ' +
  'longer answer is one they lose their place in. Shorter is always fine.'

/**
 * Behavioural mode, and the longest of the three on purpose.
 *
 * A real interviewer asking "tell me about a time you disagreed with your
 * manager" expects something like a minute back, and probes further when the
 * answer runs short. Capping this at the same length as a quick factual reply
 * would coach the user into answers that read as evasive.
 */
const STAR_SHAPE =
  'Structure the answer using the STAR method (Situation, Task, Action, Result). ' +
  'Keep it under about 150 words, which is roughly a minute said out loud. ' +
  'That is what an interviewer expects for a behavioural question, so do not pad it to reach ' +
  'the limit and do not cut the result short to stay inside it.'

/**
 * The shortest, because this mode exists to be interrupted.
 *
 * "Brevity over completeness" was the whole instruction here for a long time,
 * with no number attached, and an abstract preference loses to the model's pull
 * toward thoroughness every time. Twenty seconds is what a quick factual answer
 * actually takes.
 */
const LIVE_SHAPE =
  'Give a tight, direct answer the user can say immediately. Brevity over completeness. ' +
  'Keep it under about 40 words, which is roughly 20 seconds said out loud. ' +
  'One or two sentences is usually right. If the honest answer is a single line, stop there.'

export function answerShapeFor(mode: InterviewMode): string {
  switch (mode) {
    case 'star':
      return STAR_SHAPE
    case 'live':
      return LIVE_SHAPE
    default:
      return LABELLED_SHAPE
  }
}
