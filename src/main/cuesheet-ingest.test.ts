// src/main/cuesheet-ingest.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { segment, parseCards } from './cuesheet-ingest.ts'

test('splits on markdown headings', () => {
  const out = segment('# Intro\nHello there.\n\n## Why support\nBecause reasons.')
  assert.deepEqual(out.map((s) => s.heading), ['Intro', 'Why support'])
  assert.equal(out[1].body.trim(), 'Because reasons.')
})

test('falls back to Q: lines when there are no headings', () => {
  const out = segment('Q: Tell me about yourself\nI am a developer.\n\nQ: Why us\nBecause reasons.')
  assert.deepEqual(out.map((s) => s.heading), ['Tell me about yourself', 'Why us'])
})

test('a document with neither yields a single unsegmented section', () => {
  const out = segment('Just one long blob of prepared notes with no structure at all.')
  assert.equal(out.length, 1)
  assert.equal(out[0].heading, '')
})

test('parseCards tolerates a model that wraps JSON in prose or fences', () => {
  const raw = 'Here you go:\n```json\n[{"id":"c1","heading":"h","cues":["a"],"script":"s","triggers":["t"]}]\n```\nHope that helps.'
  assert.deepEqual(parseCards(raw).map((c) => c.id), ['c1'])
})

test('parseCards returns empty rather than throwing on unusable output', () => {
  assert.deepEqual(parseCards('I was unable to complete that request.'), [])
})
