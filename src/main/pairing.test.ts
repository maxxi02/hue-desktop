import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodePairingUri, decodePairingUri } from './pairing.ts'

const sample = {
  relayBaseUrl: 'https://relay.hue.app',
  roomId: '0123456789abcdef',
  subscribeToken: 'a'.repeat(32)
}

test('encode produces the hue://pair scheme with all three params', () => {
  const uri = encodePairingUri(sample)
  assert.ok(uri.startsWith('hue://pair?'))
  assert.ok(uri.includes(`r=${sample.roomId}`))
  assert.ok(uri.includes(`t=${sample.subscribeToken}`))
  assert.ok(uri.includes('u=https%3A%2F%2Frelay.hue.app'))
})

test('decode round-trips an encoded pairing', () => {
  assert.deepEqual(decodePairingUri(encodePairingUri(sample)), sample)
})

test('decode round-trips a relay URL with a port and path', () => {
  const p = { ...sample, relayBaseUrl: 'http://192.168.1.20:8787/relay' }
  assert.deepEqual(decodePairingUri(encodePairingUri(p)), p)
})

test('decode rejects a foreign scheme', () => {
  assert.equal(decodePairingUri('https://evil.example/pair?u=x&r=y&t=z'), null)
})

test('decode rejects a missing parameter', () => {
  assert.equal(decodePairingUri(`hue://pair?u=https%3A%2F%2Fx&r=${sample.roomId}`), null)
})

test('decode rejects a malformed room id', () => {
  assert.equal(
    decodePairingUri(`hue://pair?u=https%3A%2F%2Fx&r=NOTHEX&t=${sample.subscribeToken}`),
    null
  )
})

test('decode rejects a malformed token', () => {
  assert.equal(decodePairingUri(`hue://pair?u=https%3A%2F%2Fx&r=${sample.roomId}&t=short`), null)
})

test('decode rejects a non-http relay URL', () => {
  assert.equal(
    decodePairingUri(
      `hue://pair?u=file%3A%2F%2F%2Fetc%2Fpasswd&r=${sample.roomId}&t=${sample.subscribeToken}`
    ),
    null
  )
})

test('decode rejects junk', () => {
  assert.equal(decodePairingUri('not a uri at all'), null)
})
