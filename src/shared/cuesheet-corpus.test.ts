import test from 'node:test'
import assert from 'node:assert/strict'
import { CueMatcher, DEFAULT_MATCH_CONFIG, verifyCard } from './cuesheet.ts'
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
 * The failure the negative-case test above does NOT cover.
 *
 * "No negative case renders" only walks the 21 questions that should match
 * nothing. It says nothing about the 90 POSITIVE cases, and a positive case
 * has a second way to fail: render, clear both gates, and put the WRONG
 * prepared answer on screen. That is strictly worse than not rendering — the
 * user is not shown "no cue", they are shown a confident answer to a question
 * nobody asked, mid-interview, in the surface that in glance mode HIDES the
 * generated one.
 *
 * MEASURED: 7 of 90 (0.078). The worst is "Tell me about saying no to a
 * stakeholder who wanted something unreasonable", which scores pm-prioritize
 * over pm-stakeholder at 0.7414 — the two cards genuinely share most of their
 * vocabulary. The bar is set at the measured value so it is a regression
 * guard: any change that renders an eighth wrong card fails here.
 */
test('wrong-card render rate stays at or below 0.078', () => {
  let wrong = 0
  let total = 0
  const offenders: string[] = []
  for (const { sheet, cases } of CORPUS) {
    const m = new CueMatcher(sheet)
    for (const c of cases) {
      if (c.expect === null) continue
      total++
      const r = m.match(c.transcript)
      if (m.renders(r) && r.cardId !== c.expect) {
        wrong++
        offenders.push(
          `"${c.transcript}" -> ${r.cardId} (wanted ${c.expect}) @ ${r.score.toFixed(3)}`
        )
      }
    }
  }
  assert.ok(
    wrong / total <= 0.078,
    `wrong-card render rate ${(wrong / total).toFixed(3)} above the 0.078 bar:\n${offenders.join('\n')}`
  )
})

/**
 * The three outcomes of a positive case, together, so the spec's table can be
 * read off one test rather than inferred from three separate bars. They must
 * account for every positive case exactly once.
 *
 * This used to lock the exact triple ({hit: 70, wrong: 7, none: 13}), which
 * fails a future change that only IMPROVES things — a none-render becoming a
 * hit, say — as loudly as one that regresses. The three assertions below are
 * a real guard (a wrong-card rate above today's bar, or a hit rate below it,
 * still fails), just not one that also fails on improvement.
 */
test('the three positive-case outcomes partition the corpus', () => {
  let hit = 0
  let wrong = 0
  let none = 0
  for (const { sheet, cases } of CORPUS) {
    const m = new CueMatcher(sheet)
    for (const c of cases) {
      if (c.expect === null) continue
      const r = m.match(c.transcript)
      if (!m.renders(r)) none++
      else if (r.cardId === c.expect) hit++
      else wrong++
    }
  }
  const total = hit + wrong + none
  assert.equal(total, 90, 'every positive case must land in exactly one bucket')
  assert.ok(hit / total >= 70 / 90, `hit rate ${hit}/${total} fell below the measured bar of 70/90`)
  assert.ok(
    wrong / total <= 7 / 90,
    `wrong-card rate ${wrong}/${total} rose above the measured bar of 7/90`
  )
})

/**
 * REGRESSION GUARD for the false-suppress bar's headroom.
 *
 * A suppression means Hue generates nothing at all, so a suppression onto the
 * wrong card leaves the user with a blank surface mid-interview — the worst
 * outcome in the system. The false-suppress count being zero is necessary but
 * not sufficient: it was zero at `suppressThreshold: 0.75` by a margin of
 * 0.0086 over the highest-scoring wrong-card render (0.7414) on a 111-case
 * corpus, which is luck rather than safety.
 *
 * This asserts the distance directly. If a future scoring change lifts wrong
 * cards toward the bar, this fails while the count is still zero — before a
 * user ever sees a blank card.
 */
test('the suppress threshold keeps real headroom over the worst wrong-card score', () => {
  let topWrong = 0
  for (const { sheet, cases } of CORPUS) {
    const m = new CueMatcher(sheet)
    for (const c of cases) {
      if (c.expect === null) continue
      const r = m.match(c.transcript)
      if (m.renders(r) && r.cardId !== c.expect && r.score > topWrong) topWrong = r.score
    }
  }
  const headroom = DEFAULT_MATCH_CONFIG.suppressThreshold - topWrong
  assert.ok(
    headroom >= 0.05,
    `suppressThreshold ${DEFAULT_MATCH_CONFIG.suppressThreshold} is only ${headroom.toFixed(4)} above the worst wrong-card score ${topWrong.toFixed(4)}`
  )
})

/**
 * The cue verification keep rate, measured against the corpus's own 56
 * hand-written faithful cues, each checked against its own card's script.
 *
 * This is the number that decides whether a real upload produces usable cards
 * at all: a card whose cues are all rejected is filtered out at ingest
 * (`cuesheet-ingest.ts`), and a sheet whose cards are all filtered out reports
 * "no usable cue cards were found".
 *
 * MEASURED: 0.500 (28/56) with 1 of 15 cards left with no cues — up from 0.143
 * (8/56) and 10 of 15 empty before the stem/connective/clause-span relaxation.
 * It is NOT the 0.80 the review asked for, and it cannot be: see the
 * reordering discussion in the design spec. The bar is the measured value.
 */
test('verifyCard keeps at least half the corpus cues, and leaves at most one card empty', () => {
  let total = 0
  let kept = 0
  let empty = 0
  for (const { sheet } of CORPUS) {
    for (const card of sheet.cards) {
      // The script is its own source here: `scriptIsExtractive` is tested
      // separately, and this measures the cue check, not the extract check.
      const v = verifyCard(card, card.script)
      total += card.cues.length
      kept += v.cues.length
      if (v.cues.length === 0) empty++
    }
  }
  assert.ok(
    kept / total >= 0.5,
    `verifyCard keep rate ${(kept / total).toFixed(3)} below the 0.500 bar`
  )
  assert.ok(empty <= 1, `${empty} cards left with no cues; at most 1 expected`)
})

/**
 * REGRESSION GUARD: suppression coverage — the fraction of the 90 positive
 * cases that correctly suppress generation entirely — is the metric that
 * decides whether the feature's token-saving half delivers any value at
 * all. It was 0.08 (7/90) before the scoring fix, 0.133 (12/90) after, and
 * measures 0.111 (10/90) now that `suppressThreshold` has been raised from
 * 0.75 to 0.80 to buy headroom over the worst wrong-card score (see the test
 * below and the note on `DEFAULT_MATCH_CONFIG`). Two suppressions is what
 * that safety margin cost, and it is worth it: a false suppression blanks
 * the card, while a missed suppression merely spends tokens.
 *
 * The floor is set a notch below the measured value so this is a real
 * regression guard, not a tautology that merely restates today's number.
 */
test('suppression coverage stays above 0.10', () => {
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
    suppressed / total >= 0.1,
    `suppression coverage ${(suppressed / total).toFixed(3)} below 0.10 floor`
  )
})
