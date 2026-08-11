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
 * Calibrated against the fixture corpus in `cuesheet-corpus.test.ts`. Do not
 * hand-tune these against intuition; move the corpus numbers instead.
 */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  suppressThreshold: 0.72,
  renderThreshold: 0.55,
  margin: 0.1,
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
  /** True when generation was skipped for the question now in progress. */
  suppressedQuestion: boolean
}

export function newLatchState(): LatchState {
  return { cardId: null, suppressedQuestion: false }
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
 * `scheduler.reset()` afterwards — see the note on suppression above.
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
        if (decision.suppress) {
          state.suppressedQuestion = true
          resetScheduler = true
          continue
        }
        out.push(command)
        break

      case 'regenerate':
        // A latched card is the answer. Regenerating over it would replace the
        // user's own prepared words with the model's, which is the whole thing
        // this feature exists to avoid.
        if (state.cardId !== null && decision.latch !== null) continue
        out.push(command)
        break

      case 'reset':
        // A new question. The latch does not survive it — that is what makes
        // the card stable for the entire duration of the user's answer and no
        // longer.
        state.cardId = null
        state.suppressedQuestion = false
        out.push(command)
        break

      default:
        // abort and commit always pass through, or scheduler state and the
        // renderer's view of it drift apart.
        out.push(command)
    }
  }

  if (decision.isFinal && decision.latch === null) state.suppressedQuestion = false

  return { commands: out, resetScheduler }
}
