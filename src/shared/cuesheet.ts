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
