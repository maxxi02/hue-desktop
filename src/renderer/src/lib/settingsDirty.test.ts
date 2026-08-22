import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeUnsaved, isSettingsDirty } from './settingsDirty.ts'
import { DEFAULT_SETTINGS } from '../../../shared/types.ts'

const clean = (): typeof DEFAULT_SETTINGS => ({ ...DEFAULT_SETTINGS })

test('identical settings with no drafts are clean', () => {
  assert.equal(isSettingsDirty(clean(), clean(), {}), false)
})

test('a changed field is dirty', () => {
  assert.equal(isSettingsDirty({ ...clean(), jobTitle: 'Staff Engineer' }, clean(), {}), true)
})

// The case that makes the guard worth having: a key typed and never saved is
// gone the moment the backdrop is clicked.
test('a typed API key is dirty', () => {
  assert.equal(isSettingsDirty({ ...clean(), anthropicApiKey: 'sk-ant-xxx' }, clean(), {}), true)
})

// A gap answer is a story the user just composed. Losing it is worse than
// losing a toggle, and it lives outside the settings object entirely.
test('an unsent gap answer is dirty even when settings match', () => {
  assert.equal(isSettingsDirty(clean(), clean(), { 'gap-conflict': 'We disagreed about…' }), true)
})

test('a whitespace-only draft is not dirty', () => {
  assert.equal(isSettingsDirty(clean(), clean(), { 'gap-conflict': '   \n ' }), false)
})

test('an empty draft map entry is not dirty', () => {
  assert.equal(isSettingsDirty(clean(), clean(), { 'gap-conflict': '' }), false)
})

test('one real draft among empty ones is dirty', () => {
  assert.equal(isSettingsDirty(clean(), clean(), { a: '', b: '  ', c: 'a real answer' }), true)
})

// Key order is an artifact of how the object was built — a settings object
// rebuilt by a spread must not read as changed.
test('key order does not make settings dirty', () => {
  const pristine = clean()
  const reordered = Object.fromEntries(
    Object.entries(pristine).reverse()
  ) as typeof DEFAULT_SETTINGS
  assert.equal(isSettingsDirty(reordered, pristine, {}), false)
})

/*
  The bug these pin down.

  `save()` writes settings and nothing else, because a gap answer is not a
  setting -- it is a model call that turns spoken words into a story. But the
  guard counted a typed gap draft as unsaved work, so pressing Save could never
  satisfy it: the dialog reappeared on every close attempt, for ever.

  Worse than the nag: the dialog's own "Save and close" ran save() and then
  closed, destroying the typed answer while the copy above it said that button
  saved unsaved work.

  The fix is not to stop counting gap drafts. Losing a story someone just
  composed from memory is exactly what this guard exists to prevent. The fix is
  to say WHICH kind of work is outstanding, so the dialog can offer an action
  that actually covers it.
*/

test('a typed gap answer is reported as its own kind of unsaved work', () => {
  const s = clean()
  const work = describeUnsaved(s, s, { g1: 'we shipped late and I owned it' })
  assert.equal(work.settings, false)
  assert.equal(work.gapAnswer, true)
  assert.equal(work.any, true)
})

test('a settings edit is reported separately from a gap answer', () => {
  const pristine = clean()
  const current = { ...pristine, anthropicApiKey: 'sk-new' }
  const work = describeUnsaved(current, pristine, {})
  assert.equal(work.settings, true)
  assert.equal(work.gapAnswer, false)
})

test('both kinds are reported when both are outstanding', () => {
  const pristine = clean()
  const current = { ...pristine, anthropicApiKey: 'sk-new' }
  const work = describeUnsaved(current, pristine, { g1: 'a story' })
  assert.equal(work.settings, true)
  assert.equal(work.gapAnswer, true)
})

test('saving settings clears the settings half and leaves the gap answer', () => {
  // This is the reported bug, end to end. After save(), markPersisted assigns
  // the same object to both s and pristine -- so the settings half must go
  // quiet even though the gap draft legitimately keeps the guard armed.
  const afterSave = { ...clean(), anthropicApiKey: 'sk-saved' }
  const work = describeUnsaved(afterSave, afterSave, { g1: 'a story' })
  assert.equal(work.settings, false, 'Save must satisfy the settings half')
  assert.equal(work.gapAnswer, true, 'the typed answer is still unsent')
})

test('whitespace in a draft is not work', () => {
  const s = clean()
  assert.equal(describeUnsaved(s, s, { g1: '   \n  ' }).gapAnswer, false)
})

test('isSettingsDirty still answers the old question', () => {
  const s = clean()
  assert.equal(isSettingsDirty(s, s, { g1: 'x' }), true)
  assert.equal(isSettingsDirty(s, s, {}), false)
})
