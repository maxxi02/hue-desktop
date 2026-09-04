import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENAI_COMPAT_PROVIDERS,
  chatModelsFor,
  isOpenAiCompatProvider,
  providerSupportsVision,
  sortModelIds
} from './openai-compat.ts'
import { OPENAI_BASE_URL, PROVIDER_BASE_URLS, baseUrlFor } from './structured-llm.ts'

/**
 * The provider list is written down in several places — the `OpenAiCompatProvider`
 * union, the PROVIDERS table that drives drafting, and PROVIDER_BASE_URLS that
 * drives ingest — and the compiler only catches two of the three. A provider
 * added to the union and the drafting table but forgotten in the ingest one
 * typechecks clean and then fails at upload time, which is the worst possible
 * moment to discover it.
 *
 * So these tests never list the providers themselves. They read each table's own
 * keys and hold the tables against each other: adding a provider to one place
 * and not the other is a red test rather than a support ticket.
 */

test('every provider in the drafting table has an ingest base URL, and vice versa', () => {
  const drafting = [...OPENAI_COMPAT_PROVIDERS].sort()
  const ingest = Object.keys(PROVIDER_BASE_URLS).sort()
  assert.deepEqual(
    drafting,
    ingest,
    'the drafting and ingest provider tables have drifted apart — a provider in ' +
      'one but not the other works until the user switches workload'
  )
})

test('no provider table entry is left blank', () => {
  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    const url = PROVIDER_BASE_URLS[provider]
    assert.ok(url, `${provider} has no base URL`)
    assert.match(url, /^https?:\/\//, `${provider}'s base URL is not a URL`)
    // `baseUrlFor` is what the client actually calls; an entry that exists in
    // the table but does not survive that lookup is no entry at all.
    assert.equal(baseUrlFor(provider, ''), url)
  }
})

test('the compat guard answers yes for every provider in the table', () => {
  // The guard used to be a hand-written `p === 'google' || ...` chain, and a
  // missing arm is invisible to the type checker — `false` is a valid answer.
  // It is what threw "called for non-compatible provider" mid-interview on a
  // provider the user had configured perfectly.
  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    assert.ok(isOpenAiCompatProvider(provider), `${provider} is in the table but the guard says no`)
  }
  assert.equal(isOpenAiCompatProvider('anthropic'), false)
  assert.equal(isOpenAiCompatProvider('ollama'), false)
  assert.equal(isOpenAiCompatProvider('nonesuch'), false)
})

test('DeepSeek is the one provider that cannot take a screen capture', () => {
  assert.equal(providerSupportsVision('deepseek'), false)
  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    if (provider === 'deepseek') continue
    assert.ok(providerSupportsVision(provider), `${provider} should accept an image`)
  }
  // Not in the table at all, so capable by default: Anthropic takes images and
  // Ollama's answer depends on the local model, which we cannot know from here.
  assert.equal(providerSupportsVision('anthropic'), true)
  assert.equal(providerSupportsVision('ollama'), true)
})

test('auto-pick lands on deepseek-v4-flash, not -pro', () => {
  // With no model configured, `resolveModel` takes the first of the listed
  // models. Ordering is therefore a product decision, not a display detail:
  // flash is cheaper and faster, and drafting happens on the hot path where a
  // second of latency costs more than a shade of answer quality.
  const listed = sortModelIds(['deepseek-v4-pro', 'deepseek-v4-flash'])
  assert.equal(listed[0], 'deepseek-v4-flash')
  // Retired 2026-07-24 — if either ever reappears in a listing, it must not be
  // able to sort ahead of a model that still exists.
  assert.ok(!listed.includes('deepseek-chat'))
  assert.ok(!listed.includes('deepseek-reasoner'))
})

test('sorting a model list does not mutate the caller’s array', () => {
  const original = ['b', 'a']
  sortModelIds(original)
  assert.deepEqual(original, ['b', 'a'])
})

test('OpenAI is wired into both provider tables', () => {
  // The two tables are cross-checked above, so this only has to assert that the
  // provider exists at all — but it asserts the URL too, because OpenAI is the
  // one provider whose base URL is also spelled out in `structured-llm-openai.ts`
  // as `OPENAI_BASE_URL`, and the two must not drift. They are deliberately not
  // the same binding: importing that const here reads it in its temporal dead
  // zone (the two modules are a cycle) and throws at import time.
  assert.ok(OPENAI_COMPAT_PROVIDERS.includes('openai'), 'openai is not in the drafting table')
  assert.equal(PROVIDER_BASE_URLS.openai, 'https://api.openai.com/v1')
  assert.equal(PROVIDER_BASE_URLS.openai, OPENAI_BASE_URL)
  assert.ok(isOpenAiCompatProvider('openai'))
  // GPT-4o and up take images, so a screen capture is allowed to reach it.
  assert.ok(providerSupportsVision('openai'))
})

test('OpenAI’s model listing is filtered down to models that can serve a chat', () => {
  // Every other provider lists chat models and little else, so the raw listing
  // is safe to sort and take the first of. OpenAI's is a catalogue: embeddings,
  // speech, images and legacy completions models share the endpoint. Sorted
  // alphabetically and unfiltered, auto-pick lands on `babbage-002` — a legacy
  // completions model that 400s on /chat/completions — and the user's first
  // question of the interview fails on a key that is perfectly good.
  const listed = chatModelsFor('openai', [
    'gpt-4o',
    'babbage-002',
    'dall-e-3',
    'whisper-1',
    'tts-1',
    'text-embedding-3-small',
    'gpt-4o-audio-preview',
    'gpt-4o-transcribe',
    'gpt-4o-realtime-preview',
    'gpt-4o-search-preview',
    'gpt-3.5-turbo-instruct',
    'omni-moderation-latest',
    'gpt-5',
    'o3-mini'
  ])
  assert.deepEqual(listed, ['gpt-4o', 'gpt-5', 'o3-mini'])
  // Reasoning models are chat models and must survive the filter.
  assert.ok(listed.includes('o3-mini'))
  // Sorted, like every other provider's listing.
  assert.deepEqual(listed, [...listed].sort())
})

test('a provider with no filter keeps its whole listing', () => {
  // The filter is opt-in per provider; the four that do not declare one must be
  // unaffected by its introduction.
  const ids = ['b-model', 'a-model']
  assert.deepEqual(chatModelsFor('groq', ids), ['a-model', 'b-model'])
})
