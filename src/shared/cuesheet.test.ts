import test from 'node:test'
import assert from 'node:assert/strict'
import { cueTokens, buildDf, scoreAgainst } from './cuesheet.ts'

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

import { CueMatcher, DEFAULT_MATCH_CONFIG, type CueSheet } from './cuesheet.ts'

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

import { gateCommands, newLatchState } from './cuesheet.ts'
import type { Command } from './speculation.ts'
import { SpeculationScheduler } from './speculation.ts'

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

import { verifyCard, scriptIsExtractive } from './cuesheet.ts'

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
