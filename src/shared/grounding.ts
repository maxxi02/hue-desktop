/**
 * Grounding receipts — the desktop half of what `DraftParser` and
 * `GroundingCheck` do on the phone.
 *
 * `profilePromptBlock()` already tells the model: *"Select by competency tag.
 * Cite the chosen entry by its id as `story_id`. If no entry fits, return
 * `story_id: null` rather than inventing a story."* Until this module existed
 * nothing read that id back, so the instruction was decoration: a confident
 * answer built on a fabricated anecdote reached the screen with no signal on it
 * at all. This is the enforcement point for the rule the phone states as
 * invariant 3 — **never present a claim whose `story_id` is absent without the
 * ungrounded flag** — because the user needs to know when to improvise rather
 * than read confidently off the screen.
 *
 * ## The rule that matters most
 *
 * An id that is *not in the bank* is [Ungrounded]. Never a broken reference to
 * be surfaced as an error, never repaired. A model that names
 * `conflict-with-manager` when the bank holds `conflict-manager-roadmap` has not
 * made a typo — it has invented a story and labelled it, which is the single
 * most dangerous output this product can produce, because a fabricated citation
 * looks *more* trustworthy than no citation at all.
 *
 * That is also why there is no fuzzy matching here, and why there must never be
 * any: a Levenshtein-nearest or case-folded lookup converts exactly that
 * hallucination into a confident grounded receipt. The only normalisation
 * applied is undoing the two ways the prompt's own formatting comes back:
 * surrounding whitespace, and the square brackets `profilePromptBlock()` prints
 * ids in (`### [conflict-manager-roadmap]`), which models copy verbatim often
 * enough that rejecting them would flag real grounded answers as hallucinations.
 *
 * ## Where this differs from the phone
 *
 * `DraftParser` is an incremental JSON lexer because the phone renders cues
 * before the prose finishes, so it must observe `story_id` mid-stream and carry
 * a third `Pending` state. The desktop has no cue-first card: a turn is one
 * paragraph, and the citation is the *last* thing to arrive. A trailing citation
 * cannot be read off a partial stream, so parsing here runs once, on the
 * complete response. That collapses `Pending` entirely — `GroundingCheck
 * .finalise()`'s "at the end of a stream, no receipt means ungrounded" is simply
 * the default, which is why this module has two states rather than three.
 *
 * Pure TypeScript. No Electron, no React, no I/O — the bundle is passed in.
 */

import type { ProfileBundle, ProfileStory } from './profile'

/**
 * A response split into what the user should read and what the model cited.
 *
 * `answer` is the text with the citation scaffolding removed. The user must
 * never see a raw `story_id:` line: they are reading it under pressure, mid-call,
 * to say out loud.
 */
export interface ParsedResponse {
  answer: string
  /** The raw id exactly as the model wrote it, or null for an explicit `null`/absent citation. */
  storyId: string | null
}

/**
 * The receipt attached to an assistant turn.
 *
 * `claimedId` is kept on the ungrounded branch for diagnostics: a rising rate of
 * ids that are *nearly* bank entries is a prompt regression, and it is invisible
 * if this path discards what the model actually said.
 */
export type Grounding =
  | { kind: 'grounded'; story: ProfileStory }
  | { kind: 'ungrounded'; claimedId: string | null }

/**
 * Matches a whole line that is nothing but a citation.
 *
 * Two formats reach us, and both are the model echoing the shape it was given:
 *
 *  1. `story_id: conflict-manager-roadmap` — the prose path, which is what the
 *     desktop's companion prompt asks for. The citation is its own trailing line.
 *  2. `"story_id": "conflict-manager-roadmap"` — the JSON member from the wire
 *     contract `DraftParser` parses. Models that have seen the shared contract
 *     sometimes emit the member on its own line even in a prose answer, and a
 *     whole-document JSON reply is handled separately by [parseJsonResponse].
 *
 * Tolerated around it, all of it observed model formatting rather than meaning:
 * a markdown bullet or blockquote marker, `**bold**`/`_italic_`/`` `code` ``
 * wrappers, quotes around the key, and a trailing comma from a half-remembered
 * JSON shape.
 *
 * Anchored to a whole line on purpose. A prose answer that happens to *discuss*
 * a story id mid-sentence is prose, and cutting it out would delete words the
 * user was about to say.
 */
const CITATION_LINE =
  /^[ \t]*(?:[-*>]+[ \t]*)?(?:\*\*|__|`)?[ \t]*"?story_id"?[ \t]*(?:\*\*|__|`)?[ \t]*:[ \t]*(.*?)[ \t]*,?[ \t]*$/gim

/**
 * Matches a citation that has only *started* to arrive at the very end of the
 * buffer, so a half-written `story_i` never flashes on screen mid-stream.
 *
 * Display-only. It deliberately does not feed the grounding decision: an id
 * whose closing characters have not arrived is not an id, and treating a prefix
 * as a citation is the same class of error as fuzzy matching.
 */
const PARTIAL_CITATION_TAIL =
  /\n[ \t]*(?:[-*>]+[ \t]*)?(?:\*\*|__|`)?[ \t]*"?s(?:t(?:o(?:r(?:y(?:_(?:i(?:d"?[ \t]*(?:\*\*|__|`)?[ \t]*:?.*)?)?)?)?)?)?)?$/

/**
 * Undo the citation *syntax*.
 *
 * Markdown emphasis, code ticks, quotes and a trailing sentence stop belong to
 * the line the model wrote, not to the id — an id was never allowed to contain
 * them, so removing them cannot turn one bank entry into another. This is
 * deliberately separate from [normaliseId], which is held to the far stricter
 * whitespace-and-brackets-only rule because it operates on the id itself.
 */
function unwrapValue(raw: string): string {
  let value = raw.trim()
  value = value
    .replace(/^(?:\*\*|__|`)+/, '')
    .replace(/(?:\*\*|__|`)+$/, '')
    .trim()
  value = value.replace(/[.;,]+$/, '').trim()
  const quoted = /^(["'])(.*)\1$/.exec(value)
  if (quoted) value = quoted[2].trim()
  return value
}

/**
 * Normalises an id for lookup.
 *
 * Whitespace and the prompt's own square brackets, and nothing else. Every
 * character beyond that is signal about what the model believed it was citing.
 */
function normaliseId(id: string): string {
  const trimmed = id.trim()
  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  return unbracketed.trim()
}

/**
 * Reads a whole-document JSON reply, the shape `DraftParser` owns on the phone:
 * `{ "cues": [...], "story_id": "…", "answer": "…" }`.
 *
 * Hand-lexed there because a cue must be renderable before the closing brace
 * arrives. Here the document is already complete, so `JSON.parse` is the honest
 * implementation — and, like the phone's parser, a document that does not parse
 * is not repaired. Guessing at a malformed reply's intent is how scaffolding
 * reaches the screen.
 */
function parseJsonResponse(raw: string): ParsedResponse | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const doc = parsed as Record<string, unknown>
  if (typeof doc.answer !== 'string') return null
  const id = doc.story_id
  return {
    answer: doc.answer.trim(),
    storyId: typeof id === 'string' && id.trim() !== '' ? id : null
  }
}

/**
 * Splits a **complete** model response into the answer and its claimed id.
 *
 * Must not be called on a streaming delta: the citation is the last line to
 * arrive, so a partial response parses as "no citation" and would resolve to a
 * warning that then disappears. Use [stripStreamingCitation] for the mid-stream
 * display text and call this once, on done.
 *
 * Every citation line is stripped, not just the one whose value is used. If a
 * model emits the line twice the later one wins — it is the model's last word on
 * the question — but neither may be left on screen.
 */
export function parseResponse(raw: string): ParsedResponse {
  const json = parseJsonResponse(raw)
  if (json) return json

  const matches = [...raw.matchAll(CITATION_LINE)]
  const last = matches[matches.length - 1]
  const value = last ? unwrapValue(last[1]) : ''
  // `null` is the honest answer the prompt asks for when no entry fits, and an
  // empty value means the same thing. Rewarding that honesty with a grounded
  // receipt would teach exactly the wrong lesson. A response with no citation at
  // all lands here too: a missing receipt is not a parse failure, it resolves to
  // ungrounded like any other. That distinction only ever mattered on the phone,
  // where a missing citation could still be in flight.
  const storyId = value === '' || value.toLowerCase() === 'null' ? null : value

  return { answer: raw.replace(CITATION_LINE, '').trim(), storyId }
}

/**
 * Display text for a response that is still streaming.
 *
 * Removes any citation line that has fully arrived, plus a citation that has
 * only begun to. Grounding is never decided from this.
 */
export function stripStreamingCitation(raw: string): string {
  return raw.replace(CITATION_LINE, '').replace(PARTIAL_CITATION_TAIL, '').trimEnd()
}

/**
 * Resolves a claimed id against the user's own story bank.
 *
 * Anything that is not an exact (whitespace- and bracket-normalised) hit on a
 * bank id is ungrounded, including a near miss. See the header: repairing a near
 * miss is the one change to this function that would actively harm the user.
 */
export function resolveGrounding(claimedId: string | null, bundle: ProfileBundle): Grounding {
  if (claimedId === null) return { kind: 'ungrounded', claimedId: null }

  const normalised = normaliseId(claimedId)
  if (normalised === '') return { kind: 'ungrounded', claimedId: null }

  const story = bundle.stories.find((s) => s.id === normalised)
  // An empty bank grounds nothing, which is correct: a user who has uploaded no
  // resume has every answer flagged, and none of them are anchored to anything.
  return story ? { kind: 'grounded', story } : { kind: 'ungrounded', claimedId }
}

/** Parse and resolve in one step, for the caller holding a finished response. */
export function groundResponse(
  raw: string,
  bundle: ProfileBundle
): { answer: string; grounding: Grounding } {
  const parsed = parseResponse(raw)
  return { answer: parsed.answer, grounding: resolveGrounding(parsed.storyId, bundle) }
}

/**
 * A short human label for the story a grounded answer came from.
 *
 * `ProfileStory` has no title — it is a STAR record — so the receipt names the
 * story by its situation, which is the field a person recognises their own
 * anecdote from. The id is a slug the user never wrote and would have to decode;
 * "Sprint planning kept slipping in Q3" is instantly theirs.
 */
export function describeStory(story: ProfileStory, maxLength = 64): string {
  const firstSentence = story.situation.trim().split(/(?<=[.!?])\s/)[0] ?? ''
  const label = (firstSentence || story.situation.trim() || story.id).replace(/\s+/g, ' ')
  const bare = label.replace(/[.]+$/, '')
  if (bare.length <= maxLength) return bare
  return `${bare.slice(0, maxLength - 1).trimEnd()}…`
}
