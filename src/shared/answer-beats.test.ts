import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBeats, BEAT_LABELS, BEAT_LABEL_TEXT } from './answer-beats.ts'

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

// Still closed, and now spanning two kinds of answer. The list is pinned rather
// than counted so that adding a marker to a prompt without adding it here, or
// the reverse, fails loudly: a marker the prompt asks for that the parser does
// not know sits on screen as literal "## " text mid-answer.
test('the vocabulary is exactly the markers the two prompts name', () => {
  assert.deepEqual(
    [...BEAT_LABELS],
    ['what', 'why', 'how', 'when', 'scenario', 'approach', 'steps', 'code', 'complexity']
  )
})

// The margin tag is what the user reads mid-interview, and for the story it has
// to say what to DO with the block rather than what the block is. The answer
// above is complete on its own; this part is only volunteered if asked.
test('the story tag tells the user it is optional', () => {
  assert.equal(BEAT_LABEL_TEXT.scenario, 'if they ask')
})

// Every marker the parser accepts must have a tag, or a beat renders with an
// empty margin and the column silently misaligns.
test('every label has display text', () => {
  for (const label of BEAT_LABELS) {
    assert.ok(BEAT_LABEL_TEXT[label]?.length > 0, `${label} has no display text`)
  }
})

const CODE_ANSWER =
  '## approach\nCache the render and stream the shell first.\n' +
  '## steps\n1. Key the cache on the route.\n2. Stream the shell.\n' +
  '## code\n' +
  'function render(req) {\n' +
  '    const key = routeKey(req)\n' +
  '    return cache.get(key)\n' +
  '}\n' +
  '## complexity\nO(1) lookup, O(n) render.'

test('the four assessment labels are recognised', () => {
  const beats = parseBeats(CODE_ANSWER)
  assert.deepEqual(
    beats.map((b) => b.label),
    ['approach', 'steps', 'code', 'complexity']
  )
})

test('a code beat keeps the indentation of its first line', () => {
  // parseBeats used to flush with .trim(), which strips leading whitespace from
  // the START of the joined body, i.e. the first line only. The result was a
  // block whose first line was dedented and whose others were not.
  const beats = parseBeats('## code\n    def key(req):\n        return req.path')
  const code = beats.find((b) => b.label === 'code')
  assert.ok(code)
  assert.equal(code.text, '    def key(req):\n        return req.path')
})

test('a code beat still drops surrounding blank lines', () => {
  const beats = parseBeats('## code\n\n\nconst a = 1\n\n\n')
  assert.equal(beats.find((b) => b.label === 'code')?.text, 'const a = 1')
})

test('a one-word comment at the end of a code beat does not flicker', () => {
  // withholdPartialMarker holds back an unterminated last line that could still
  // become a marker, and PARTIAL_MARKER matches "# key". Inside a code beat
  // that made the last line vanish and reappear as tokens arrived.
  const beats = parseBeats('## code\nconst a = 1\n# key')
  assert.equal(beats.find((b) => b.label === 'code')?.text, 'const a = 1\n# key')
})

test('an unknown trailing marker does not re-arm withholding inside code', () => {
  // The guard must track whether the LAST KNOWN label was code. Scanning for the
  // last '##' line of any word would see '## TODO' here, conclude the buffer is
  // no longer in a code beat, and start withholding the comment again.
  const beats = parseBeats('## code\nconst a = 1\n## TODO\n# key')
  assert.equal(beats.find((b) => b.label === 'code')?.text, 'const a = 1\n## TODO\n# key')
})

test('an indented label line inside code does not split the beat', () => {
  const beats = parseBeats('## code\nif (x) {\n    ## code\n}')
  assert.equal(beats.length, 1)
  assert.equal(beats[0].text, 'if (x) {\n    ## code\n}')
})

test('a marker at column zero still closes a code beat', () => {
  const beats = parseBeats('## code\nconst a = 1\n## complexity\nO(1).')
  assert.deepEqual(
    beats.map((b) => b.label),
    ['code', 'complexity']
  )
})

test('prose beats are unaffected by the code-beat rules', () => {
  const beats = parseBeats('## what\n  Leading space is still trimmed here.')
  assert.equal(beats[0].text, 'Leading space is still trimmed here.')
})
