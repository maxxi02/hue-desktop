import test from 'node:test'
import assert from 'node:assert/strict'
import type { Command } from './speculation.ts'
import { cueTokens, buildDf, scoreAgainst, CueMatcher, DEFAULT_MATCH_CONFIG, gateCommands, newLatchState, verifyCard, scriptIsExtractive } from './cuesheet.ts'
import type { CueSheet } from './cuesheet.ts'
import { SpeculationScheduler } from './speculation.ts'

test('cueTokens strips stopwords and keeps content words', () => {
  assert.deepEqual(cueTokens('Tell me about a time when you failed'), ['failed'])
})

test('cueTokens keeps non-ASCII letters rather than splitting on them', () => {
  assert.deepEqual(cueTokens('résumé naïve'), ['résumé', 'naïve'])
})

test('bigrams beat scattered unigrams', () => {
  const targets = ['what is your biggest weakness', 'what is the biggest project you shipped']
  const { df, docCount } = buildDf(targets)
  const adjacent = scoreAgainst('so what is your biggest weakness', targets[0], df, docCount)
  const scattered = scoreAgainst('biggest team you led and a weakness of that plan', targets[0], df, docCount)
  assert.ok(adjacent > scattered, `expected ${adjacent} > ${scattered}`)
})

test('a term present in every target carries no signal', () => {
  const targets = ['interview question one', 'interview question two']
  const { df, docCount } = buildDf(targets)
  assert.equal(scoreAgainst('interview', targets[0], df, docCount), 0)
})

const sheet: CueSheet = {
  id: 's1',
  label: 'Apollo support',
  sourceHash: 'h',
  createdAt: '2026-08-11T00:00:00.000Z',
  cards: [
    {
      id: 'c-support',
      heading: 'Why support instead of development?',
      cues: ['Not switching away', 'Same core skills'],
      script: 'I see it less as switching away from development and more as bringing my development background into a different kind of contribution.',
      triggers: [
        'why support instead of development',
        'you are a developer why this support role',
        'do you not want to code anymore'
      ]
    },
    {
      id: 'c-weakness',
      heading: 'Biggest weakness',
      cues: ['Over-scoped early', 'Now timebox spikes'],
      script: 'Early on I over-scoped work before validating it, so now I timebox a spike first.',
      triggers: ['what is your biggest weakness', 'where do you need to improve']
    }
  ]
}

test('matches a paraphrase to the right card', () => {
  const r = new CueMatcher(sheet).match('so why do you want support rather than development')
  assert.equal(r.cardId, 'c-support')
})

test('an unrelated question does not clear the render gate', () => {
  const m = new CueMatcher(sheet)
  const r = m.match('what is your notice period and expected salary')
  assert.equal(m.renders(r), false)
})

test('two close cards are rejected by the margin gate', () => {
  const ambiguous: CueSheet = {
    ...sheet,
    cards: [
      { ...sheet.cards[0], id: 'a', triggers: ['tell me about the deployment process'] },
      { ...sheet.cards[1], id: 'b', triggers: ['tell me about the deployment pipeline'] }
    ]
  }
  const m = new CueMatcher(ambiguous)
  const r = m.match('tell me about the deployment')
  assert.equal(m.renders(r), false, 'ambiguous match must fall through to speculation')
})

test('reciting the script is detected and never latches', () => {
  const m = new CueMatcher(sheet)
  const r = m.match(sheet.cards[0].script)
  assert.equal(r.recited, true)
  assert.equal(m.renders(r), false)
  assert.equal(m.suppresses(r), false)
})

test('suppress threshold is stricter than render threshold', () => {
  assert.ok(DEFAULT_MATCH_CONFIG.suppressThreshold > DEFAULT_MATCH_CONFIG.renderThreshold)
})

test('suppression drops fire and asks for a scheduler reset', () => {
  const state = newLatchState()
  const fire: Command[] = [{ kind: 'fire', specId: 1, text: 'why support' }]
  const out = gateCommands(fire, state, { suppress: true, latch: null, isFinal: false })
  assert.deepEqual(out.commands, [])
  assert.equal(out.resetScheduler, true, 'dropping fire without a reset desyncs the scheduler')
})

test('abort, commit and reset always pass through', () => {
  const state = newLatchState()
  const cmds: Command[] = [
    { kind: 'abort', specId: 1 },
    { kind: 'commit', specId: 1 },
    { kind: 'reset' }
  ]
  const out = gateCommands(cmds, state, { suppress: true, latch: null, isFinal: false })
  assert.deepEqual(out.commands, cmds)
})

test('a latched final drops the commit that would generate underneath the card', () => {
  const state = newLatchState()
  const out = gateCommands([{ kind: 'commit', specId: 7 }], state, {
    suppress: false, latch: 'c-support', isFinal: true
  })
  assert.deepEqual(
    out.commands,
    [],
    'the caller aborts speculation when a card latches, so this commit finds no draft and generates a full answer under the card'
  )
  assert.equal(out.resetScheduler, true, 'a dropped commit leaves the same phantom draft a dropped fire does')
})

test('a commit at an unlatched final still passes through', () => {
  const state = newLatchState()
  const cmds: Command[] = [{ kind: 'commit', specId: 8 }]
  const out = gateCommands(cmds, state, { suppress: false, latch: null, isFinal: true })
  assert.deepEqual(out.commands, cmds, 'no card matched; the draft is the answer and must be adopted')
  assert.equal(out.resetScheduler, false)
})

test('an interim reset that clears a standing latch reports latchCleared', () => {
  const state = newLatchState()

  // Q1's final latches a card.
  const latched = gateCommands([], state, { suppress: false, latch: 'c-support', isFinal: true })
  assert.equal(latched.latchCleared, false)
  assert.equal(state.cardId, 'c-support')

  // Mid-Q2 the interviewer withdraws the question: the scheduler emits
  // abort + reset. The gate clears the latch, and the caller — which never
  // sees a final here — has to be told, or the card stays on screen and (in
  // glance mode) hides Q2's real answer for good.
  const out = gateCommands([{ kind: 'abort', specId: 9 }, { kind: 'reset' }], state, {
    suppress: false, latch: null, isFinal: false
  })
  assert.equal(state.cardId, null)
  assert.equal(out.latchCleared, true, 'the interim path has no other way to learn the card came down')
})

test('latchCleared is false when no latch was standing', () => {
  const state = newLatchState()
  const out = gateCommands([{ kind: 'reset' }], state, { suppress: false, latch: null, isFinal: false })
  assert.equal(out.latchCleared, false, 'an ordinary reset must not spam the callback')
})

test('latchCleared is false when a final replaces one latch with another', () => {
  const state = newLatchState()
  gateCommands([], state, { suppress: false, latch: 'c-support', isFinal: true })
  const out = gateCommands([], state, { suppress: false, latch: 'c-weakness', isFinal: true })
  assert.equal(out.latchCleared, false, 'a card is still standing; the final path renders the new one')
})

test('a dropped regenerate asks for a scheduler reset', () => {
  const state = newLatchState()
  const out = gateCommands([{ kind: 'regenerate', specId: 6, text: 'q' }], state, {
    suppress: false, latch: 'c-support', isFinal: true
  })
  assert.deepEqual(out.commands, [])
  assert.equal(
    out.resetScheduler,
    true,
    "speculation.ts sets its draft before returning regenerate; without a reset that phantom draft blocks maybeFire for the whole next question"
  )
})

test('suppression at the final never drops the endpoint fire', () => {
  const scheduler = new SpeculationScheduler()
  const state = newLatchState()
  let now = 1000

  // Drive scheduler to fire: feed 8+ words stable for 400ms
  const interim = 'why do you want to leave your current role'
  let lastCommand: Command[] = []

  scheduler.onInterim(interim, 'interviewer', now)
  now += 500
  lastCommand = scheduler.onTick(now)

  // Confirm we got a fire
  assert.ok(lastCommand.some((c) => c.kind === 'fire'), 'scheduler should emit fire after stable interim')

  // Suppress the speculative fire mid-question
  const suppressed = gateCommands(lastCommand, state, { suppress: true, latch: null, isFinal: false })
  assert.equal(suppressed.resetScheduler, true)
  scheduler.reset()

  // At the final, the scheduler emits an endpoint fire (not regenerate)
  const finalText = 'why do you want to leave your current role and start at our company'
  const finalCommands = scheduler.onFinal(finalText, 'interviewer', now)

  // Gatekeeper must NOT suppress the endpoint fire even with suppress=true
  const gated = gateCommands(finalCommands, state, { suppress: true, latch: null, isFinal: true })
  assert.ok(gated.commands.length > 0, 'endpoint fire must reach the pipeline to prevent blank screen')
  assert.ok(gated.commands.some((c) => c.kind === 'fire'), 'endpoint fire must pass through')
  assert.equal(gated.resetScheduler, false, 'endpoint fire does not trigger scheduler reset')
})

test('a latch drops the regenerate that would overwrite it', () => {
  const state = newLatchState()
  const out = gateCommands([{ kind: 'regenerate', specId: 2, text: 'q' }], state, {
    suppress: false, latch: 'c-support', isFinal: true
  })
  assert.deepEqual(out.commands, [])
  assert.equal(state.cardId, 'c-support')
})

test('a new question clears the previous latch', () => {
  const state = newLatchState()
  gateCommands([], state, { suppress: false, latch: 'c-support', isFinal: true })
  gateCommands([{ kind: 'reset' }], state, { suppress: false, latch: null, isFinal: false })
  assert.equal(state.cardId, null)
})

test('a standing latch from a prior call still blocks a later regenerate', () => {
  const state = newLatchState()

  // Set a latch in the first call
  gateCommands([], state, { suppress: false, latch: 'c-support', isFinal: true })
  assert.equal(state.cardId, 'c-support')

  // Later, a stray regenerate arrives in a new gateCommands call with latch: null
  // The standing latch must still protect it
  const out = gateCommands([{ kind: 'regenerate', specId: 2, text: 'different question' }], state, {
    suppress: false, latch: null, isFinal: false
  })
  assert.deepEqual(out.commands, [], 'standing latch must still block the regenerate')
})

test('a latched final drops the endpoint fire and asks for a scheduler reset', () => {
  const state = newLatchState()
  const fire: Command[] = [{ kind: 'fire', specId: 3, text: 'why do you want this role' }]
  const out = gateCommands(fire, state, { suppress: false, latch: 'c-support', isFinal: true })
  assert.deepEqual(out.commands, [], 'a card matched this final; the endpoint fire must not start a competing generation')
  assert.equal(out.resetScheduler, true, 'dropping the fire without a reset leaves a phantom draft blocking the next question')
})

test('a final with no latch still lets the endpoint fire through (recovery must not regress)', () => {
  const state = newLatchState()
  const fire: Command[] = [{ kind: 'fire', specId: 4, text: 'why do you want this role' }]
  const out = gateCommands(fire, state, { suppress: false, latch: null, isFinal: true })
  assert.ok(out.commands.some((c) => c.kind === 'fire'), 'no card matched; the endpoint fire is the only recovery and must pass through')
  assert.equal(out.resetScheduler, false)
})

test('a second question that matches nothing clears the first question\'s latch, so its regenerate is not dropped', () => {
  const state = newLatchState()

  // Q1's final latches card1.
  gateCommands([], state, { suppress: false, latch: 'c-support', isFinal: true })
  assert.equal(state.cardId, 'c-support')

  // Q2's final matches nothing. Before Q2's regenerate is evaluated, the
  // stale latch from Q1 must already be cleared.
  const out = gateCommands(
    [{ kind: 'regenerate', specId: 5, text: 'a different question' }],
    state,
    { suppress: false, latch: null, isFinal: true }
  )
  assert.equal(state.cardId, null, 'a non-matching final must clear the stale latch from the previous question')
  assert.ok(out.commands.some((c) => c.kind === 'regenerate'), 'Q2 must get its regenerate, not be silently dropped by a stale latch')
})

test('an interim with no latch does not clear a standing latch mid-answer', () => {
  const state = newLatchState()

  // A final latches a card.
  gateCommands([], state, { suppress: false, latch: 'c-support', isFinal: true })
  assert.equal(state.cardId, 'c-support')

  // While the user is answering, interims keep arriving with latch: null
  // (the interim path never latches — see `decide()` in pipeline.ts). The
  // card must stay on screen for the whole answer, not flicker off.
  gateCommands([], state, { suppress: false, latch: null, isFinal: false })
  assert.equal(state.cardId, 'c-support', 'an interim must never clear a standing latch')
})

const source = 'I see it less as switching away from development and more as bringing my background into a different contribution. I shipped a lead scoring engine.'

test('an extractive script is accepted', () => {
  assert.equal(scriptIsExtractive('I shipped a lead scoring engine.', source), true)
})

test('a script the user never wrote is rejected', () => {
  assert.equal(scriptIsExtractive('I led a team of forty engineers.', source), false)
})

test('whitespace and case differences do not reject a real extract', () => {
  assert.equal(scriptIsExtractive('i shipped   a lead\nscoring engine', source), true)
})

test('a cue introducing an unsourced number is dropped', () => {
  const card = {
    id: 'c', heading: 'h',
    script: 'I shipped a lead scoring engine.',
    cues: ['Shipped lead scoring engine', 'Cut latency by 40%'],
    triggers: ['t']
  }
  assert.deepEqual(verifyCard(card, source).cues, ['Shipped lead scoring engine'])
})

test('inversion: negation in script omitted by cue is rejected', () => {
  const card = {
    id: 'c1', heading: 'h',
    script: 'I did not cut costs.',
    cues: ['Cut costs'],
    triggers: ['t']
  }
  assert.deepEqual(verifyCard(card, 'I did not cut costs.').cues, [], 'cue omitting negation must be dropped')
})

test('scrambling: tokens in different order are rejected', () => {
  const card = {
    id: 'c2', heading: 'h',
    script: 'I cut costs and grew the team.',
    cues: ['Grew costs, cut team'],
    triggers: ['t']
  }
  assert.deepEqual(verifyCard(card, 'I cut costs and grew the team.').cues, [], 'reordered tokens must be dropped')
})

test('empty cue: all-stopword cues are rejected', () => {
  const card = {
    id: 'c3', heading: 'h',
    script: 'I shipped a lead scoring engine.',
    cues: ['This is it', 'Shipped lead scoring engine'],
    triggers: ['t']
  }
  const result = verifyCard(card, 'I shipped a lead scoring engine.')
  assert.deepEqual(result.cues, ['Shipped lead scoring engine'], 'all-stopword cue must be dropped')
})

test('faithful: order-preserving compression is accepted', () => {
  const card = {
    id: 'c4', heading: 'h',
    script: 'I shipped a lead scoring engine and cut latency.',
    cues: ['Shipped lead scoring engine'],
    triggers: ['t']
  }
  const result = verifyCard(card, 'I shipped a lead scoring engine and cut latency.')
  assert.deepEqual(result.cues, ['Shipped lead scoring engine'], 'order-preserving cue must be kept')
})

test('negation parity: cue carrying all negations in span is accepted', () => {
  const card = {
    id: 'c5', heading: 'h',
    script: 'I did not cut costs.',
    cues: ['Did not cut costs'],
    triggers: ['t']
  }
  const result = verifyCard(card, 'I did not cut costs.')
  assert.equal(result.cues.length, 1, 'cue with negation parity must be kept (did is stopword, cue has [not, cut, costs])')
})

/** Verify one cue against a script that is its own source. */
function keeps(script: string, cue: string): boolean {
  const card = { id: 'c', heading: 'h', script, cues: [cue], triggers: ['t'] }
  return verifyCard(card, script).cues.length === 1
}

// ---------------------------------------------------------------------------
// The relaxations. Each of these was a faithful cue the old exact-surface-form
// subsequence check threw away; between them they were most of why the check
// kept only 8 of the corpus's own 56 hand-written cues.
// ---------------------------------------------------------------------------

test('inflection: a cue may use a different form of a script word', () => {
  assert.equal(
    keeps('I split reads onto replicas and moved the write path onto a queue.', 'Read replicas'),
    true,
    'read/reads must unify, or ordinary compression is rejected'
  )
  assert.equal(
    keeps('I stop the bleeding before root-causing anything.', 'Stop the bleeding before root-cause'),
    true,
    'root-cause/root-causing must unify'
  )
})

test('connectives: a bounded number of unsourced glue words is allowed', () => {
  assert.equal(
    keeps('I split reads onto replicas and moved the write path onto a queue.', 'Read replicas plus a write queue'),
    true,
    '"plus" appears nowhere in the script and is exactly the kind of word compression inserts'
  )
})

test('the connective budget is bounded, not a free pass', () => {
  assert.equal(
    keeps('I shipped a lead scoring engine.', 'Shipped a rewritten scoring platform'),
    false,
    'two unsourced content words in a four-token cue exceeds the one-in-four budget'
  )
})

test('an unsourced number is never treated as a connective', () => {
  assert.equal(
    keeps('I cut costs and the team grew.', 'Cut costs by 40 percent'),
    false,
    'a number the script never used is a fabricated claim however much budget is left'
  )
})

test('a cue may echo a contrast the script already draws', () => {
  assert.equal(
    keeps('We could absorb bursts instead of rejecting writes.', 'Absorb bursts, not rejecting'),
    true,
    '"not" here restates the script\'s own "instead of"'
  )
})

test('a cue may not invent a contrast the script does not draw', () => {
  assert.equal(
    keeps('I cut corners on that project.', 'Never cut corners'),
    false,
    'the script draws no contrast, so the negation is the cue\'s own invention and inverts the claim'
  )
})

// ---------------------------------------------------------------------------
// The defeat cases. These PASSED the old check and must stay rejected.
// ---------------------------------------------------------------------------

test('defeat: one "never" in a cue cannot satisfy two in the script', () => {
  assert.equal(
    keeps('I never miss deadlines and I never cut corners.', 'Never miss deadlines, cut corners'),
    false,
    'set-testing negations let a single never cover both; parity must be counted'
  )
})

test('defeat: a cue may not drop the qualifier that follows what it took', () => {
  assert.equal(
    keeps('I never cut costs without approval from finance.', 'Never cut costs'),
    false,
    'the span must reach the end of the clause, not stop at the last matched token'
  )
})

test('reordering is still rejected after the relaxations', () => {
  assert.equal(keeps('I cut costs and grew the team.', 'Grew costs, cut team'), false)
  assert.equal(
    keeps('I reduced latency by cutting the payload.', 'Cut payload, reduced latency'),
    false,
    'swapping two clauses is the reordering the check exists to catch'
  )
})

test('dropping a negation is still rejected after the relaxations', () => {
  assert.equal(keeps('I did not cut costs.', 'Cut costs'), false)
})

/**
 * DOCUMENTED LIMIT, not an oversight. See the "What this check does NOT
 * verify" section on `verifyCard` and the provenance paragraph in
 * `docs/specs/2026-08-11-cue-sheet-design.md`. These two assertions record
 * what the check CANNOT do, so nobody later reads the passing suite above as a
 * claim that cue text is safe against every kind of distortion.
 */
test('KNOWN GAP: re-attribution and re-pairing are not detectable by containment', () => {
  assert.equal(
    keeps('My manager decided the architecture and I implemented it.', 'Decided the architecture'),
    true,
    'my/i are stopwords, so who did what never reaches the compared token stream'
  )
  assert.equal(
    keeps('I cut costs by 5 percent while the target was 40 percent.', 'Cut costs by 40 percent'),
    true,
    'both numbers are the user\'s own words in order; the fabrication is in the pairing'
  )
})
