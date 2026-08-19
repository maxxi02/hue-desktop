/**
 * When is a question actually over?
 *
 * The VAD answers "when the speaker stops for `redemptionMs`", and that answer
 * is wrong in the one case that matters most. An interviewer asking "walk me
 * through your brass tacks, when you are testing a new endpoint for the first
 * time" pauses in the middle of the sentence. The VAD closes the segment on the
 * breath, Hue answers the five-word fragment, and the second half arrives as a
 * separate question. Both answers are wrong and the user reads one of them
 * aloud.
 *
 * So a finished segment is held rather than shipped. If speech resumes inside
 * the hold, it is the back half of the same question and the two are joined.
 *
 * The gate is timing, not grammar, because the structure of an interview does
 * the work: after the interviewer genuinely finishes, the *candidate* talks.
 * Interviewer speech resuming a few hundred milliseconds later is essentially
 * never a new question. Punctuation cannot carry this decision. Whisper stamps a
 * confident full stop onto fragments, and "Walk me through your brass." has one.
 *
 * The hold costs no perceived latency when speculation is on, because the draft
 * is already in flight and still valid throughout it. That is the point:
 * speculation is not only a latency win, it is what buys the budget to endpoint
 * accurately.
 *
 * Pure, for the same reason `speculation.ts` is pure. No timers, no I/O, no
 * clock reads. `now` is passed in; the caller owns the timer.
 */

export interface EndpointConfig {
  /** Speech resuming within this of the last segment's end continues the question. */
  holdMs: number
  /**
   * Segments that may be joined into one question.
   *
   * A VAD segment is normally a sentence, but nothing guarantees it. An
   * interviewer who talks continuously, or line noise that keeps re-opening the
   * gate, would otherwise defer the answer indefinitely.
   */
  maxHeldSegments: number
}

export const DEFAULT_ENDPOINT_CONFIG: EndpointConfig = {
  holdMs: 700,
  maxHeldSegments: 3
}

export type HoldDecision =
  /** Wait until `until`. If nothing resumes by then, the question is over. */
  | { kind: 'hold'; until: number }
  /** Ship this now. Only returned when the segment cap is reached. */
  | { kind: 'complete'; text: string }

export class EndpointBuffer {
  private readonly config: EndpointConfig
  private segments: string[] = []
  private lastSegmentEndedAt = 0

  constructor(config: Partial<EndpointConfig> = {}) {
    this.config = { ...DEFAULT_ENDPOINT_CONFIG, ...config }
  }

  /** The question assembled so far. Empty when nothing is held. */
  get heldText(): string {
    return this.segments.join(' ')
  }

  /**
   * A VAD segment produced a final transcript.
   *
   * Blank finals are dropped rather than joined: Whisper emits one for the
   * breath that ends a question, and joining it would pad the question with
   * whitespace for nothing. The hold is still extended, because the breath is
   * exactly the moment a continuation is about to arrive.
   */
  onSegmentFinal(text: string, now: number): HoldDecision {
    const trimmed = text.trim()
    if (trimmed.length > 0) this.segments.push(trimmed)
    this.lastSegmentEndedAt = now

    if (this.segments.length >= this.config.maxHeldSegments) {
      const assembled = this.heldText
      this.reset()
      return { kind: 'complete', text: assembled }
    }
    return { kind: 'hold', until: now + this.config.holdMs }
  }

  /**
   * Speech resumed. True when it continues the held question.
   *
   * The caller cancels its pending hold timer on true, and treats false as the
   * ordinary start of a new utterance.
   */
  onSpeechStart(now: number): boolean {
    if (this.segments.length === 0) return false
    return now - this.lastSegmentEndedAt < this.config.holdMs
  }

  /**
   * The hold deadline passed. Returns the assembled question, or null if none.
   *
   * `now` is unused: reaching this method *is* the expiry, so there is nothing
   * left to compare against. It stays in the signature so every entry point
   * takes the same shape and one caller timestamp can drive all three, which is
   * the arrangement `speculation.ts` keeps for `onFinal`.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onHoldExpired(_now: number): { text: string } | null {
    if (this.segments.length === 0) return null
    const assembled = this.heldText
    this.reset()
    return { text: assembled }
  }

  reset(): void {
    this.segments = []
    this.lastSegmentEndedAt = 0
  }
}
