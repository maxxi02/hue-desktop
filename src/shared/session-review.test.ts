import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeReview, reviewSession, type ReviewTurn } from './session-review.ts'
import type { ProfileBundle, ProfileGap, ProfileStory } from './profile.ts'

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

const failureStory = story({
  id: 'failure-migration-rollback',
  competencies: ['failure', 'ownership'],
  situation: 'A migration rolled back in production.'
})

function gap(overrides: Partial<ProfileGap> = {}): ProfileGap {
  return {
    id: 'gap-ambiguity',
    competency: 'ambiguity',
    question: 'Tell me about a time the requirements were unclear.',
    status: 'open',
    storyId: null,
    ...overrides
  }
}

function bundle(overrides: Partial<ProfileBundle> = {}): ProfileBundle {
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
    stories: [story(), failureStory],
    gaps: [gap()],
    ...overrides
  }
}

/** A finished assistant turn that cited `s`. */
function cited(s: ProfileStory): ReviewTurn {
  return { role: 'assistant', grounding: { kind: 'grounded', story: s } }
}

/** A finished assistant turn that cited nothing (or something invented). */
function uncited(claimedId: string | null = null): ReviewTurn {
  return { role: 'assistant', grounding: { kind: 'ungrounded', claimedId } }
}

const asked: ReviewTurn = { role: 'user' }

test('a story cited twice counts twice but appears once, so the list reads as stories not as turns', () => {
  const review = reviewSession([cited(story()), asked, cited(story())], bundle())
  assert.equal(review.storiesUsed.length, 1)
  assert.equal(review.storiesUsed[0]?.count, 2)
  assert.equal(review.answers.grounded, 2)
})

test('the used story is named the way the user recognises it, not by its slug', () => {
  // The whole scorecard is unreadable if it lists ids: the user never wrote them.
  const review = reviewSession([cited(story())], bundle())
  assert.equal(review.storiesUsed[0]?.label, 'Sprint planning kept slipping in Q3 2024')
})

test('an ungrounded turn never credits a story, however confident the model was about the id', () => {
  // A near-miss id is an invented story wearing a citation. Crediting it here
  // would put a story the user never told into their "you used this" list.
  const review = reviewSession([uncited('conflict-with-manager'), uncited()], bundle())
  assert.deepEqual(review.storiesUsed, [])
  assert.equal(review.answers.ungrounded, 2)
  assert.equal(review.storiesUnused.length, 2)
})

test('a session with zero grounded answers reports that honestly rather than as an empty success', () => {
  const review = reviewSession([asked, uncited(), asked, uncited()], bundle())
  assert.deepEqual(review.answers, { total: 2, grounded: 0, ungrounded: 2 })
  assert.deepEqual(review.competencies, [])
  assert.match(describeReview(review), /0 of 2/)
})

test('user turns and half-finished answers are not counted as answers, or the failure rate inflates', () => {
  // A receipt arrives with the completed turn; an assistant turn still streaming
  // has none, and counting it as unanchored would blame the model for latency.
  const streaming: ReviewTurn = { role: 'assistant' }
  const review = reviewSession([asked, streaming, asked, cited(story())], bundle())
  assert.deepEqual(review.answers, { total: 1, grounded: 1, ungrounded: 0 })
})

test('competencies come only from cited stories, never from the bank at large', () => {
  // Owning a story about failure is not the same as having practised it, and a
  // scorecard that conflated the two would say the session covered everything.
  const review = reviewSession([cited(story()), uncited()], bundle())
  assert.deepEqual(review.competencies, ['conflict'])
})

test('every tag of a cited story counts, deduped and sorted so the pills are stable', () => {
  const review = reviewSession([cited(failureStory), cited(story()), cited(failureStory)], bundle())
  assert.deepEqual(review.competencies, ['conflict', 'failure', 'ownership'])
})

test('the most-used story leads, since that is the anecdote the session actually leaned on', () => {
  const review = reviewSession([cited(story()), cited(failureStory), cited(failureStory)], bundle())
  assert.deepEqual(
    review.storiesUsed.map((u) => [u.storyId, u.count]),
    [
      ['failure-migration-rollback', 2],
      ['conflict-manager-roadmap', 1]
    ]
  )
})

test('stories never cited are listed, because an untouched bank entry is the next thing to rehearse', () => {
  const review = reviewSession([cited(story())], bundle())
  assert.deepEqual(
    review.storiesUnused.map((s) => s.storyId),
    ['failure-migration-rollback']
  )
})

test('an open gap the session touched is separated from one it never approached', () => {
  // "Touched" means the session cited a story tagged with the gap's competency:
  // adjacent ground was walked and the gap is still open, which is a different
  // piece of advice from "this subject never came up".
  const b = bundle({
    gaps: [
      gap({ id: 'gap-conflict', competency: 'conflict' }),
      gap({ id: 'gap-ambiguity', competency: 'ambiguity' })
    ]
  })
  const review = reviewSession([cited(story())], b)
  assert.deepEqual(
    review.openGapsTouched.map((g) => g.id),
    ['gap-conflict']
  )
  assert.deepEqual(
    review.openGapsUntouched.map((g) => g.id),
    ['gap-ambiguity']
  )
})

test('an ungrounded session leaves every open gap untouched, not merely unmentioned', () => {
  const review = reviewSession([uncited(), uncited()], bundle())
  assert.deepEqual(review.openGapsTouched, [])
  assert.equal(review.openGapsUntouched.length, 1)
})

test('answered and skipped gaps stay off the list, so the user is not nagged about settled ones', () => {
  const b = bundle({
    gaps: [
      gap({ id: 'gap-answered', status: 'answered', storyId: 'conflict-manager-roadmap' }),
      gap({ id: 'gap-skipped', status: 'skipped' }),
      gap({ id: 'gap-open', status: 'open' })
    ]
  })
  const review = reviewSession([], b)
  assert.deepEqual(
    [...review.openGapsTouched, ...review.openGapsUntouched].map((g) => g.id),
    ['gap-open']
  )
})

test('an open gap carries its question, because the scorecard has to say what to go and answer', () => {
  const review = reviewSession([], bundle())
  assert.equal(
    review.openGapsUntouched[0]?.question,
    'Tell me about a time the requirements were unclear.'
  )
})

test('a session with no profile degrades to "no scorecard" rather than throwing mid-stop', () => {
  // Legacy installs have no bundle, and the review is computed at the exact
  // moment a session ends — the one moment this app cannot afford an exception.
  const review = reviewSession([asked, uncited(), uncited()], null)
  assert.equal(review.hasProfile, false)
  assert.deepEqual(review.answers, { total: 2, grounded: 0, ungrounded: 2 })
  assert.deepEqual(review.storiesUsed, [])
  assert.deepEqual(review.storiesUnused, [])
  assert.deepEqual(review.openGapsUntouched, [])
  assert.match(describeReview(review), /no profile/)
})

test('an empty session is described as empty rather than as a perfect one', () => {
  assert.equal(describeReview(reviewSession([], bundle())), 'No answers in this session')
  assert.equal(describeReview(reviewSession([], null)), 'No answers in this session')
})

test('the summary leads with the anchored count, which is the sentence that judges the session', () => {
  const review = reviewSession([cited(story()), cited(failureStory), uncited()], bundle())
  assert.equal(describeReview(review), '2 of 3 answers from your bank · 3 competencies')
})
