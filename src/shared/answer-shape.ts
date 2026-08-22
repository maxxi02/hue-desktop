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
  'Write the response in two parts. Each part begins with a marker alone on its own line. ' +
  'PART ONE is the answer the user speaks. Begin it with "## what", "## why", "## how", or ' +
  '"## when", whichever genuinely fits the question, and use at most two of them. This part ' +
  'must fully answer the question on its own: the approach taken, the tradeoff behind it, and ' +
  'enough of the reasoning that the interviewer hears how the user thinks. Someone who reads ' +
  'only this part and then stops speaking has given a complete, strong answer. Keep part one ' +
  'under about 70 words, which is roughly 30 seconds said out loud. ' +
  'PART TWO is optional and begins with "## scenario". It holds one real, specific moment from ' +
  'the background below, kept in reserve in case the interviewer asks for an example. It is ' +
  'never needed to complete the answer. Part one must never depend on it, refer to it, or trail ' +
  'off into it, because the user may choose not to say it at all. Keep part two under about 30 ' +
  'words, naming the situation and what came of it. ' +
  'Do not put a worked example inside part one. A specific number or name in passing is fine, ' +
  'but the story itself belongs in part two or nowhere. ' +
  'If no story in the background genuinely fits the question, omit "## scenario" entirely and ' +
  'let the response be part one alone. Never invent one, and never bend a story that does not ' +
  'apply: this part exists to be volunteered, so anything in it is a claim the user has chosen ' +
  'to make. ' +
  'Under each marker write plain speakable prose in the first person. The app strips the ' +
  'markers before the user sees them, so never mention them in the prose, and never write a ' +
  'heading, a label, a number, or a bullet of your own.'

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

/**
 * The shape of a code answer.
 *
 * Exported directly rather than reached through `answerShapeFor`, because
 * assessment is not an interview mode. It is orthogonal to practice, star and
 * live: someone in star mode who is asked to design a function still needs the
 * code answer. Folding it into that switch would make the two settings fight.
 *
 * Explanation leads and code supports, because the user is talking an
 * interviewer through a design rather than reading syntax aloud. The steps are
 * what gets said; the code is a prop they glance at.
 */
export const ASSESSMENT_SHAPE =
  'Write the response in up to four parts. Each part begins with a marker alone on its own line. ' +
  'PART ONE begins with "## approach" and is one sentence naming the shape of the answer, said ' +
  'first so the interviewer knows where this is going. Keep it under about 25 words. ' +
  'PART TWO begins with "## steps" and holds the ordered beats of the approach, each one a short ' +
  'sentence the user can say on its own while pointing at the code. Number them 1., 2., 3. This ' +
  'is the one place a number is wanted: it is what lets someone glance down, find their place, ' +
  'and carry on talking. Keep the whole part under about 120 words. ' +
  'PART THREE is optional and begins with "## code". It holds one compact block in whatever ' +
  'language the question implies. Write real, working code and keep it short enough to read at a ' +
  'glance. This part is never read aloud, so it is the only place in the response where ' +
  'punctuation, symbols and indentation are for the eye rather than the voice. ' +
  'PART FOUR is optional and begins with "## complexity" and gives time and space cost in under ' +
  'about 20 words. Include it only when the question is about an algorithm. ' +
  'Omit "## code" if the question is about approach rather than implementation, and omit ' +
  '"## complexity" if the question does not turn on cost. A part with nothing real to put in it ' +
  'is an instruction to invent something. ' +
  'Outside the code part, write plain speakable prose in the first person, and never write a ' +
  'heading, a label, or a bullet of your own. The app strips the markers before the user sees ' +
  'them, so never mention them in the prose.'

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
