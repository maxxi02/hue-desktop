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

/**
 * Weight of bigram (adjacency) recall in the final blend. Kept small on
 * purpose: adjacency is a tie-breaker between two cards that already share
 * most of their vocabulary, not the primary signal.
 *
 * Previously bigrams were folded into a single weighted-overlap denominator
 * at `BIGRAM_WEIGHT = 2.5`, which for a typical 5-token trigger (4 bigrams x
 * 2.5 = 10 weight against 5 unigrams = 5 weight) made bigrams roughly
 * two-thirds of the score. A paraphrase sharing every content word but not
 * the interviewer's exact adjacency could not mathematically score above
 * ~0.33 — measured median correct-card score across the 90-case corpus was
 * 0.28, with only 7.8% clearing a 0.72 bar. See
 * `cuesheet-corpus.test.ts` and the calibration note on
 * `DEFAULT_MATCH_CONFIG` below for the swept replacement.
 */
const BIGRAM_BLEND = 0.19

/**
 * Blend of IDF-weighted unigram recall and IDF-weighted bigram recall against
 * `target`, each normalised by its own total weight so a target with no
 * bigrams (a two-token trigger) still scores purely on unigram recall instead
 * of being penalised for the missing term.
 *
 * Recall-oriented on purpose: the query is a live transcript that may carry a
 * whole clause of unrelated preamble, and penalising that would push every
 * real match below threshold.
 *
 * Unigram coverage dominates (weight `1 - BIGRAM_BLEND`) so that a paraphrase
 * sharing the target's vocabulary but not its word order scores close to its
 * true coverage rather than being capped by adjacency. Bigram recall (weight
 * `BIGRAM_BLEND`) still rewards an utterance that echoes the interviewer's
 * exact phrasing, breaking ties between two cards with similar vocabulary.
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

  const queryTerms = new Set(q)
  const queryBigrams = new Set(bigrams(q))

  const recall = (terms: Iterable<string>, present: Set<string>): number | null => {
    let matched = 0
    let total = 0
    for (const term of terms) {
      const w = idf(term, df, docCount)
      total += w
      if (present.has(term)) matched += w
    }
    return total === 0 ? null : matched / total
  }

  const unigramRecall = recall(new Set(t), queryTerms)
  const bigramRecall = recall(new Set(bigrams(t)), queryBigrams)

  // A target with no bigrams (fewer than two content tokens) scores purely on
  // unigram recall — there is no adjacency to blend in, so it must not be
  // treated as a zero.
  if (unigramRecall === null) return 0
  if (bigramRecall === null) return unigramRecall

  return (1 - BIGRAM_BLEND) * unigramRecall + BIGRAM_BLEND * bigramRecall
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
 * ## The fix and the sweep
 *
 * Under the old scoring (bigrams folded into one weighted-overlap
 * denominator at `BIGRAM_WEIGHT = 2.5`), the median correct-card score
 * across the 90 positive cases was 0.28 and only 7.8% cleared 0.72 — bigram
 * adjacency, not shared vocabulary, was doing almost the whole job of the
 * score. `scoreAgainst` now blends IDF-weighted unigram recall and bigram
 * recall (`BIGRAM_BLEND = 0.19`), so a paraphrase that shares the target's
 * words without its exact word order scores near its true coverage instead
 * of being capped near 1/3.
 *
 * With the new scorer, a grid search over `suppressThreshold` x
 * `renderThreshold` x `margin` (values 0–0.85 in fine steps, `BIGRAM_BLEND`
 * itself swept over {0, 0.1, 0.15, 0.18, 0.19, 0.2, 0.22, 0.25, 0.3, 0.5})
 * was scored on four metrics per combination: hit rate, false renders on
 * the 21 negative cases, false suppressions, and suppression coverage (the
 * fraction of the 90 positive cases that correctly suppress — the metric
 * that decides whether the feature's token-saving half actually fires).
 * `BIGRAM_BLEND = 0.19` maximised suppression coverage among candidates
 * that also hit >= 0.75; `suppressThreshold: 0.75`, `renderThreshold: 0.25`,
 * `margin: 0.02` was the unique optimum at that blend: it is the lowest
 * `suppressThreshold` that still produces zero false suppressions (0.74
 * already lets one wrong card through), and lowering `renderThreshold`
 * below 0.25 does not raise suppression coverage further while lowering it
 * risks the false-render bar on later corpus growth.
 *
 * MEASURED RESULT: hit rate 0.778 (70/90), 0 false suppressions, 0 false
 * renders, suppression coverage 0.133 (12/90) — up from 0.08 (7/90) before
 * this fix, with the false-suppress and false-render bars held at exactly
 * zero throughout the whole sweep, not just at the chosen point.
 */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  suppressThreshold: 0.75,
  renderThreshold: 0.25,
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
 * At the final, a fire is the only possible recovery when NO card matched —
 * suppressing that endpoint fire leaves the question blank, the worst outcome
 * this feature exists to prevent. But when a card DID match this final
 * (`decision.latch !== null`), the fire is not a recovery at all: it is the
 * ordinary endpoint-then-generate path about to start a competing model
 * generation alongside the user's own prepared card. That fire is dropped
 * too, with the same `resetScheduler` obligation — `onFinal`'s `fireCommand()`
 * has already set the scheduler's `draft`, and left alone that phantom draft
 * blocks the scheduler from firing on the next question ("one in flight,
 * ever").
 *
 * ## The latch is a per-question boundary
 *
 * A final always either latches a new card or clears whatever was standing —
 * never leaves it untouched. Interims never touch the latch: only a final
 * closes the question. Without this, a card that matched question 1 would
 * still be `state.cardId` when question 2's non-matching final arrives, and
 * question 2's `regenerate` would be silently dropped by the case below
 * (mistaking the stale latch for a live one), leaving question 2 unanswered
 * while question 1's card is still on screen.
 */
export function gateCommands(
  commands: Command[],
  state: LatchState,
  decision: GateDecision
): { commands: Command[]; resetScheduler: boolean } {
  let resetScheduler = false
  const out: Command[] = []

  if (decision.isFinal) state.cardId = decision.latch

  for (const command of commands) {
    switch (command.kind) {
      case 'fire':
        // A mid-question fire can be suppressed if a cue card matched.
        if (decision.suppress && !decision.isFinal) {
          resetScheduler = true
          continue
        }
        // At the final, a fire is normally the endpoint-then-generate
        // recovery and must pass through. But if a card matched THIS final,
        // the fire is a competing generation, not a recovery — drop it too.
        if (decision.isFinal && decision.latch !== null) {
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
