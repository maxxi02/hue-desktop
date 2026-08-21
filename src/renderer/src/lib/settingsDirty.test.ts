import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSettingsDirty } from './settingsDirty.ts'
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
