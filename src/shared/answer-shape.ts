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
 * Four beats, each its own paragraph.
 *
 * The glance surface is read aloud while the interviewer is watching, so the
 * user looks down for a fraction of a second and needs to find their place
 * again. An unbroken paragraph gives the eye nothing to land on.
 *
 * The beats are a delivery aid, not an essay structure, which is why nothing on
 * screen announces them: no labels, no numbering, no signposting words. The
 * user must be able to read the whole thing aloud start to finish and have it
 * sound like one continuous answer.
 */
export const FOUR_BEAT_SHAPE =
  'Shape the answer as four short beats, each its own paragraph separated by a blank line. ' +
  'Beat one opens with the habit, the claim, or the direct response, and must stand alone as a ' +
  'complete answer if the user says nothing else. Beat two proves it with one real, specific ' +
  'example, named concretely rather than described in general terms. Beat three says what that ' +
  'taught the user or what it let them see. Beat four closes on the impact it had, in terms of ' +
  'what the work was worth rather than what was built. ' +
  'Keep each beat to one or two sentences. Write them as plain speakable prose in the first ' +
  'person: no headings, no labels, no numbering, no bullet points, and never a signposting word ' +
  'like "first" or "finally" announcing the structure. The blank lines are there so the user can ' +
  'find their place at a glance while reading aloud, so the four beats must still read as one ' +
  'continuous answer when spoken start to finish.'

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
      return FOUR_BEAT_SHAPE
  }
}
