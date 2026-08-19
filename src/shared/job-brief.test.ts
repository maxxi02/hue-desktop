import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  JOB_BRIEF_BLOCK_LIMIT,
  JOB_BRIEF_QUESTION_LIMIT,
  jobBriefPromptBlock,
  parseJobBrief,
  type JobBrief
} from './job-brief.ts'

const brief = (over: Partial<JobBrief> = {}): JobBrief => ({
  likelyQuestions: [
    { question: 'Tell me about a slow query you tuned.', storyId: 'pg-index-fix', competency: 'ownership' },
    { question: 'How do you handle conflicting priorities?', storyId: null, competency: 'ownership' }
  ],
  uncoveredRequirements: [],
  ...over
})

test('a brief round-trips through JSON', () => {
  const parsed = parseJobBrief(JSON.stringify(brief()))
  assert.equal(parsed?.likelyQuestions.length, 2)
  assert.equal(parsed?.likelyQuestions[0].storyId, 'pg-index-fix')
})

test('garbage, empty, and non-object JSON parse to null rather than throwing', () => {
  assert.equal(parseJobBrief(''), null)
  assert.equal(parseJobBrief('not json'), null)
  assert.equal(parseJobBrief('[]'), null)
  assert.equal(parseJobBrief('null'), null)
})

test('a brief missing its question list is not a brief', () => {
  assert.equal(parseJobBrief('{"uncoveredRequirements":[]}'), null)
})

test('the block names the story that answers each question', () => {
  const block = jobBriefPromptBlock(brief())
  assert.match(block, /Tell me about a slow query you tuned\./)
  assert.match(block, /pg-index-fix/)
})

// A question with no story is the honest case and must read as such. Rendering
// it as a bare id, or omitting the question entirely, would let the model
// believe it has material it does not have.
test('a question with no story says so rather than showing a broken id', () => {
  const block = jobBriefPromptBlock(brief())
  assert.match(block, /How do you handle conflicting priorities\?/)
  assert.match(block, /no story/i)
})

test('an empty brief produces no block at all', () => {
  assert.equal(jobBriefPromptBlock(brief({ likelyQuestions: [] })), '')
})

// This block rides on EVERY draft on the hot path. The generator allows up to
// 20 questions; an unbounded block is a latency regression on every answer of
// the interview, so both caps are pinned here.
test('the block is capped at the question limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    question: `Question number ${i} about something.`,
    storyId: `story-${i}`,
    competency: 'ownership' as const
  }))
  const block = jobBriefPromptBlock(brief({ likelyQuestions: many }))
  const rendered = block.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(rendered.length, JOB_BRIEF_QUESTION_LIMIT)
})

test('the block stays under its character ceiling', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    question: `${'A very long anticipated interview question. '.repeat(20)}${i}`,
    storyId: `story-${i}`,
    competency: 'ownership' as const
  }))
  const block = jobBriefPromptBlock(brief({ likelyQuestions: many }))
  assert.ok(
    block.length <= JOB_BRIEF_BLOCK_LIMIT,
    `block was ${block.length}, over the ${JOB_BRIEF_BLOCK_LIMIT} ceiling`
  )
})

// The mapping is a hint. Stated as a rule, a near-miss question drags in a
// story that does not fit, which is worse than answering from the profile.
test('the block says the mapping is a hint and forbids inventing ids', () => {
  const block = jobBriefPromptBlock(brief())
  assert.match(block, /hint/i)
  assert.match(block, /invent/i)
})
