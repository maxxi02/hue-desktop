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

import type { Command } from './speculation.ts'

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
  /**
   * Winner's lead over the runner-up.
   *
   * The runner-up starts at a sentinel 0 and is only ever raised by a card
   * that actually scored, so on a one-card sheet — or a sheet where only one
   * card scored above zero — the margin is the winner's FULL score, not zero.
   * The margin gate is therefore a no-op in that case rather than a blanket
   * block, which is the intended behaviour: with nothing to be confused with,
   * there is no ambiguity to guard against.
   */
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
 * ## Why `suppressThreshold` is 0.80 and not the sweep's 0.75
 *
 * The sweep picked 0.75 as the lowest value with zero false suppressions on
 * this corpus. That is true and it is also one point of luck: the highest
 * score reached by a case that renders the WRONG card while clearing the
 * margin gate is 0.7414 ("Tell me about saying no to a stakeholder who wanted
 * something unreasonable", which scores pm-prioritize over pm-stakeholder).
 * The bar cleared it by 0.0086 on a 111-case corpus — one more case of that
 * shape and the zero becomes a one, and a false suppression is the failure
 * that blanks the card mid-interview.
 *
 * 0.80 buys 0.0586 of headroom, near seven times as much, and costs 2 of the
 * 12 suppressions. That is a cheap trade because suppression coverage is only
 * ~13% to begin with: the token saving was never the load-bearing half of the
 * feature, and there is little to lose by insisting on real confidence before
 * refusing to generate at all. `cuesheet-corpus.test.ts` asserts the headroom
 * directly so a future scoring change cannot quietly eat it.
 *
 * MEASURED RESULT (at 0.80): hit rate 0.778 (70/90), wrong-card render rate
 * 0.078 (7/90), no-render rate 0.144 (13/90), 0 false suppressions, 0 false
 * renders on the 21 negatives, suppression coverage 0.111 (10/90).
 */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  suppressThreshold: 0.8,
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
): { commands: Command[]; resetScheduler: boolean; latchCleared: boolean } {
  let resetScheduler = false
  const out: Command[] = []
  const previousLatch = state.cardId

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
        //
        // Dropping it carries the same `resetScheduler` obligation as dropping
        // a fire, and for the same reason: `onFinal` set the scheduler's
        // `draft` before handing this command over, so left alone that phantom
        // draft makes `maybeFire`'s "one in flight, ever" check block
        // speculation for the whole of the NEXT question.
        if (state.cardId !== null) {
          resetScheduler = true
          continue
        }
        out.push(command)
        break

      case 'commit':
        // A commit adopts an in-flight draft as the turn's answer. At a latched
        // final there is no draft left to adopt: the caller aborts speculation
        // the moment a card latches, so by the time the commit is handled the
        // stream id is null and `commitSpeculation` takes its "generate for
        // real rather than adopt an empty answer" branch — putting a full
        // model generation on screen UNDERNEATH the user's own cue card, which
        // is precisely the outcome the fire and regenerate cases above exist to
        // prevent. Dropped with the same scheduler-reset obligation.
        if (decision.isFinal && decision.latch !== null) {
          resetScheduler = true
          continue
        }
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
        // abort always passes through, or scheduler state and the renderer's
        // view of it drift apart.
        out.push(command)
    }
  }

  return {
    commands: out,
    resetScheduler,
    // A `reset` mid-question clears the latch without the caller ever seeing a
    // final, so the caller has no other way to learn the card came down. See
    // the `latchCleared` note above `LatchState`.
    latchCleared: previousLatch !== null && state.cardId === null
  }
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
 * Negation tokens that must appear in a cue, AS OFTEN AS THEY APPEAR, in the
 * covered span of the script. Contractions retain apostrophes (cueTokens does
 * not split on them), so the set includes forms like "didn't".
 *
 * Negations are always tested on RAW tokens, never on stems: `stem('nothing')`
 * is `'noth'`, which is not in this set, so stemming a negation would silently
 * make it invisible to the parity check.
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
 * A deliberately small suffix stripper — NOT a linguistic stemmer.
 *
 * Cue compression inflects: a script that says "split reads onto replicas"
 * compresses to "Read replicas", and "root-causing" compresses to
 * "root-cause". Comparing raw surface forms rejected 86% of the corpus's own
 * hand-written faithful cues (8 of 56 kept), which filtered 10 of 15 cards
 * down to zero cues and would have made a real upload report "no usable cue
 * cards were found".
 *
 * No stemming dependency is pulled in for this. A dependency would bring a
 * much more aggressive conflation table than this check wants — the point is
 * to unify read/reads and cause/causing, not to decide that "university" and
 * "universe" are the same word. Everything here is reversible by eye:
 *
 * - `ies` -> `y`   (priorities/priority)
 * - trailing `ing`, `ed`, or a plural `s` (never `ss`)
 * - a doubled final consonant left behind (shipped -> shipp -> ship)
 * - a trailing `e`, applied to BOTH sides so cause/causing agree (caus)
 *
 * Applied uniformly to script and cue, so the only thing that matters is that
 * it is a consistent function, not that its output is a real word.
 */
export function stem(token: string): string {
  let t = token.replace(/'s$/, '').replace(/'$/, '')
  if (t.length >= 5 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`
  else if (t.length >= 5 && t.endsWith('ing')) t = t.slice(0, -3)
  else if (t.length >= 5 && t.endsWith('ed')) t = t.slice(0, -2)
  else if (t.length >= 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1)
  if (t.length >= 4 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1)
  if (t.length >= 4 && t.endsWith('e')) t = t.slice(0, -1)
  return t
}

/** A token carrying digits can never be treated as an unsourced connective. */
function hasDigit(token: string): boolean {
  return /\p{N}/u.test(token)
}

/**
 * One cue token in this many may be absent from the script.
 *
 * Real compression inserts connectives the script never used — "plus",
 * "instead", "first", "second". Demanding that every cue token appear in the
 * script rejects those outright. The budget is deliberately tight — a 4-token
 * cue gets one, an 8-token cue gets two — and an unmatched token can never be
 * a number, and can only be a negation when the script is already making a
 * contrast (see `verifyCard`), so the allowance can add glue but never a claim.
 */
const UNMATCHED_TOKENS_PER = 4

/**
 * Words that mark the script as already drawing a contrast.
 *
 * A cue that writes "Scale the bottleneck, not everything" over a script that
 * says "scale the bottleneck instead of everything" is faithful — the "not" is
 * echoing a contrast the user already made, in the vocabulary a bold line
 * needs. A cue that writes "Never cut corners" over a script that says "I cut
 * corners" is inventing one. There is no lexical difference between the two
 * cue tokens, so the test is on the SCRIPT: an unsourced negation is allowed
 * through only where the covered span already contains a contrast of its own.
 */
const CONTRAST_MARKERS = new Set([
  'rather', 'instead', 'than', 'versus', 'vs', 'but', 'except', 'unless',
  ...NEGATIONS
])

/**
 * Where a sentence may start, and where a clause ends.
 *
 * Two different boundaries, for two different jobs, and `cueTokens` throws
 * away the punctuation that carries both — so they are recorded here, before
 * tokenising, rather than recovered afterwards.
 *
 * SENTENCE bounds where a cue may ANCHOR. Matching greedily from token zero
 * picks the first occurrence of the cue's first word, which for a repeated
 * word ("I escalate when… Before I escalate I write up…") drags the whole
 * intervening text, and every negation in it, into the cue's span. Trying each
 * sentence start as an anchor lets a cue drawn from the third sentence be
 * judged against the third sentence.
 *
 * CLAUSE bounds how far RIGHT the negation span reaches past the last matched
 * token — see the span discussion in `verifyCard`. Semicolons, colons and
 * dashes bound both, since a script that uses them is changing subject as
 * firmly as a full stop does.
 */
const SENTENCE_BREAK = /(?<=[.!?;:])\s+|\s*[—–]\s*/
const CLAUSE_BREAK =
  /(?<=[.!?;:,])\s+|\s*[—–]\s*|\s+(?=because\b|but\b|although\b|though\b|whereas\b|while\b|rather\b|instead\b|so\b|and\b|or\b)/

interface ScriptIndex {
  tokens: string[]
  /** For each token, the index its sentence starts at. */
  sentenceStart: number[]
  /** For each token, the exclusive index its clause ends at. */
  clauseEnd: number[]
}

function indexScript(script: string): ScriptIndex {
  const tokens: string[] = []
  const sentenceStart: number[] = []
  for (const sentence of script.split(SENTENCE_BREAK)) {
    const t = cueTokens(sentence)
    if (t.length === 0) continue
    const start = tokens.length
    tokens.push(...t)
    for (let i = start; i < tokens.length; i++) sentenceStart.push(start)
  }

  const clauseEnd: number[] = []
  let seen = 0
  for (const clause of script.split(CLAUSE_BREAK)) {
    const t = cueTokens(clause)
    if (t.length === 0) continue
    seen += t.length
    for (let i = 0; i < t.length; i++) clauseEnd.push(seen)
  }

  // The two splits tokenise the same string, so they must agree on length. If
  // some input makes them disagree, fall back to "the clause runs to the end
  // of the script", which is the conservative direction: a wider negation span
  // rejects more, never fewer.
  if (clauseEnd.length !== tokens.length) {
    return { tokens, sentenceStart, clauseEnd: tokens.map(() => tokens.length) }
  }
  return { tokens, sentenceStart, clauseEnd }
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
 * 2. Its tokens appear in the script IN ORDER, compared by `stem` rather than
 *    by surface form, starting from SOME sentence boundary — a cue drawn from
 *    the third sentence is judged against the third sentence, not against the
 *    whole script (see `SENTENCE_BREAK`). A cue token that is absent from that
 *    region entirely may be allowed through as a connective, within the
 *    `UNMATCHED_TOKENS_PER` budget, provided it carries no digits and is
 *    either not a negation or is echoing a contrast the region already makes
 *    (see `CONTRAST_MARKERS`). A cue token that IS in the region but earlier
 *    than the match position is a reordering, and rejects the cue outright —
 *    the budget is for words the script never used, never for words the cue
 *    moved.
 * 3. Negation parity, by COUNT rather than by presence, over the span from the
 *    anchor to the end of the CLAUSE the last matched token falls in.
 *
 * ## What this check does NOT verify
 *
 * It verifies the provenance of WORDS, not the provenance of CLAIMS. Two
 * classes of misleading cue are outside what containment can see, and are
 * documented in the design spec rather than implied to be covered:
 *
 * - RE-ATTRIBUTION. Script "My manager decided the architecture and I
 *   implemented it", cue "Decided the architecture". `my` and `i` are
 *   stopwords, so who did what is not in the compared token stream at all.
 * - RE-PAIRING. Script "I cut costs by 5 percent while the target was 40
 *   percent", cue "Cut costs by 40 percent". Both numbers are the user's own
 *   words, in order; the fabrication is in the pairing, not in the vocabulary.
 *
 * Closing either one needs a claim-level model, which is a different check
 * from this one and would itself be a thing that can be wrong.
 *
 * ACCEPTED TRADEOFF: A cue that reorders content for readability (e.g. "Cut
 * payload, reduced latency" from "reduced latency by cutting the payload") is
 * still rejected. Dropping a good cue degrades a card; keeping a misleading
 * one puts a false claim in the user's mouth. The asymmetry is deliberate, and
 * it is the single biggest cost this check pays — see the measured keep rate
 * and the reordering discussion in the design spec.
 */
export function verifyCard(card: CueCard, source: string): CueCard {
  const script = scriptIsExtractive(card.script, source) ? card.script : ''
  const { tokens: st, sentenceStart, clauseEnd } = indexScript(script)
  const stems = st.map(stem)

  /** Try to verify `ct` against the script starting at token `anchor`. */
  const verifyFrom = (ct: string[], anchor: number): boolean => {
    const present = new Set(stems.slice(anchor))
    let budget = Math.ceil(ct.length / UNMATCHED_TOKENS_PER)
    let stIdx = anchor
    let lastIdx = -1
    /** Unsourced negations, held back until the contrast test below. */
    const echoed: string[] = []

    for (const cueToken of ct) {
      const s = stem(cueToken)

      let found = -1
      for (let i = stIdx; i < stems.length; i++) {
        if (stems[i] === s) {
          found = i
          break
        }
      }

      if (found === -1) {
        // In the region, but behind us: the cue moved a word. Reordering is
        // rejected outright and never charged to the connective budget.
        if (present.has(s)) return false
        // A word the script never used. Glue is allowed; a number never is.
        if (budget === 0 || hasDigit(cueToken)) return false
        if (NEGATIONS.has(cueToken)) echoed.push(cueToken)
        budget--
        continue
      }

      lastIdx = found
      stIdx = found + 1
    }

    // Every token was a connective: nothing anchors this cue to the script.
    if (lastIdx === -1) return false

    // Negation parity by count, over the span from the anchor to the END OF
    // THE CLAUSE the last matched token sits in. Stopping at the last matched
    // token would let a cue keep a leading negation while dropping the
    // qualifier that follows it in the same breath: "I never cut costs without
    // approval from finance" would license "Never cut costs", which is the
    // opposite claim. Running to the end of the SENTENCE instead over-reaches
    // the other way — it drags in negations from a later, unrelated clause and
    // measured 12 points of keep rate to do it. Counting rather than
    // set-testing is what separates "I never miss deadlines and I never cut
    // corners" from a cue carrying a single "never".
    const covered = st.slice(anchor, Math.max(clauseEnd[lastIdx], lastIdx + 1))

    // An unsourced negation is only ever an echo of a contrast the script is
    // already drawing. Where the script draws none, the cue is inventing one.
    if (echoed.length > 0 && !covered.some((t) => CONTRAST_MARKERS.has(t))) return false

    const cueCounts = new Map<string, number>()
    const unclaimed = [...echoed]
    for (const t of ct) {
      if (!NEGATIONS.has(t)) continue
      // An echoed negation was never in the script, so it cannot be credited
      // against a script negation the cue dropped.
      const i = unclaimed.indexOf(t)
      if (i !== -1) {
        unclaimed.splice(i, 1)
        continue
      }
      cueCounts.set(t, (cueCounts.get(t) ?? 0) + 1)
    }
    const spanCounts = new Map<string, number>()
    for (const t of covered) {
      if (NEGATIONS.has(t)) spanCounts.set(t, (spanCounts.get(t) ?? 0) + 1)
    }
    for (const [token, count] of spanCounts) {
      if ((cueCounts.get(token) ?? 0) < count) return false
    }

    return true
  }

  const anchors = [...new Set(sentenceStart)]

  return {
    ...card,
    script,
    cues: card.cues.filter((cue) => {
      const ct = cueTokens(cue)
      // 1. Reject empty token arrays (all-stopword cues).
      if (ct.length === 0) return false
      return anchors.some((a) => verifyFrom(ct, a))
    })
  }
}
