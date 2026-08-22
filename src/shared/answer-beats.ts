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

export type BeatLabel =
  | 'what'
  | 'why'
  | 'how'
  | 'when'
  | 'scenario'
  // Assessment answers. Same mechanism, different kind of answer.
  | 'approach'
  | 'steps'
  | 'code'
  | 'complexity'

/**
 * The closed vocabulary.
 *
 * Closed rather than "any word after ##" so a marker the model invents degrades
 * to prose instead of silently becoming a tag. It must agree exactly with the
 * markers `LABELLED_SHAPE` asks for; a marker the prompt requests and this does
 * not know would sit on screen as literal "## " text mid-answer.
 */
export const BEAT_LABELS: readonly BeatLabel[] = [
  'what',
  'why',
  'how',
  'when',
  'scenario',
  'approach',
  'steps',
  'code',
  'complexity'
]

export interface Beat {
  /** null when the model wrote no marker, or wrote one outside the vocabulary. */
  label: BeatLabel | null
  text: string
}

/**
 * What the margin tag actually reads on screen.
 *
 * Separate from the marker vocabulary because the two answer different
 * questions. The marker is what the model writes; the tag is what the user
 * needs to know at a glance, mid-interview.
 *
 * `scenario` is the one that differs, and the difference is the whole point of
 * the block. The story is optional to say: it exists in case the interviewer
 * asks for an example, and the answer above is complete without it. Labelling it
 * "scenario" says what it is; labelling it "if they ask" says what to do with
 * it, which is the only thing worth reading under pressure.
 */
export const BEAT_LABEL_TEXT: Record<BeatLabel, string> = {
  what: 'what',
  why: 'why',
  how: 'how',
  when: 'when',
  scenario: 'if they ask',
  approach: 'approach',
  steps: 'steps',
  // Not "code". The tag says what to DO with the block, the way "if they ask"
  // does, and this is the one part of an answer that is never spoken.
  code: 'do not read aloud',
  complexity: 'complexity'
}

/** A beat whose body is code, and must be rendered verbatim rather than as prose. */
export function isCodeBeat(beat: Beat): boolean {
  return beat.label === 'code'
}

/** A marker: one or two hashes, one word, nothing else on the line. */
const MARKER = /^#{1,2}[ \t]*([a-z]+)[ \t]*$/i

/** Not yet a marker, but could still become one as more tokens arrive. */
const PARTIAL_MARKER = /^#{1,2}[ \t]*[a-z]*$/i

function isLabel(word: string): word is BeatLabel {
  return (BEAT_LABELS as readonly string[]).includes(word)
}

/**
 * Strip leading and trailing blank lines without touching indentation.
 *
 * `.trim()` cannot be used on a code body. It strips whitespace from the start
 * of the joined string, which is the first line's indentation, and leaves every
 * other line alone — so `    def f():\n        return 1` came back with its
 * first line dedented and its second not. That is corruption on ordinary input,
 * not on an exotic one.
 */
function trimBlankLines(lines: string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim().length === 0) start += 1
  while (end > start && lines[end - 1].trim().length === 0) end -= 1
  return lines.slice(start, end).join('\n')
}

export function parseBeats(raw: string): Beat[] {
  const beats: Beat[] = []
  let label: BeatLabel | null = null
  let buffer: string[] = []

  const flush = (): void => {
    // A code body is line-trimmed; prose is string-trimmed. See `trimBlankLines`.
    const body = label === 'code' ? trimBlankLines(buffer) : buffer.join('\n').trim()
    // An empty body is a marker whose prose has not arrived yet. Emitting it
    // would render a bare tag against blank space.
    if (body.length > 0) beats.push({ label, text: body })
    buffer = []
  }

  const lines = raw.split('\n')
  // Only the last line can still be arriving, and only when the buffer does not
  // end in a newline: everything before that is settled and will not change.
  const lastIsPartial = !raw.endsWith('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    // Inside a code beat only a marker at column zero closes it, so an indented
    // `## code` in a comment cannot split the block. Outside one, a marker is
    // recognised wherever it sits on the line, as it always was.
    const insideCode = label === 'code'
    const indented = line !== line.trimStart()
    const match = insideCode && indented ? null : MARKER.exec(insideCode ? line : line.trim())
    const word = match ? match[1].toLowerCase() : null
    if (word !== null && isLabel(word)) {
      flush()
      label = word
      continue
    }

    // Withhold a trailing line that has not finished arriving and could still
    // become a marker, so the card never flashes "##" mid-sentence.
    //
    // Suppressed inside a code beat, where a leading `#` is a comment rather
    // than a marker in progress: `PARTIAL_MARKER` matches `# key`, so the last
    // line of a block vanished and reappeared as each token landed.
    //
    // Decided here rather than by pre-scanning the buffer for the last marker.
    // A pre-scan has to re-derive which label is open, and re-deriving it from
    // "the last ## line" gets `## TODO` inside a block wrong — it would read as
    // leaving the code beat and re-arm this rule. The loop already knows.
    if (i === lines.length - 1 && lastIsPartial && !insideCode) {
      const tail = line.trimStart()
      if (tail.length > 0 && tail[0] === '#' && PARTIAL_MARKER.test(tail)) continue
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
