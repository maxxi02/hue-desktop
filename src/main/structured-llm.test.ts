import test from 'node:test'
import assert from 'node:assert/strict'
import { baseUrlFor, providerFor, PROVIDER_BASE_URLS, MissingApiKey } from './structured-llm.ts'

test('every OpenAI-compatible provider the app offers has a base URL', () => {
  for (const p of ['google', 'groq', 'mistral', 'cohere'] as const) {
    assert.ok(PROVIDER_BASE_URLS[p], `${p} has no base URL`)
  }
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
