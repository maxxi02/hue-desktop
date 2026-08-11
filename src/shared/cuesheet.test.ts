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
