import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeStory,
  groundResponse,
  parseResponse,
  resolveGrounding,
  stripStreamingCitation
} from './grounding.ts'
import type { ProfileBundle, ProfileStory } from './profile.ts'

function story(overrides: Partial<ProfileStory> = {}): ProfileStory {
  return {
    id: 'conflict-manager-roadmap',
    roleId: 'acme-robotics',
    competencies: ['conflict'],
    situation: 'Sprint planning kept slipping in Q3 2024.',
    task: 'Settle it.',
    action: 'Proposed a data-backed alternative.',
    result: 'My approach won.',
    metrics: ['40%'],
    source: 'resume',
    ...overrides
  }
}

function bundle(
  stories: ProfileStory[] = [story(), story({ id: 'failure-migration-rollback' })]
): ProfileBundle {
  return {
    version: 1,
    hash: 'a'.repeat(64),
    createdAt: '2026-08-09T12:00:00.000Z',
    profile: {
      identity: { name: 'Jordan Reyes', headline: null, location: null, email: null, links: [] },
      roles: [],
      education: [],
      skills: [],
      metrics: []
    },
    stories,
    gaps: []
  }
}

test('an id the model cited resolves to the story it names, which is the receipt the user reads', () => {
  const grounding = resolveGrounding('conflict-manager-roadmap', bundle())
  assert.equal(grounding.kind, 'grounded')
  assert.equal(grounding.kind === 'grounded' && grounding.story.id, 'conflict-manager-roadmap')
})

test('an id absent from the bank is ungrounded, never an error and never repaired', () => {
  // The dangerous case. A model naming a story that does not exist has invented
  // it, and a fabricated citation reads as more trustworthy than no citation.
  const grounding = resolveGrounding('conflict-with-manager', bundle())
  assert.deepEqual(grounding, { kind: 'ungrounded', claimedId: 'conflict-with-manager' })
})

test('a near miss is not fuzzy-matched, because that would launder a hallucination into a citation', () => {
  // No Levenshtein, no case folding, ever: a nearest-neighbour lookup turns
  // exactly the invented-story case into a confident grounded receipt.
  for (const claimed of [
    'Conflict-Manager-Roadmap',
    'conflict-manager-roadmapp',
    'conflict_manager_roadmap',
    'conflict-manager',
    'conflict-manager-roadmap-2'
  ]) {
    assert.equal(resolveGrounding(claimed, bundle()).kind, 'ungrounded', claimed)
  }
})

test('an explicit null is ungrounded, since declining to cite is the honest answer, not a grounded one', () => {
  assert.deepEqual(resolveGrounding(null, bundle()), { kind: 'ungrounded', claimedId: null })
  assert.deepEqual(resolveGrounding('   ', bundle()), { kind: 'ungrounded', claimedId: null })
})

test('an empty story bank grounds nothing, so a user who uploaded no resume is warned every time', () => {
  assert.equal(resolveGrounding('anything', bundle([])).kind, 'ungrounded')
})

test("the prompt's own square brackets and stray whitespace are undone, or real citations would be flagged", () => {
  // profilePromptBlock() prints ids as `### [conflict-manager-roadmap]`, and
  // models copy that formatting verbatim often enough that rejecting it would
  // flag genuinely grounded answers as hallucinations.
  for (const claimed of [
    '  conflict-manager-roadmap ',
    '[conflict-manager-roadmap]',
    '  [conflict-manager-roadmap] ',
    '[ conflict-manager-roadmap ]'
  ]) {
    assert.equal(resolveGrounding(claimed, bundle()).kind, 'grounded', claimed)
  }
})

test('the citation line is stripped, so the user never reads raw story_id scaffolding aloud', () => {
  const parsed = parseResponse(
    'I pushed back on the roadmap with data.\n\nstory_id: conflict-manager-roadmap'
  )
  assert.equal(parsed.answer, 'I pushed back on the roadmap with data.')
  assert.equal(parsed.storyId, 'conflict-manager-roadmap')
})

test('the citation survives the formatting models actually wrap it in', () => {
  const forms = [
    'story_id: conflict-manager-roadmap',
    'story_id: "conflict-manager-roadmap"',
    '"story_id": "conflict-manager-roadmap",',
    '**story_id:** conflict-manager-roadmap',
    '`story_id: conflict-manager-roadmap`',
    '- story_id: [conflict-manager-roadmap]',
    '   story_id:   conflict-manager-roadmap   '
  ]
  for (const form of forms) {
    const parsed = parseResponse(`Answer text.\n${form}`)
    assert.equal(parsed.answer, 'Answer text.', form)
    assert.equal(resolveGrounding(parsed.storyId, bundle()).kind, 'grounded', form)
  }
})

test('a literal null citation is read as no citation rather than as an id to look up', () => {
  const parsed = parseResponse(
    'Nothing in my history fits, so I would keep it general.\nstory_id: null'
  )
  assert.equal(parsed.storyId, null)
  assert.equal(parsed.answer, 'Nothing in my history fits, so I would keep it general.')
  assert.equal(resolveGrounding(parsed.storyId, bundle()).kind, 'ungrounded')
})

test('a response with no citation at all is ungrounded, so an omitted receipt cannot pass as a clean one', () => {
  const { answer, grounding } = groundResponse(
    'A perfectly confident answer with no receipt.',
    bundle()
  )
  assert.equal(answer, 'A perfectly confident answer with no receipt.')
  assert.deepEqual(grounding, { kind: 'ungrounded', claimedId: null })
})

test('a story id mentioned mid-sentence is prose, not a citation, and is left in the answer', () => {
  // Anchoring to a whole line matters: cutting mid-sentence would delete words
  // the user was about to say out loud.
  const parsed = parseResponse('I tagged the ticket story_id: whatever in Jira and moved on.')
  assert.equal(parsed.answer, 'I tagged the ticket story_id: whatever in Jira and moved on.')
  assert.equal(parsed.storyId, null)
})

test('the last citation wins when a model emits two, and neither is left on screen', () => {
  const parsed = parseResponse(
    'One.\nstory_id: failure-migration-rollback\nTwo.\nstory_id: conflict-manager-roadmap'
  )
  assert.equal(parsed.storyId, 'conflict-manager-roadmap')
  assert.doesNotMatch(parsed.answer, /story_id/)
})

test('a whole-document JSON reply parses, since that is the contract the phone client shares', () => {
  const parsed = parseResponse(
    '{"cues":["a"],"story_id":"conflict-manager-roadmap","answer":"In Q3 our planning kept slipping."}'
  )
  assert.equal(parsed.answer, 'In Q3 our planning kept slipping.')
  assert.equal(parsed.storyId, 'conflict-manager-roadmap')

  const nulled = parseResponse('{"story_id":null,"answer":"Nothing fits."}')
  assert.equal(nulled.answer, 'Nothing fits.')
  assert.equal(nulled.storyId, null)
})

test('a malformed JSON reply is not repaired; it is read as the prose it looks like', () => {
  // Guessing at a broken document is how scaffolding reaches the screen.
  const parsed = parseResponse('{"story_id": "conflict-manager-roadmap", "answer": "truncated')
  assert.match(parsed.answer, /truncated/)
})

test('a half-arrived citation never flashes on screen while the response is still streaming', () => {
  // The citation is the last thing to arrive, so every prefix of it is rendered
  // at least once unless it is held back.
  const full = 'The answer.\nstory_id: conflict-manager-roadmap'
  for (let i = 0; i <= full.length; i++) {
    assert.doesNotMatch(stripStreamingCitation(full.slice(0, i)), /story/, `prefix ${i}`)
  }
  assert.equal(stripStreamingCitation(full), 'The answer.')
})

test('a grounded receipt names the story in words the user recognises, not by its slug', () => {
  assert.equal(describeStory(story()), 'Sprint planning kept slipping in Q3 2024')
  assert.equal(describeStory(story({ situation: 'A'.repeat(80) }), 10), `${'A'.repeat(9)}…`)
})
