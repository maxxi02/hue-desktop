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
  'Keep the whole answer under about 120 words. It is read aloud at a glance, and a longer ' +
  'answer is one the user cannot find their place in.'

const STAR_SHAPE = 'Structure the answer using the STAR method (Situation, Task, Action, Result).'

const LIVE_SHAPE =
  'Give a tight, direct answer the user can say immediately. Brevity over completeness.'

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
