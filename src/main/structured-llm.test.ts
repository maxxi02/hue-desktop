import test from 'node:test'
import assert from 'node:assert/strict'
import {
  baseUrlFor,
  providerFor,
  PROVIDER_BASE_URLS,
  MissingApiKey,
  ProviderError,
  quotaMessage
} from './structured-llm.ts'

test('every OpenAI-compatible provider the app offers has a base URL', () => {
  for (const p of ['google', 'groq', 'mistral', 'cohere', 'deepseek'] as const) {
    assert.ok(PROVIDER_BASE_URLS[p], `${p} has no base URL`)
  }
})

test('DeepSeek is addressed at the root — a /v1 suffix would 404 every request', () => {
  assert.equal(baseUrlFor('deepseek', ''), 'https://api.deepseek.com')
})

test('a 402 reads as an empty balance, not as a too-big document or a wait', () => {
  const message = quotaMessage(new ProviderError(402, 'Insufficient Balance'))
  assert.ok(message, '402 must produce advice of its own')
  assert.match(message, /balance/i)
  assert.match(message, /deepseek\.com/)
  // The two things a user must not be told to do: shrink the résumé, or wait.
  assert.doesNotMatch(message, /too (big|large)/i)
  assert.doesNotMatch(message, /try again shortly/i)
})

test('ollama resolves against the configured host, not a hardcoded one', () => {
  assert.equal(baseUrlFor('ollama', 'http://192.168.1.5:11434'), 'http://192.168.1.5:11434/v1')
})

test('a trailing slash on the ollama host does not produce a doubled path', () => {
  assert.equal(baseUrlFor('ollama', 'http://localhost:11434/'), 'http://localhost:11434/v1')
})

test('an empty ollama host falls back to the local default', () => {
  assert.equal(baseUrlFor('ollama', ''), 'http://localhost:11434/v1')
})

test('drafting always uses the drafting provider, whatever ingest is set to', () => {
  assert.equal(providerFor('drafting', 'groq', 'google'), 'groq')
})

test('ingest uses its own provider when one is set — Groq free cannot run ingest', () => {
  assert.equal(providerFor('ingest', 'groq', 'google'), 'google')
})

test('an unset ingest provider means "same as drafting", the default for everyone but Groq', () => {
  assert.equal(providerFor('ingest', 'anthropic', ''), 'anthropic')
})

test('MissingApiKey names the provider and points at Settings, not at the network', () => {
  const err = new MissingApiKey('Anthropic')
  assert.equal(err.provider, 'Anthropic')
  assert.match(err.message, /Settings/)
})
