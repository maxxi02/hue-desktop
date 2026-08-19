/**
 * The speculation scheduler.
 *
 * Its job: turn a stream of interim transcripts into **at most one live draft**,
 * cheaply, and have that draft be correct by the time the interviewer stops
 * talking. It is what removes 700–1200 ms of LLM generation from the latency
 * budget — the difference between "Hue already knew" and "I'm standing here
 * waiting".
 *
 * Pure TypeScript: no Electron, no React, no I/O, no timers. It consumes events
 * and returns {@link Command}s; the caller performs them. That is deliberate,
 * and it is the reason this file exists at all: this is the highest-risk logic
 * in the product, and keeping it a pure function of (state, event) means the
 * whole behaviour matrix runs as fast unit tests against a fake clock rather
 * than as a live session against a live model.
 *
 * This is a port of `hue-mobile/core-speculation/.../SpeculationScheduler.kt`,
 * kept deliberately mechanical. The same rules must run on the phone, on
 * hue-edge and here, because a session can be mirrored across all three and two
 * implementations that disagree about which draft is current would render two
 * different answers to the same question. When you change a rule here, change
 * it there.
 *
 * Time is passed in rather than read: every entry point takes `now` (a
 * millisecond timestamp, `performance.now()` or `Date.now()` — only differences
 * matter). Nothing in this file reads a clock.
 */

/**
 * Who is talking.
 *
 * Imported as a shared vocabulary on Android rather than redeclared per module,
 * because a conversion whose only job is to rename three constants is a
 * conversion that will one day map the wrong one. `'self'` is the value that
 * stops Hue drafting an answer to the *user's own* voice, so mapping it wrong is
 * the worst bug in this component: Hue transcribes the user answering, treats it
 * as a new question, and drafts a reply to itself mid-sentence.
 */
export type Speaker = 'interviewer' | 'self' | 'unknown'

/** What the scheduler wants done. The caller owns the doing. */
export type Command =
  /** Start a speculative generation on `text`. Deltas carry `specId`. */
  | { kind: 'fire'; specId: number; text: string }
  /**
   * Abort the in-flight generation.
   *
   * Not optional politeness: a dangling generation both costs money and can win
   * a race and render the answer to a question that was withdrawn.
   */
  | { kind: 'abort'; specId: number }
  /** Promote the in-flight draft in place and un-dim the card. Zero visible latency. */
  | { kind: 'commit'; specId: number }
  /**
   * The final diverged too far from what was fired on. Keep the stale draft on
   * screen, dimmed, and generate afresh. Never blank the screen.
   */
  | { kind: 'regenerate'; specId: number; text: string }
  /** A new question began; clear the card. */
  | { kind: 'reset' }

export interface SchedulerConfig {
  /** Below this, the interim is still "so, uh, yeah —" and firing wastes tokens. */
  minWords: number
  /** How long the interim must stop changing before firing. */
  stableMs: number
  /** Fires per question. Past this, fall through to endpoint-then-generate. */
  maxFiresPerQuestion: number
  /** Token F1 at or above which a final is "the same question" and the draft commits. */
  commitThreshold: number
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  minWords: 8,
  stableMs: 400,
  maxFiresPerQuestion: 3,
  commitThreshold: 0.85
}

/**
 * Speculation hit rate is a first-class metric: below ~55% the trigger is too
 * eager and margin is burning for nothing. Tune the thresholds against this
 * number rather than against intuition.
 */
export interface SpeculationMetrics {
  fired: number
  committed: number
  aborted: number
  questions: number
  /** Drafts committed ÷ drafts fired. Zero rather than undefined before anything fires. */
  hitRate: number
  /** Fires per question — the cost multiplier speculation adds to a session. */
  firesPerQuestion: number
}

/**
 * Markers that mean the interviewer withdrew what they were saying.
 *
 * Matched as whole phrases mid-utterance. Cheap, and they catch the case a
 * prefix diff cannot: "…disagreed with your manager. Actually, let me ask
 * instead…" is still a prefix extension of what was fired on, so without this
 * the draft would run to completion and answer a question nobody asked.
 */
const RESET_MARKERS = [
  'actually',
  'let me rephrase',
  'let me ask',
  'sorry, different question',
  'different question',
  'scratch that',
  'never mind',
  'forget that'
]

/** Openers that make an utterance a question even without a question mark. */
const INTERROGATIVE_OPENERS = new Set([
  'what',
  'why',
  'how',
  'when',
  'where',
  'who',
  'which',
  'whose',
  'whom',
  'can',
  'could',
  'would',
  'will',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'is',
  'are',
  'was',
  'were',
  'should',
  'shall',
  'may',
  'might',
  // "Tell me about a time…" is the single most common behavioural prompt and is
  // not grammatically interrogative at all. Missing it would mean the scheduler
  // never speculates on the questions this product exists for.
  'tell',
  'describe',
  'walk',
  'give',
  'explain',
  'share'
])

/** Filler that routinely precedes the real opener in speech. */
const PREAMBLE = new Set(['so', 'and', 'but', 'ok', 'okay', 'now', 'right', 'then', 'well'])

/** How the current interim relates to the text the in-flight draft was fired on. */
type Invalidation = 'prefix-extension' | 'diverged' | 'withdrawn'

/** The generation currently in flight, if any. One at a time, ever. */
interface Draft {
  specId: number
  firedOn: string
}

export class SpeculationScheduler {
  private readonly config: SchedulerConfig

  private draft: Draft | null = null
  private latestInterim = ''
  private lastChangeAt = 0
  /** True once this interim has fired or been ruled out; prevents re-firing on every tick. */
  private triggeredForCurrentText = false
  private firesThisQuestion = 0
  private nextSpecId = 1
  private questionOpen = false

  private fired = 0
  private committed = 0
  private aborted = 0
  private questions = 0

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config }
  }

  get metrics(): SpeculationMetrics {
    return {
      fired: this.fired,
      committed: this.committed,
      aborted: this.aborted,
      questions: this.questions,
      hitRate: this.fired === 0 ? 0 : this.committed / this.fired,
      firesPerQuestion: this.questions === 0 ? 0 : this.fired / this.questions
    }
  }

  /**
   * The only `specId` whose deltas may be rendered.
   *
   * Null when nothing is in flight. This is the guard that prevents the worst
   * bug this product can have — confidently displaying the answer to the
   * *previous* question while the user reads it aloud.
   */
  get currentSpecId(): number | null {
    return this.draft?.specId ?? null
  }

  /** The renderer's gate. Every delta passes through this, no exceptions. */
  accepts(specId: number): boolean {
    return this.draft !== null && this.draft.specId === specId
  }

  /** Clears all per-question state. Called on a new question and on session start. */
  reset(): void {
    this.draft = null
    this.latestInterim = ''
    this.lastChangeAt = 0
    this.triggeredForCurrentText = false
    this.firesThisQuestion = 0
    this.questionOpen = false
  }

  /**
   * A new interim transcript arrived.
   *
   * `interrogative` is the provider's own signal (a question mark from the ASR
   * or a flagged trailing rise). Undefined means "no opinion", and the text is
   * judged on its own.
   */
  onInterim(
    text: string,
    speaker: Speaker,
    now: number,
    interrogative?: boolean | null
  ): Command[] {
    // The user's own voice never drives the pipeline. On the acoustic path the
    // machine hears them far louder than it hears the call, and without this Hue
    // transcribes the user's own answer as a new question and drafts a reply to
    // itself.
    if (speaker === 'self') return []

    const normalised = text.trim()
    if (normalised.length === 0) return []

    const commands: Command[] = []

    if (!this.questionOpen) {
      this.questionOpen = true
      this.questions += 1
    }

    if (normalised !== this.latestInterim) {
      this.latestInterim = normalised
      this.lastChangeAt = now
      this.triggeredForCurrentText = false
    }

    const inFlight = this.draft
    if (inFlight) {
      switch (invalidation(inFlight.firedOn, normalised)) {
        case 'prefix-extension':
          // Let it run. This is the case speculation is paid for.
          break
        case 'withdrawn':
          commands.push(this.abort(inFlight))
          // A withdrawn question is a *new* question, not a retry of this one:
          // reset the fire budget and clear the card, or the stale draft stays
          // on screen under a question it never answered.
          this.firesThisQuestion = 0
          commands.push({ kind: 'reset' })
          break
        case 'diverged':
          commands.push(this.abort(inFlight))
          break
      }
    }

    commands.push(...this.maybeFire(now, interrogative))
    return commands
  }

  /**
   * Time passed with no new interim.
   *
   * The trigger requires the text to be *stable* for 400 ms, and stability is
   * the absence of an event — so something has to observe it. The caller drives
   * this from a timer; tests drive it from a fake clock.
   */
  onTick(now: number, interrogative?: boolean | null): Command[] {
    return this.maybeFire(now, interrogative)
  }

  /**
   * ASR emitted a final. Decide whether the in-flight draft answers it.
   *
   * Token F1 rather than equality: an interim and its final differ constantly in
   * punctuation, filler, and the last word or two, and requiring an exact match
   * would throw away almost every draft that was in fact correct.
   */
  // `now` is unused: a final ends the question outright, so no stability window
  // is consulted. It stays in the signature because every entry point taking the
  // same (text, speaker, now) shape is what lets a caller drive all three from
  // one timestamp — and because the Kotlin it mirrors takes it too.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onFinal(text: string, speaker: Speaker, _now?: number): Command[] {
    // Self speech leaves the in-flight draft strictly alone. This looks like a
    // hole — the draft outlives the question that produced it — but it is the
    // product's central case: the user is reading that draft aloud right now.
    // Aborting it here would blank the card mid-sentence. (A draft stranded by a
    // mid-session mode flip is unwedged by the next interviewer final, which
    // reaches the commit/regenerate branch below.)
    if (speaker === 'self') return []

    const normalised = text.trim()
    const inFlight = this.draft

    // Whatever happens, this question is over.
    this.questionOpen = false
    this.latestInterim = ''
    this.triggeredForCurrentText = false

    if (!inFlight) {
      // Nothing was speculated — either the trigger never fired or the cap was
      // reached. Endpoint-then-generate, which is simply the unspeculated path,
      // at unspeculated latency.
      this.firesThisQuestion = 0
      return normalised.length === 0 ? [] : [this.fireCommand(normalised)]
    }

    this.draft = null
    this.firesThisQuestion = 0

    // An empty final is what Whisper emits for the breath or short silence that
    // ends a question — it is the absence of new text, not a new question. The
    // interim the draft was fired on is therefore still the best (and only)
    // reading of what was asked, so it commits. Falling through to the F1
    // comparison instead scored it zero, discarded a perfectly good draft, and
    // asked the model to generate an answer to the empty string.
    if (normalised.length === 0) {
      this.committed += 1
      return [{ kind: 'commit', specId: inFlight.specId }]
    }

    if (commits(inFlight.firedOn, normalised, this.config.commitThreshold)) {
      this.committed += 1
      return [{ kind: 'commit', specId: inFlight.specId }]
    }

    // Below threshold the draft answers a different question than the one that
    // was asked. Keep it on screen, dimmed — a stale hint beats an empty card
    // when someone is staring at you — and generate afresh.
    this.aborted += 1
    const specId = this.nextSpecId++
    this.draft = { specId, firedOn: normalised }
    this.fired += 1
    return [{ kind: 'regenerate', specId, text: normalised }]
  }

  private abort(inFlight: Draft): Command {
    this.draft = null
    this.aborted += 1
    return { kind: 'abort', specId: inFlight.specId }
  }

  private fireCommand(text: string): Command {
    const specId = this.nextSpecId++
    this.draft = { specId, firedOn: text }
    this.firesThisQuestion += 1
    this.fired += 1
    return { kind: 'fire', specId, text }
  }

  /** Fires if every trigger condition holds. Returns empty otherwise. */
  private maybeFire(now: number, interrogative?: boolean | null): Command[] {
    if (this.draft) return [] // one in flight, ever
    if (this.triggeredForCurrentText) return [] // already decided on this text
    if (this.latestInterim.length === 0) return []
    // Past the cap, stop speculating on this question and wait for the endpoint.
    // The cap is what keeps a session inside ~2.5x baseline tokens.
    if (this.firesThisQuestion >= this.config.maxFiresPerQuestion) return []
    if (tokens(this.latestInterim).length < this.config.minWords) return []
    if (now - this.lastChangeAt < this.config.stableMs) return []
    if (!isInterrogative(this.latestInterim, interrogative)) {
      // Not a question *yet*. Don't latch — the next word may make it one.
      return []
    }

    this.triggeredForCurrentText = true
    return [this.fireCommand(this.latestInterim)]
  }
}

/**
 * Does the final still answer what the draft was fired on?
 *
 * Two rules, and the first one matters more than the threshold does. A final
 * that merely *extends* the fire text is the case speculation exists for — the
 * invalidation rule already let the draft run through exactly that relationship,
 * so rejecting it at the commit gate would be incoherent. Token F1 on those same
 * two strings lands at 0.84 (precision 1.0, recall 8/11) purely because the
 * final is longer — a length penalty dressed up as a similarity score.
 *
 * Everything else is judged on F1, which is what the threshold is for: telling a
 * re-worded version of the same question from a different one.
 */
/**
 * How much longer than the fire text a prefix-extended final may be and still
 * commit.
 *
 * The prefix rule below exists because token F1 penalises a final that merely
 * got longer: "tell me about a time you disagreed with your manager" extended by
 * two words scores 0.84 and would be thrown away though the draft answers it
 * perfectly. That reasoning holds for a few trailing words and collapses at
 * scale. A draft fired on the opening clause of a question is a clean prefix of
 * the whole question and answers something quite different from it.
 *
 * The case is not hypothetical: `endpointing.ts` joins the segments of a
 * question split by a mid-sentence pause, so a final arriving at three times the
 * length of what was fired on is now an ordinary event rather than a freak one.
 *
 * Beyond this ratio the pair falls through to F1, which refuses and regenerates.
 */
export const MAX_PREFIX_GROWTH = 1.75

function commits(firedOn: string, final: string, threshold: number): boolean {
  const fired = tokens(firedOn)
  const ended = tokens(final)
  if (
    fired.length > 0 &&
    ended.length >= fired.length &&
    ended.length <= fired.length * MAX_PREFIX_GROWTH
  ) {
    let prefix = true
    for (let i = 0; i < fired.length; i++) {
      if (ended[i] !== fired[i]) {
        prefix = false
        break
      }
    }
    if (prefix) return true
  }
  return tokenF1(firedOn, final) >= threshold
}

function invalidation(firedOn: string, current: string): Invalidation {
  const addition =
    current.length > firedOn.length && current.startsWith(firedOn)
      ? current.slice(firedOn.length)
      : null
  // A reset marker appearing in what was added after the fire point means the
  // question is being withdrawn — even though it is a clean prefix extension and
  // every token before the fire point is untouched.
  if (addition !== null) {
    return containsResetMarker(addition) ? 'withdrawn' : 'prefix-extension'
  }
  if (current === firedOn) return 'prefix-extension'
  return containsResetMarker(current) ? 'withdrawn' : 'diverged'
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u

function containsResetMarker(text: string): boolean {
  const lower = text.toLowerCase()
  return RESET_MARKERS.some((marker) => {
    // Deliberately the *first* occurrence only, matching the Kotlin exactly. The
    // two implementations run against the same session on different devices, and
    // a scheduler that agrees with itself on every input matters more here than
    // catching a marker that appears twice with only the second one standing
    // alone.
    const at = lower.indexOf(marker)
    // Whole-word only: "factually" must not match "actually", and "I can tell
    // you what actually happened" is not a withdrawal when it is part of the
    // question being asked.
    return (
      at >= 0 &&
      (at === 0 || !ALPHANUMERIC.test(lower[at - 1])) &&
      (at + marker.length === lower.length || !ALPHANUMERIC.test(lower[at + marker.length]))
    )
  })
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 0)
}

function opensAQuestion(clause: string): boolean {
  const words = tokens(clause)
  if (words.length === 0) return false
  if (INTERROGATIVE_OPENERS.has(words[0])) return true
  // "So, tell me about a time…" and "And why did you…" are the normal spoken
  // forms; the real opener is one word in.
  return words.length > 1 && PREAMBLE.has(words[0]) && INTERROGATIVE_OPENERS.has(words[1])
}

function isInterrogative(text: string, hint?: boolean | null): boolean {
  // The provider's own signal outranks guessing from the text: it can hear a
  // trailing rise, and this cannot.
  if (hint !== undefined && hint !== null) return hint
  if (text.includes('?')) return true
  if (opensAQuestion(text)) return true
  // An interviewer rarely opens with the question. "We've been doing X for three
  // years now, why do you ask?" is one interim, and judging it on its first word
  // alone misses it entirely — so the trailing clause is checked too, since that
  // is where the live question is.
  //
  // This is deliberately eager. A false positive costs one fire, and the
  // per-question cap bounds that; a false negative costs the whole latency win
  // this component exists to buy.
  const clauses = text.split(/[.?!;,]/).filter((c) => c.trim().length > 0)
  const lastClause = clauses[clauses.length - 1]
  if (lastClause === undefined) return false
  return opensAQuestion(lastClause)
}

/**
 * Token F1 between two utterances.
 *
 * Symmetric, so neither "the final added three words" nor "the final dropped
 * three words" is privileged — both mean the same thing about whether the draft
 * still answers the question.
 *
 * Multiset intersection rather than set: a repeated word carries real signal
 * about whether these are the same sentence, and collapsing duplicates lets two
 * very different utterances score alike.
 */
export function tokenF1(a: string, b: string): number {
  const left = tokens(a)
  const right = tokens(b)
  if (left.length === 0 || right.length === 0) return 0

  const remaining = new Map<string, number>()
  for (const token of right) remaining.set(token, (remaining.get(token) ?? 0) + 1)

  let overlap = 0
  for (const token of left) {
    const count = remaining.get(token) ?? 0
    if (count > 0) {
      overlap += 1
      remaining.set(token, count - 1)
    }
  }
  if (overlap === 0) return 0

  const precision = overlap / left.length
  const recall = overlap / right.length
  return (2 * precision * recall) / (precision + recall)
}
