import test from 'node:test'
import assert from 'node:assert/strict'
import { CueMatcher } from './cuesheet.ts'
import { CORPUS } from './cuesheet-corpus.ts'

test('false-suppress rate is zero', () => {
  const offenders: string[] = []
  for (const { sheet, cases } of CORPUS) {
    const m = new CueMatcher(sheet)
    for (const c of cases) {
      const r = m.match(c.transcript)
      if (m.suppresses(r) && r.cardId !== c.expect) {
        offenders.push(`"${c.transcript}" suppressed onto ${r.cardId}, wanted ${c.expect}`)
      }
    }
  }
  assert.deepEqual(offenders, [], 'a wrong suppression is the only failure that blanks the card')
})

/**
 * FIXED (see `DEFAULT_MATCH_CONFIG` in `cuesheet.ts` for the full sweep):
 * `scoreAgainst` used to fold bigrams into a single weighted-overlap
 * denominator (`BIGRAM_WEIGHT = 2.5`), which made adjacency roughly
 * two-thirds of the score and capped a vocabulary-only paraphrase near 1/3.
 * Median correct-card score was 0.28 and hit rate topped out at 0.722
 * (65/90) under any zero-false-render threshold pair. Blending IDF-weighted
 * unigram recall with a small bigram bonus (`BIGRAM_BLEND = 0.19`) raised
 * hit rate to 0.778 (70/90) at `suppressThreshold: 0.75`,
 * `renderThreshold: 0.25`, `margin: 0.02` — with zero false renders and zero
 * false suppressions across the whole corpus, same as before.
 */
test('hit rate is at least 0.75', () => {
  let hits = 0
  let total = 0
  for (const { sheet, cases } of CORPUS) {
    const m = new CueMatcher(sheet)
    for (const c of cases) {
      if (c.expect === null) continue
      total++
      const r = m.match(c.transcript)
      if (m.renders(r) && r.cardId === c.expect) hits++
    }
  }
  assert.ok(hits / total >= 0.75, `hit rate ${(hits / total).toFixed(2)} below 0.75`)
})

test('no negative case renders', () => {
  for (const { sheet, cases } of CORPUS) {
    const m = new CueMatcher(sheet)
    for (const c of cases.filter((x) => x.expect === null)) {
      const r = m.match(c.transcript)
      assert.equal(m.renders(r), false, `"${c.transcript}" should not have rendered`)
    }
  }
})

/**
 * REGRESSION GUARD: suppression coverage — the fraction of the 90 positive
 * cases that correctly suppress generation entirely — is the metric that
 * decides whether the feature's token-saving half delivers any value at
 * all. It was 0.08 (7/90) before the scoring fix and measures 0.133 (12/90)
 * after. The floor here is set a notch below the measured value so this is
 * a real regression guard, not a tautology that merely restates today's
 * number.
 */
test('suppression coverage stays above 0.11', () => {
  let suppressed = 0
  let total = 0
  for (const { sheet, cases } of CORPUS) {
    const m = new CueMatcher(sheet)
    for (const c of cases) {
      if (c.expect === null) continue
      total++
      const r = m.match(c.transcript)
      if (m.suppresses(r) && r.cardId === c.expect) suppressed++
    }
  }
  assert.ok(
    suppressed / total >= 0.11,
    `suppression coverage ${(suppressed / total).toFixed(3)} below 0.11 floor`
  )
})
