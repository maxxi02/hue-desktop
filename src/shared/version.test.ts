import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayVersion } from './version.ts'

test('a base release drops the patch field entirely', () => {
  assert.equal(displayVersion('1.5.0'), '1.5')
  assert.equal(displayVersion('2.0.0'), '2.0')
  assert.equal(displayVersion('1.10.0'), '1.10')
})

test('the first follow-up is b, because the base release is already a', () => {
  // The rule that makes a letter informative: seeing 1.5b tells you a 1.5
  // existed and that something in it needed fixing. A 1.5a would say nothing.
  assert.equal(displayVersion('1.5.1'), '1.5b')
  assert.notEqual(displayVersion('1.5.1'), '1.5a')
})

test('later follow-ups walk the alphabet', () => {
  assert.equal(displayVersion('1.5.2'), '1.5c')
  assert.equal(displayVersion('1.5.3'), '1.5d')
  assert.equal(displayVersion('1.5.25'), '1.5z')
})

test('ordering is preserved, which is the reason this is a mapping at all', () => {
  // The update feed sorts on semver and never sees the display form, so the two
  // orderings must agree or a follow-up could sort ahead of the patch it fixes.
  const semvers = ['1.5.0', '1.5.1', '1.5.2', '1.6.0', '2.0.0']
  assert.deepEqual(semvers.map(displayVersion), ['1.5', '1.5b', '1.5c', '1.6', '2.0'])
})

test('past z it falls back to the number rather than inventing aa', () => {
  assert.equal(displayVersion('1.5.26'), '1.5.26')
  assert.equal(displayVersion('1.5.99'), '1.5.99')
})

test('a prerelease is shown verbatim, because it has not earned a letter yet', () => {
  assert.equal(displayVersion('1.6.0-beta.2'), '1.6.0-beta.2')
  assert.equal(displayVersion('1.6.0+build.7'), '1.6.0+build.7')
})

test('anything malformed is passed through rather than silently rewritten', () => {
  // Better a version that looks wrong than one that looks fine and is not.
  assert.equal(displayVersion(''), '')
  assert.equal(displayVersion('1.5'), '1.5')
  assert.equal(displayVersion('not a version'), 'not a version')
})

test('surrounding whitespace does not defeat the match', () => {
  assert.equal(displayVersion('  1.5.1  '), '1.5b')
})
