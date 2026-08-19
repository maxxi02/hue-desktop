import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBeats, BEAT_LABELS } from './answer-beats.ts'

test('labelled sections become labelled beats', () => {
  const answer = '## what\nI own the deploy pipeline.\n\n## why\nWe lost a day a week.'
  assert.deepEqual(parseBeats(answer), [
    { label: 'what', text: 'I own the deploy pipeline.' },
    { label: 'why', text: 'We lost a day a week.' }
  ])
})

test('an unmarked answer degrades to unlabelled beats', () => {
  assert.deepEqual(parseBeats('One block.\n\nAnother block.'), [
    { label: null, text: 'One block.' },
    { label: null, text: 'Another block.' }
  ])
})

// The vocabulary is closed on purpose. A marker the model invents must read as
// prose rather than silently becoming a tag the card renders.
test('an unknown marker stays prose', () => {
  const beats = parseBeats('## verdict\nSomething.')
  assert.equal(beats.length, 1)
  assert.equal(beats[0].label, null)
  assert.match(beats[0].text, /verdict/)
})

// The prompt mandates [company] and [X]% placeholders. A parser that ate them
// would silently drop the start of a beat.
test('bracket placeholders are never mistaken for markers', () => {
  const beats = parseBeats('## scenario\n[company] cut load time by [X]%.')
  assert.deepEqual(beats, [{ label: 'scenario', text: '[company] cut load time by [X]%.' }])
})

/**
 * The invariant that matters most.
 *
 * The answer streams token by token, so at some instant the buffer ends in "#",
 * then "##", then "## wh". If any of those render as prose the card flashes
 * garbage into the middle of a sentence the user is reading aloud, live.
 */
test('no prefix of a streaming answer ever renders a partial marker', () => {
  const full = '## what\nI own the pipeline.\n\n## scenario\nAt Solarworks I cut it to six minutes.'
  for (let i = 1; i <= full.length; i++) {
    for (const beat of parseBeats(full.slice(0, i))) {
      assert.doesNotMatch(beat.text, /^#/, `partial marker leaked at ${i}: ${beat.text}`)
    }
  }
})

// A settled beat must keep rendering while the next marker is still arriving,
// or the card would blank between sections mid-answer.
test('a completed beat still renders while the next marker is arriving', () => {
  assert.deepEqual(parseBeats('## what\nI own the pipeline.\n\n##'), [
    { label: 'what', text: 'I own the pipeline.' }
  ])
  assert.deepEqual(parseBeats('## what\nI own the pipeline.\n\n## scen'), [
    { label: 'what', text: 'I own the pipeline.' }
  ])
})

// Once markers are in play they own the boundaries. A blank line inside a
// section is spacing, not a new beat, or one section would split into two
// unlabelled fragments.
test('a blank line inside a labelled section does not split it', () => {
  assert.deepEqual(parseBeats('## scenario\nFirst line.\n\nSecond line.'), [
    { label: 'scenario', text: 'First line.\n\nSecond line.' }
  ])
})

test('blank input is no beats', () => {
  assert.deepEqual(parseBeats(''), [])
  assert.deepEqual(parseBeats('   \n  '), [])
})

// A marker with nothing under it yet must not emit an empty beat: the card
// would render a bare tag against blank space.
test('a marker with no body yet emits nothing', () => {
  assert.deepEqual(parseBeats('## what\n'), [])
})

test('the vocabulary is exactly the five the prompt names', () => {
  assert.deepEqual([...BEAT_LABELS], ['what', 'why', 'how', 'when', 'scenario'])
})
