import test from 'node:test'
import assert from 'node:assert/strict'
import { ASR_LANGUAGE, languageEntriesFor } from './asr-language.ts'
import type { CloudAsrProvider } from './types.ts'

/**
 * The bug this pins.
 *
 * Groq's `whisper-large-v3-turbo` is the multilingual Whisper, and with no
 * `language` field it runs language auto-detection independently on every clip.
 * A short or noisy utterance misdetects, and Whisper then transcribes *into* the
 * language it thinks it heard: a live interview question came back as Indonesian
 * on screen, and Chinese on other occasions.
 *
 * The on-device tier never had this problem because `whisper-base.en` is
 * English-only and has no other language to reach for. These tests hold the
 * cloud tier to the same guarantee the model file gives the local one.
 */

// Every provider, read from the union rather than listed here, so a fourth one
// cannot be added with its language left to auto-detect. Same reasoning as
// provider-tables.test.ts: the compiler does not catch a table that fell behind.
const ALL_PROVIDERS: CloudAsrProvider[] = ['deepgram', 'assemblyai', 'groq']

test('every cloud ASR provider pins a language', () => {
  for (const provider of ALL_PROVIDERS) {
    const entries = languageEntriesFor(provider)
    assert.ok(entries.length > 0, `${provider} sends no language field`)
    for (const [, value] of entries) {
      assert.equal(value, ASR_LANGUAGE, `${provider} pins the wrong language`)
    }
  }
})

// Each provider spells the field differently, and sending Deepgram's spelling to
// AssemblyAI is the same as sending nothing: the API ignores an unknown field
// and quietly falls back to detection.
test('each provider gets the field name its own API expects', () => {
  assert.deepEqual(languageEntriesFor('deepgram'), [['language', 'en']])
  assert.deepEqual(languageEntriesFor('groq'), [['language', 'en']])
  assert.deepEqual(languageEntriesFor('assemblyai'), [['language_code', 'en']])
})

// English, matching the on-device model. If this ever becomes configurable, it
// has to change in one place rather than three.
test('the pinned language is English', () => {
  assert.equal(ASR_LANGUAGE, 'en')
})
