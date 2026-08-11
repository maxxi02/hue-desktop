import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_ENDPOINT_MESSAGE,
  accountRefusedMessage,
  isBlankBaseUrl,
  normalizeBaseUrl,
  unreachableMessage,
  uploadFailure
} from './ingest-errors.ts'

test('a trailing slash on the configured URL does not become a double slash in the path', () => {
  assert.equal(normalizeBaseUrl('http://localhost:8788/'), 'http://localhost:8788')
  assert.equal(normalizeBaseUrl('  http://localhost:8788///  '), 'http://localhost:8788')
})

test('a base URL of only whitespace counts as no endpoint at all', () => {
  assert.ok(isBlankBaseUrl('   '))
  assert.ok(isBlankBaseUrl('///'))
  assert.ok(!isBlankBaseUrl('http://localhost:8788'))
})

test('an unconfigured endpoint tells the user how to configure one instead of blaming the network', () => {
  assert.match(NO_ENDPOINT_MESSAGE, /résumé service URL/)
  assert.doesNotMatch(NO_ENDPOINT_MESSAGE, /connection/)
})

test('an unreachable endpoint names the URL that failed, so a wrong address is visible as the fault', () => {
  const message = unreachableMessage('https://ingest.example.invalid')
  assert.match(message, /https:\/\/ingest\.example\.invalid/)
  assert.match(message, /hue-ingest/)
})

test('a refused account mint reports the status the service actually returned', () => {
  assert.match(accountRefusedMessage('http://localhost:8788', 503), /HTTP 503/)
})

test('an oversized upload is refused permanently rather than offered for retry', () => {
  const failure = uploadFailure(413, null)
  assert.equal(failure.retryable, false)
  assert.match(failure.message, /10 MB/)
})

test('a bare 404 from the service is read as a dead account link, not as an unreadable resume', () => {
  for (const status of [401, 403, 404]) {
    const failure = uploadFailure(status, null)
    assert.equal(failure.retryable, true, `status ${status} should be retryable`)
    assert.match(failure.message, /no longer valid/)
    assert.doesNotMatch(failure.message, /couldn't be read/)
  }
})

test("an unreadable file keeps the service's own wording, which knows it was a scan", () => {
  const failure = uploadFailure(422, 'We only found a few words in that file.')
  assert.equal(failure.message, 'We only found a few words in that file.')
  assert.equal(failure.retryable, false)
})

test('an unreadable file with no explanation from the service still says something concrete', () => {
  const failure = uploadFailure(422, null)
  assert.match(failure.message, /couldn't be read as a resume/)
  assert.equal(failure.retryable, false)
})
