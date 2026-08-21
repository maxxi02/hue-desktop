import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  categoriesWithMatches,
  matchesQuery,
  sectionsIn,
  SETTINGS_CATEGORIES,
  SETTINGS_SECTIONS,
  visibleSections,
  type SettingsSectionMeta
} from './settingsNav.ts'

function section(id: string): SettingsSectionMeta {
  const found = SETTINGS_SECTIONS.find((s) => s.id === id)
  assert.ok(found, `no section registered as ${id}`)
  return found
}

test('every section belongs to a category that exists in the rail', () => {
  const known = new Set(SETTINGS_CATEGORIES.map((c) => c.id))
  for (const s of SETTINGS_SECTIONS) {
    assert.ok(known.has(s.category), `${s.id} is filed under an unknown category`)
  }
})

test('every category has at least one section, so the rail has no dead rows', () => {
  for (const c of SETTINGS_CATEGORIES) {
    assert.ok(sectionsIn(c.id).length > 0, `${c.id} is an empty category`)
  }
})

test('section ids are unique — they are the key the pane hides sections by', () => {
  const ids = SETTINGS_SECTIONS.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('a category shows its own sections and nothing else', () => {
  const shown = visibleSections('audio', '')
  assert.deepEqual([...shown].sort(), ['asr', 'tts'])
})

test('search reaches across categories, because that is the case the rail cannot serve', () => {
  // "hotkey" is the word people use; the section is headed Shortcuts and filed
  // under Window. Someone searching it is exactly someone who does not know that.
  const shown = visibleSections('audio', 'hotkey')
  assert.ok(shown.has('shortcuts'))
})

test('typing more narrows the result rather than widening it', () => {
  const one = visibleSections('start', 'phone')
  const two = visibleSections('start', 'phone qr')
  assert.ok(two.size <= one.size)
  assert.ok([...two].every((id) => one.has(id)))
})

test('an accented heading is reachable from a keyboard without accents', () => {
  // The section is titled "Interview context" and its keywords carry "résumé".
  assert.ok(matchesQuery(section('interview'), 'resume'))
  assert.ok(matchesQuery(section('interview'), 'résumé'))
})

test('partial words match, because the useful queries are fragments', () => {
  assert.ok(matchesQuery(section('appearance'), 'opac'))
  assert.ok(matchesQuery(section('asr'), 'assembly'))
})

test('an empty or whitespace query is not a search', () => {
  assert.deepEqual(visibleSections('phone', '   '), visibleSections('phone', ''))
})

test('a query nothing matches yields nothing rather than falling back to a category', () => {
  // The empty state depends on this: silently showing the current category
  // would read as "here are your results", which would be a lie.
  assert.equal(visibleSections('window', 'zzzzz').size, 0)
})

test('the rail knows which categories hold hits, so it can dim the rest', () => {
  const hits = categoriesWithMatches('voice')
  assert.ok(hits.has('audio'))
  assert.ok(!hits.has('phone'))
})

test('with no query every category counts as matching', () => {
  assert.equal(categoriesWithMatches('').size, SETTINGS_CATEGORIES.length)
})

test('each category can be found by searching its own label', () => {
  // A user who reads the rail and types what they saw must land somewhere.
  for (const c of SETTINGS_CATEGORIES) {
    const word = c.label.split(/[\s&]+/)[0].toLowerCase()
    const shown = visibleSections(c.id, word)
    assert.ok(shown.size > 0, `searching "${word}" from ${c.id} found nothing`)
  }
})
