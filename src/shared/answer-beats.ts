/**
 * Split a labelled answer into the beats the model marked.
 *
 * The markers are app chrome. `LABELLED_SHAPE` tells the model to write
 * "## what" on a line of its own, and this strips it into a tag the card renders
 * in the margin. What the user reads aloud is the prose underneath, never the
 * marker. Same contract `story_id` already keeps, for the same reason: this
 * surface is read aloud under pressure, and anything on it that is not speakable
 * is a hazard.
 *
 * Supersedes `paragraphs()` on the answer card. That function stays for the
 * transcript pane, which has no markers in it.
 *
 * **Streaming safety is the whole difficulty here.** The answer arrives token by
 * token, so at some instant the buffer ends in "#", then "##", then "## wh". If
 * any of those render as prose, the card flashes garbage into the middle of a
 * sentence someone is reading out loud to an interviewer. A trailing line that
 * could still become a marker is therefore withheld until its newline lands.
 *
 * Recomputed on every render rather than memoised, exactly as `paragraphs()` is:
 * the answer streams, so a cache would be invalidated on every token anyway.
 *
 * Pure, and in `shared/` rather than beside the component, for the reason
 * `speculation.ts` gives: it is mirrored on the phone, and two implementations
 * that disagree about where a beat ends would render one answer two ways.
 */

export type BeatLabel = 'what' | 'why' | 'how' | 'when' | 'scenario'

/**
 * The closed vocabulary.
 *
 * Closed rather than "any word after ##" so a marker the model invents degrades
 * to prose instead of silently becoming a tag. It must agree exactly with the
 * markers `LABELLED_SHAPE` asks for; a marker the prompt requests and this does
 * not know would sit on screen as literal "## " text mid-answer.
 */
export const BEAT_LABELS: readonly BeatLabel[] = ['what', 'why', 'how', 'when', 'scenario']

export interface Beat {
  /** null when the model wrote no marker, or wrote one outside the vocabulary. */
  label: BeatLabel | null
  text: string
}

/** A marker: one or two hashes, one word, nothing else on the line. */
const MARKER = /^#{1,2}[ \t]*([a-z]+)[ \t]*$/i

/** Not yet a marker, but could still become one as more tokens arrive. */
const PARTIAL_MARKER = /^#{1,2}[ \t]*[a-z]*$/i

function isLabel(word: string): word is BeatLabel {
  return (BEAT_LABELS as readonly string[]).includes(word)
}

/**
 * Drop a trailing line that has not finished arriving and might be a marker.
 *
 * Only the last line can be incomplete, and only when the buffer does not end in
 * a newline: everything before that is settled and will not change.
 */
function withholdPartialMarker(raw: string): string {
  if (raw.endsWith('\n')) return raw
  const cut = raw.lastIndexOf('\n')
  const tail = raw.slice(cut + 1).trimStart()
  if (tail.length === 0 || tail[0] !== '#') return raw
  return PARTIAL_MARKER.test(tail) ? raw.slice(0, cut + 1) : raw
}

export function parseBeats(raw: string): Beat[] {
  const text = withholdPartialMarker(raw)
  const beats: Beat[] = []
  let label: BeatLabel | null = null
  let buffer: string[] = []

  const flush = (): void => {
    const body = buffer.join('\n').trim()
    // An empty body is a marker whose prose has not arrived yet. Emitting it
    // would render a bare tag against blank space.
    if (body.length > 0) beats.push({ label, text: body })
    buffer = []
  }

  for (const line of text.split('\n')) {
    const match = MARKER.exec(line.trim())
    const word = match ? match[1].toLowerCase() : null
    if (word !== null && isLabel(word)) {
      flush()
      label = word
      continue
    }
    // A blank line separates beats only while the answer is unlabelled. Once a
    // marker has been seen the markers own the boundaries, and a blank line is
    // spacing inside a section rather than the start of a new one.
    if (label === null && line.trim().length === 0) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return beats
}
