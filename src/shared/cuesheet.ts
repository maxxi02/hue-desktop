/**
 * Cue sheet matching.
 *
 * Pure TypeScript: no Electron, no React, no I/O, no timers, no clock reads —
 * the same discipline `speculation.ts` keeps, for the same reason. The whole
 * behaviour matrix has to run as fast unit tests against a fixture corpus
 * rather than as a live session against a live model.
 *
 * ## Why this does not use `tokenF1`
 *
 * `speculation.ts` already exports a token-overlap score, and reusing it looks
 * obviously right until you read what depends on it. Its private `tokens()`
 * helper is shared by `commits()`, `opensAQuestion()` and therefore
 * `isInterrogative()`; `commits()` short-circuits on a token-prefix check
 * before F1 is ever reached; and `commitThreshold` is calibrated against a
 * worked example written into that file's own doc comment. `tokenF1` has no
 * direct unit test, so a change there would regress the commit gate silently.
 *
 * The two scores also want opposite things. The scheduler asks *did the
 * question I fired on survive to the final*, which wants strict literal
 * similarity. This asks *is this one of the questions the user prepared for*,
 * which wants deliberate looseness. One scorer serving both is tuned for
 * neither.
 */

/**
 * Words carrying no discriminating signal in an interview question.
 *
 * Deliberately small. Every word removed here is a word that can no longer
 * distinguish two cue cards, and interview questions are short — over-pruning
 * costs more than it saves.
 */
const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'just', 'like', 'me',
  'my', 'of', 'on', 'or', 'so', 'some', 'tell', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'time', 'to', 'us', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your'
])

/**
 * Unicode-aware, unlike `speculation.ts`'s `tokens()`.
 *
 * That helper splits on `[^a-z0-9']+`, which makes every accented or
 * non-Latin character a separator. Tolerable where it is; here it would
 * silently shred any cue sheet not written in ASCII, and the user would see a
 * matcher that simply never fires.
 */
export function cueTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
}

function bigrams(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`)
  return out
}

/**
 * Document frequency across the sheet's own trigger set.
 *
 * Rarity is measured against the cue sheet, not against English. A word that
 * appears in every card cannot choose between them however rare it is in
 * general usage — "pharma" is highly distinctive in the abstract and useless
 * on a sheet where every card mentions it.
 */
export function buildDf(targets: string[]): { df: Map<string, number>; docCount: number } {
  const df = new Map<string, number>()
  for (const target of targets) {
    const t = cueTokens(target)
    for (const term of new Set([...t, ...bigrams(t)])) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  return { df, docCount: targets.length }
}

/** Inverse document frequency, floored at zero so a universal term is worth nothing. */
function idf(term: string, df: Map<string, number>, docCount: number): number {
  if (docCount === 0) return 1
  const seen = df.get(term) ?? 0
  if (seen >= docCount) return 0
  return Math.log(docCount / Math.max(seen, 1))
}

/** Bigram matches weigh this much more than unigram matches. */
const BIGRAM_WEIGHT = 2.5

/**
 * Weighted overlap of `query` against `target`, normalised by the target's own
 * total weight so scores are comparable across cards of different lengths.
 *
 * Recall-oriented on purpose: the query is a live transcript that may carry a
 * whole clause of unrelated preamble, and penalising that would push every
 * real match below threshold.
 */
export function scoreAgainst(
  query: string,
  target: string,
  df: Map<string, number>,
  docCount: number
): number {
  const q = cueTokens(query)
  const t = cueTokens(target)
  if (t.length === 0) return 0

  const queryTerms = new Set([...q, ...bigrams(q)])

  let matched = 0
  let total = 0
  const score = (term: string, weight: number): void => {
    const w = idf(term, df, docCount) * weight
    total += w
    if (queryTerms.has(term)) matched += w
  }

  for (const term of new Set(t)) score(term, 1)
  for (const term of new Set(bigrams(t))) score(term, BIGRAM_WEIGHT)

  return total === 0 ? 0 : matched / total
}

export interface CueCard {
  id: string
  heading: string
  /** 3–5 bold lines. This is what renders. */
  cues: string[]
  /** The full prepared passage, behind a disclosure. Extractive from the source. */
  script: string
  /** ~8–15 paraphrases. Never rendered, never spoken — a search index only. */
  triggers: string[]
}

export interface CueSheet {
  id: string
  label: string
  sourceHash: string
  createdAt: string
  cards: CueCard[]
}

export interface MatchResult {
  cardId: string | null
  score: number
  /** Winner's lead over the runner-up. Zero when fewer than two cards scored. */
  margin: number
  /**
   * The utterance looks like someone reading an answer aloud rather than asking
   * a question. See the recitation guard below.
   */
  recited: boolean
}

export interface MatchConfig {
  /** Above this (with margin), stop generating for this question. */
  suppressThreshold: number
  /** Above this (with margin), latch the card at the final. */
  renderThreshold: number
  /** How far the winner must lead the runner-up, at both gates. */
  margin: number
  /** Script-score ÷ trigger-score above which an utterance is a recitation. */
  recitationRatio: number
}

/**
 * Suppression is set high and render low on purpose, and the asymmetry is the
 * whole safety argument. A wrong suppression risks no draft *and* no cue — a
 * blank card mid-interview, the worst outcome in the system. A wrong render is
 * merely visibly wrong and costs the user a glance.
 *
 * Calibrated against the fixture corpus in `cuesheet-corpus.test.ts` (3 sheets
 * / 15 cards / 90 positive cases / 21 negative cases spanning technical
 * support, backend engineering, and project management). Do not hand-tune
 * these against intuition; move the corpus numbers instead.
 *
 * `suppressThreshold: 0.72` and `margin: 0.02` produce zero false
 * suppressions across the whole corpus (the only test that must be exactly
 * zero) with real headroom: the highest score any wrong card reaches on an
 * expect-something case is 0.594, well under 0.72.
 *
 * `renderThreshold: 0.1` is the render threshold's true ceiling under the
 * zero-false-render constraint, not a preference — grid search over the
 * corpus's precomputed match scores shows 0.1/0.02 is the unique optimum:
 * every combination of `renderThreshold` and `margin` that keeps negative
 * cases from rendering caps hit rate at 0.722 (65/90); the moment either
 * knob is loosened enough to reach the 0.75 target, one negative case starts
 * rendering ("How many tickets do you typically close in a day?" scores
 * 0.098 against the ticket-prioritization card, purely off the shared word
 * "tickets" — a real adjacent-question collision, not a corpus artifact).
 * The hit-rate bar is documented as soft (>= 0.75 target) while the
 * zero-false-render property is not, so this file ships 0.722 rather than
 * trade a real false render for 3 more hits. See the comment in
 * `cuesheet-corpus.test.ts` for the full finding.
 */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  suppressThreshold: 0.72,
  renderThreshold: 0.1,
  margin: 0.02,
  recitationRatio: 1.3
}

export class CueMatcher {
  private readonly config: MatchConfig
  private readonly df: Map<string, number>
  private readonly docCount: number
  private readonly scriptDf: Map<string, number>
  private readonly scriptCount: number
  private readonly sheet: CueSheet

  constructor(
    sheet: CueSheet,
    config: Partial<MatchConfig> = {}
  ) {
    this.sheet = sheet
    this.config = { ...DEFAULT_MATCH_CONFIG, ...config }
    const triggers = sheet.cards.flatMap((c) => c.triggers)
    const built = buildDf(triggers)
    this.df = built.df
    this.docCount = built.docCount
    const scripts = buildDf(sheet.cards.map((c) => c.script))
    this.scriptDf = scripts.df
    this.scriptCount = scripts.docCount
  }

  match(transcript: string): MatchResult {
    let best = { cardId: null as string | null, score: 0 }
    let runnerUp = 0

    for (const card of this.sheet.cards) {
      let cardScore = 0
      for (const trigger of card.triggers) {
        const s = scoreAgainst(transcript, trigger, this.df, this.docCount)
        if (s > cardScore) cardScore = s
      }
      if (cardScore > best.score) {
        runnerUp = best.score
        best = { cardId: card.id, score: cardScore }
      } else if (cardScore > runnerUp) {
        runnerUp = cardScore
      }
    }

    return {
      cardId: best.cardId,
      score: best.score,
      margin: best.score - runnerUp,
      recited: this.looksRecited(transcript, best.score)
    }
  }

  /**
   * The recitation guard.
   *
   * `Speaker` on desktop is a settings lookup — `hueMode === 'companion'` means
   * every utterance is labelled `interviewer`, including the user's own voice.
   * Whether Hue hears the user at all depends on `audioSource`: loopback hears
   * only the far side, but `'mic'` hears the room. So when the user delivers
   * their answer off a cue card, that speech arrives labelled as the
   * interviewer and matches the card being read almost verbatim.
   *
   * Triggers are questions and scripts are answers, and they are lexically
   * distinct enough to separate: an utterance scoring far better against the
   * scripts than against the triggers is someone reciting, not asking.
   */
  private looksRecited(transcript: string, triggerScore: number): boolean {
    let scriptScore = 0
    for (const card of this.sheet.cards) {
      const s = scoreAgainst(transcript, card.script, this.scriptDf, this.scriptCount)
      if (s > scriptScore) scriptScore = s
    }
    if (scriptScore === 0) return false
    if (triggerScore === 0) return scriptScore > this.config.renderThreshold
    return scriptScore / triggerScore >= this.config.recitationRatio
  }

  suppresses(r: MatchResult): boolean {
    return (
      !r.recited &&
      r.cardId !== null &&
      r.score >= this.config.suppressThreshold &&
      r.margin >= this.config.margin
    )
  }

  renders(r: MatchResult): boolean {
    return (
      !r.recited &&
      r.cardId !== null &&
      r.score >= this.config.renderThreshold &&
      r.margin >= this.config.margin
    )
  }

  card(id: string): CueCard | undefined {
    return this.sheet.cards.find((c) => c.id === id)
  }
}

import type { Command } from './speculation'

export interface LatchState {
  /** The card currently on screen, or null. Holds until the next question. */
  cardId: string | null
}

export function newLatchState(): LatchState {
  return { cardId: null }
}

export interface GateDecision {
  suppress: boolean
  latch: string | null
  isFinal: boolean
}

/**
 * Filters the scheduler's commands without modifying the scheduler.
 *
 * `SpeculationScheduler` is ported verbatim to `hue-mobile/core-speculation`
 * and `hue-edge`; making it cue-aware would mean the same change in three
 * places and would couple a desktop-first feature to the phone and the edge.
 * So the rules live out here, on the caller's side of the boundary.
 *
 * Returns the commands to actually perform, plus whether the caller must call
 * `scheduler.reset()` afterwards when a mid-question fire is suppressed.
 *
 * ## Suppression recovery
 *
 * When a speculative fire is suppressed mid-question, the scheduler believes a
 * draft is in flight (its `draft` is set), but we never sent it. Without a reset,
 * the scheduler's `accepts(specId)` will reject the deltas we *do* want, and
 * later when the final arrives, `onFinal` emits a fire for endpoint-then-generate.
 *
 * At the final, a fire is the only possible recovery — never suppress it.
 * Suppressing the endpoint fire leaves the question blank, the worst outcome
 * this feature exists to prevent.
 */
export function gateCommands(
  commands: Command[],
  state: LatchState,
  decision: GateDecision
): { commands: Command[]; resetScheduler: boolean } {
  let resetScheduler = false
  const out: Command[] = []

  if (decision.latch !== null) state.cardId = decision.latch

  for (const command of commands) {
    switch (command.kind) {
      case 'fire':
        // A mid-question fire can be suppressed if a cue card matched. At the final,
        // a fire is the endpoint-then-generate recovery and must pass through —
        // there is no other path to an answer.
        if (decision.suppress && !decision.isFinal) {
          resetScheduler = true
          continue
        }
        out.push(command)
        break

      case 'regenerate':
        // A latched card is the answer. While it is on screen, regenerating over
        // it would replace the user's own prepared words with the model's, which is
        // the whole thing this feature exists to avoid. A new question (reset)
        // clears the latch, so the next question generates normally.
        if (state.cardId !== null) continue
        out.push(command)
        break

      case 'reset':
        // A new question. The latch does not survive it — that is what makes
        // the card stable for the entire duration of the user's answer and no
        // longer.
        state.cardId = null
        out.push(command)
        break

      default:
        // abort and commit always pass through, or scheduler state and the
        // renderer's view of it drift apart.
        out.push(command)
    }
  }

  return { commands: out, resetScheduler }
}

/**
 * Cue grounding.
 *
 * `src/shared/grounding.ts` is deliberately not used and must not be extended
 * to cover this. It resolves one `story_id` against `bundle.stories` by exact
 * match, is hard-coupled to `ProfileBundle`, and its header forbids ever
 * adding fuzzy matching — because an id merely *near* a bank entry is an
 * invented story wearing a real label. "Is this id in the bank" and "is this
 * sentence in the source document" are different questions, and merging them
 * would weaken the strictest check in the product.
 */

/**
 * Negation tokens that must appear in a cue if they appear in the covered span
 * of the script. Contractions retain apostrophes (cueTokens does not split on
 * them), so the set includes forms like "didn't".
 */
const NEGATIONS = new Set([
  'not', 'never', 'no', 'nor', 'none', 'cannot', 'nothing', 'without',
  "didn't", "doesn't", "wasn't", "wouldn't", "couldn't", "shouldn't",
  "isn't", "aren't", "won't", "hadn't", "hasn't", "haven't"
])

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * The script must be a span the user actually wrote, not prose about it.
 *
 * Ingest is instructed to select rather than compose, which turns verification
 * into containment rather than a judgement call — the only kind of grounding
 * check that cannot itself be wrong.
 */
export function scriptIsExtractive(script: string, source: string): boolean {
  const s = normalise(script)
  return s.length > 0 && normalise(source).includes(s)
}

/**
 * Drops cues that introduce content absent from their own card's script.
 *
 * Degrades a card, never invalidates a sheet: a card with two good cues is
 * still useful, and refusing the whole sheet over one bad compression would
 * make the feature fail closed for no safety gain.
 *
 * A cue is accepted only if:
 * 1. Its token array is non-empty (rejects all-stopword cues).
 * 2. Its tokens form an order-preserving subsequence of the script's tokens.
 * 3. Any negation tokens in the covered span of the script appear in the cue.
 *
 * ACCEPTED TRADEOFF: A cue that reorders content for readability (e.g. "Cut
 * payload, reduced latency" from "reduced latency by cutting the payload") is
 * rejected. Dropping a good cue degrades a card; keeping a misleading one puts
 * a false claim in the user's mouth. The asymmetry is deliberate. Later ingest
 * prompts request order-preserving compression.
 */
export function verifyCard(card: CueCard, source: string): CueCard {
  const script = scriptIsExtractive(card.script, source) ? card.script : ''
  const st = cueTokens(script)

  return {
    ...card,
    script,
    cues: card.cues.filter((cue) => {
      const ct = cueTokens(cue)

      // 1. Reject empty token arrays (all-stopword cues).
      if (ct.length === 0) return false

      // 2. Check order-preserving subsequence: each cue token must be found
      //    in the script tokens in order, with increasing indices.
      let stIdx = 0
      let firstIdx = -1
      let lastIdx = -1

      for (const cueToken of ct) {
        // Find this cue token in the remaining tail of st.
        while (stIdx < st.length && st[stIdx] !== cueToken) {
          stIdx++
        }

        // If not found, the cue is not a subsequence.
        if (stIdx >= st.length) return false

        // Record the first and last indices where cue tokens matched.
        if (firstIdx === -1) firstIdx = stIdx
        lastIdx = stIdx
        stIdx++
      }

      // 3. Check negation parity: every negation in the covered span must
      //    also appear in the cue. The covered span includes any negations
      //    that appear before or within the extracted content.
      const covered = st.slice(0, lastIdx + 1)
      const cueNegations = new Set(ct.filter((t) => NEGATIONS.has(t)))
      for (const token of covered) {
        if (NEGATIONS.has(token) && !cueNegations.has(token)) {
          return false
        }
      }

      return true
    })
  }
}
