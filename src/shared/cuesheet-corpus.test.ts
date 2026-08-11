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
 * KNOWN FINDING (Task 12 calibration): this assertion currently fails at
 * hit rate 0.722 (65/90), and no choice of `renderThreshold`/`margin` closes
 * the gap without also letting a negative case render. A grid search over
 * the corpus's precomputed match scores shows every threshold pair that
 * keeps false renders at zero caps hit rate at 0.722; reaching 0.75 requires
 * accepting a render on "How many tickets do you typically close in a day?"
 * (0.098 against the ticket-prioritization card, an honest collision on the
 * shared word "tickets", not a corpus artifact). Because the false-render
 * property is the safer failure mode to keep at zero and the hit-rate bar is
 * documented as soft, `DEFAULT_MATCH_CONFIG` ships the zero-false-render
 * config and this test is left red on purpose rather than the corpus being
 * reverse-engineered to pass it. See the comment above `DEFAULT_MATCH_CONFIG`
 * in `cuesheet.ts` for the full calibration trail.
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
