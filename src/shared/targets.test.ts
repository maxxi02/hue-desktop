import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, type HueSettings } from './types.ts'
import {
  commitActive,
  createTarget,
  deleteTarget,
  duplicateTarget,
  ensureTargets,
  fieldsOf,
  MAX_TARGETS,
  parseTargets,
  renameTarget,
  serialiseTargets,
  summarise,
  switchTarget,
  UNTITLED_TARGET,
  type Target
} from './targets.ts'

/**
 * These tests are about one invariant and its consequences: the live settings
 * fields are the working copy of the active application, and the stored copy of
 * that application is stale until something commits it. Nearly every bug this
 * feature can have is a missing commit, so most of what follows is a check that
 * work typed into one application is still there after a trip through another.
 */

function settings(patch: Partial<HueSettings> = {}): HueSettings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

/** Settings holding one saved application plus whatever is live. */
function withTargets(
  targets: Target[],
  activeId: string,
  patch: Partial<HueSettings> = {}
): HueSettings {
  return settings({ targetsJson: serialiseTargets(targets), activeTargetId: activeId, ...patch })
}

function target(id: string, name: string, patch: Partial<Record<string, string>> = {}): Target {
  return {
    id,
    name,
    fields: {
      jobTitle: '',
      jobDescription: '',
      jobSpecJson: '',
      jobBriefJson: '',
      profileBundleJson: '',
      resumeSummary: '',
      ...patch
    }
  }
}

test('an install that has never seen applications gets one made from what it already has', () => {
  const patch = ensureTargets(
    settings({ jobTitle: 'Staff Engineer', jobDescription: 'Posting text.' })
  )
  assert.ok(patch)
  const targets = parseTargets(patch.targetsJson as string)
  assert.equal(targets.length, 1)
  // Named after the job they were already preparing for, not "Application 1".
  assert.equal(targets[0].name, 'Staff Engineer')
  assert.equal(targets[0].fields.jobDescription, 'Posting text.')
  assert.equal(patch.activeTargetId, targets[0].id)
  // And nothing they had is disturbed.
  assert.equal(patch.jobTitle, 'Staff Engineer')
})

test('an install with nothing filled in still gets a usable, named slot', () => {
  const patch = ensureTargets(settings())
  assert.ok(patch)
  assert.equal(parseTargets(patch.targetsJson as string)[0].name, UNTITLED_TARGET)
})

test('ensure is a no-op once there is a list, so launching does not rewrite the file', () => {
  const s = withTargets([target('app-1', 'Stripe')], 'app-1')
  assert.equal(ensureTargets(s), null)
})

test('a pointer at an application that is gone falls back rather than stranding the live fields', () => {
  const s = withTargets([target('app-1', 'Stripe')], 'app-9', { jobTitle: 'Typed since' })
  const patch = ensureTargets(s)
  assert.ok(patch)
  assert.equal(patch.activeTargetId, 'app-1')
  // The work in the live fields is real work; it is adopted, not discarded.
  assert.equal(patch.jobTitle, 'Typed since')
})

test('switching stores what was in the fields and restores what the other one had', () => {
  const s = withTargets(
    [
      target('app-1', 'Stripe', { jobTitle: 'stale' }),
      target('app-2', 'Datadog', {
        jobTitle: 'Backend Engineer',
        jobDescription: 'Datadog posting.'
      })
    ],
    'app-1',
    { jobTitle: 'Senior Platform Engineer', jobDescription: 'Stripe posting.' }
  )

  const patch = switchTarget(s, 'app-2')
  assert.ok(patch)
  // The incoming application's saved work is now live.
  assert.equal(patch.jobTitle, 'Backend Engineer')
  assert.equal(patch.jobDescription, 'Datadog posting.')
  // And the outgoing one kept what was in the fields, not the stale copy.
  const stored = parseTargets(patch.targetsJson as string)
  assert.equal(stored.find((t) => t.id === 'app-1')?.fields.jobTitle, 'Senior Platform Engineer')
  assert.equal(stored.find((t) => t.id === 'app-1')?.fields.jobDescription, 'Stripe posting.')
})

test('a switch and a switch back is the identity, which is the whole promise', () => {
  const start = withTargets(
    [target('app-1', 'Stripe'), target('app-2', 'Datadog', { jobTitle: 'Backend Engineer' })],
    'app-1',
    { jobTitle: 'Senior Platform Engineer', profileBundleJson: '{"hash":"abc"}' }
  )

  const away = { ...start, ...switchTarget(start, 'app-2') }
  const back = { ...away, ...switchTarget(away, 'app-1') }

  assert.equal(back.jobTitle, 'Senior Platform Engineer')
  assert.equal(back.profileBundleJson, '{"hash":"abc"}')
  assert.equal(back.activeTargetId, 'app-1')
})

test('the résumé travels with its application, so a brief never describes a bank that is gone', () => {
  const s = withTargets(
    [
      target('app-1', 'Stripe'),
      target('app-2', 'Datadog', {
        profileBundleJson: '{"hash":"datadog"}',
        jobBriefJson: '{"likelyQuestions":[]}'
      })
    ],
    'app-1',
    { profileBundleJson: '{"hash":"stripe"}', jobBriefJson: '{"likelyQuestions":["stripe"]}' }
  )
  const patch = switchTarget(s, 'app-2')
  assert.ok(patch)
  assert.equal(patch.profileBundleJson, '{"hash":"datadog"}')
  assert.equal(patch.jobBriefJson, '{"likelyQuestions":[]}')
})

test('switching to the active application writes nothing', () => {
  const s = withTargets([target('app-1', 'Stripe')], 'app-1')
  assert.equal(switchTarget(s, 'app-1'), null)
})

test('switching to an application that does not exist writes nothing', () => {
  const s = withTargets([target('app-1', 'Stripe')], 'app-1')
  assert.equal(switchTarget(s, 'app-404'), null)
})

test('a new application is empty, and does not inherit the posting you were reading', () => {
  const s = withTargets([target('app-1', 'Stripe')], 'app-1', {
    jobTitle: 'Senior Platform Engineer',
    jobDescription: 'Stripe posting.',
    profileBundleJson: '{"hash":"abc"}'
  })
  const patch = createTarget(s, 'Figma')
  assert.ok(patch)
  assert.equal(patch.jobTitle, '')
  assert.equal(patch.jobDescription, '')
  assert.equal(patch.profileBundleJson, '')
  // The one you left keeps everything.
  const stored = parseTargets(patch.targetsJson as string)
  assert.equal(stored.find((t) => t.id === 'app-1')?.fields.jobDescription, 'Stripe posting.')
  assert.equal(stored.find((t) => t.id === patch.activeTargetId)?.name, 'Figma')
})

test('duplicate carries the résumé across, which is the point of it', () => {
  const s = withTargets([target('app-1', 'Stripe')], 'app-1', {
    jobTitle: 'Senior Platform Engineer',
    profileBundleJson: '{"hash":"abc"}'
  })
  const patch = duplicateTarget(s, 'Stripe copy')
  assert.ok(patch)
  assert.equal(patch.profileBundleJson, '{"hash":"abc"}')
  assert.equal(patch.jobTitle, 'Senior Platform Engineer')
  assert.equal(parseTargets(patch.targetsJson as string).length, 2)
  assert.notEqual(patch.activeTargetId, 'app-1')
})

test('the ceiling is enforced rather than letting the settings file grow forever', () => {
  const many = Array.from({ length: MAX_TARGETS }, (_, i) => target(`app-${i + 1}`, `App ${i + 1}`))
  const s = withTargets(many, 'app-1')
  assert.equal(createTarget(s, 'One more'), null)
  assert.equal(duplicateTarget(s, 'One more'), null)
})

test('renaming changes the label and nothing else', () => {
  const s = withTargets([target('app-1', 'Stripe'), target('app-2', 'Datadog')], 'app-1', {
    jobTitle: 'Senior Platform Engineer'
  })
  const patch = renameTarget(s, 'app-2', '  Datadog   —  Infra  ')
  assert.ok(patch)
  const stored = parseTargets(patch.targetsJson as string)
  assert.equal(stored.find((t) => t.id === 'app-2')?.name, 'Datadog — Infra')
  assert.equal(patch.activeTargetId, 'app-1')
  assert.equal(patch.jobTitle, 'Senior Platform Engineer')
})

test('a blank name is a name, not an empty row', () => {
  const s = withTargets([target('app-1', 'Stripe')], 'app-1')
  const patch = renameTarget(s, 'app-1', '   ')
  assert.ok(patch)
  assert.equal(parseTargets(patch.targetsJson as string)[0].name, UNTITLED_TARGET)
})

test('deleting the one you are on lands you on its neighbour, with that one loaded', () => {
  const s = withTargets(
    [
      target('app-1', 'Stripe'),
      target('app-2', 'Datadog', { jobTitle: 'Backend Engineer' }),
      target('app-3', 'Figma')
    ],
    'app-2',
    { jobTitle: 'Backend Engineer' }
  )
  const patch = deleteTarget(s, 'app-2')
  assert.ok(patch)
  assert.equal(patch.activeTargetId, 'app-3')
  assert.equal(patch.jobTitle, '')
  assert.deepEqual(
    parseTargets(patch.targetsJson as string).map((t) => t.id),
    ['app-1', 'app-3']
  )
})

test('deleting the last one in the list lands on the new last one', () => {
  const s = withTargets([target('app-1', 'Stripe'), target('app-2', 'Datadog')], 'app-2')
  const patch = deleteTarget(s, 'app-2')
  assert.ok(patch)
  assert.equal(patch.activeTargetId, 'app-1')
})

test('deleting one you are not on leaves your fields untouched', () => {
  const s = withTargets([target('app-1', 'Stripe'), target('app-2', 'Datadog')], 'app-1', {
    jobTitle: 'Senior Platform Engineer'
  })
  const patch = deleteTarget(s, 'app-2')
  assert.ok(patch)
  assert.equal(patch.jobTitle, 'Senior Platform Engineer')
  assert.equal(patch.activeTargetId, 'app-1')
})

test('the last application cannot be deleted', () => {
  const s = withTargets([target('app-1', 'Stripe')], 'app-1')
  assert.equal(deleteTarget(s, 'app-1'), null)
})

test('a malformed targetsJson reads as "no applications", never as a throw', () => {
  assert.deepEqual(parseTargets('not json'), [])
  assert.deepEqual(parseTargets('{"not":"an array"}'), [])
  assert.deepEqual(parseTargets(''), [])
})

test('a hand-edited file missing ids and fields is repaired rather than rejected', () => {
  const parsed = parseTargets(JSON.stringify([{ name: 'Stripe' }, { name: 'Datadog' }]))
  assert.equal(parsed.length, 2)
  assert.notEqual(parsed[0].id, parsed[1].id)
  // Every field is present as a string, because the callers index into it.
  assert.equal(parsed[0].fields.jobDescription, '')
  assert.equal(parsed[0].fields.profileBundleJson, '')
})

test('duplicate ids in a hand-edited file are made unique, not left to collide', () => {
  const parsed = parseTargets(
    JSON.stringify([
      { id: 'same', name: 'A', fields: {} },
      { id: 'same', name: 'B', fields: {} }
    ])
  )
  assert.notEqual(parsed[0].id, parsed[1].id)
})

test('the list shows the active application as it is now, not as it was last saved', () => {
  const targets = [target('app-1', 'Stripe', { jobTitle: 'stale' }), target('app-2', 'Datadog')]
  const live = fieldsOf(settings({ jobTitle: 'Senior Platform Engineer', jobDescription: 'x' }))
  const rows = summarise(targets, 'app-1', live)
  assert.equal(rows[0].jobTitle, 'Senior Platform Engineer')
  assert.equal(rows[0].hasJobDescription, true)
  assert.equal(rows[1].hasJobDescription, false)
})

test('commitActive touches only the active application', () => {
  const targets = [target('app-1', 'Stripe'), target('app-2', 'Datadog', { jobTitle: 'keep me' })]
  const live = fieldsOf(settings({ jobTitle: 'new' }))
  const out = commitActive(targets, 'app-1', live)
  assert.equal(out[0].fields.jobTitle, 'new')
  assert.equal(out[1].fields.jobTitle, 'keep me')
})
