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

test('suppression drops fire and asks for a scheduler reset', () => {
  const state = newLatchState()
  const fire: Command[] = [{ kind: 'fire', specId: 1, text: 'why support' }]
  const out = gateCommands(fire, state, { suppress: true, latch: null, isFinal: false })
  assert.deepEqual(out.commands, [])
  assert.equal(out.resetScheduler, true, 'dropping fire without a reset desyncs the scheduler')
  assert.equal(state.suppressedQuestion, true)
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

test('a suppressed question that fails to latch still regenerates', () => {
  const state = newLatchState()
  gateCommands([{ kind: 'fire', specId: 1, text: 'x' }], state, {
    suppress: true, latch: null, isFinal: false
  })
  const out = gateCommands([{ kind: 'regenerate', specId: 2, text: 'full question' }], state, {
    suppress: false, latch: null, isFinal: true
  })
  assert.deepEqual(out.commands, [{ kind: 'regenerate', specId: 2, text: 'full question' }])
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
