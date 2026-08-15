import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createStallGuard,
  fetchWithRetry,
  isRetryableStatus,
  ProviderHttpError,
  retryDelayMs
} from './stream-resilience.ts'

// A fetch stand-in that replays a scripted sequence of outcomes and records how
// many times it was called, which is the thing every retry test is really about.
function scriptedFetch(steps: Array<Response | Error>): {
  impl: typeof fetch
  calls: () => number
} {
  let i = 0
  const impl = (async () => {
    const step = steps[Math.min(i, steps.length - 1)]
    i++
    if (step instanceof Error) throw step
    return step
  }) as unknown as typeof fetch
  return { impl, calls: () => i }
}

const ok = (): Response => new Response('fine', { status: 200 })
const status = (code: number, headers?: Record<string, string>): Response =>
  new Response('nope', { status: code, headers })

const noSleep = async (): Promise<void> => {}
const live = new AbortController().signal

test('a rate limit is retried rather than killing the answer outright', async () => {
  const f = scriptedFetch([status(429), ok()])
  const res = await fetchWithRetry('https://x/y', {}, 'groq', {
    signal: live,
    fetchImpl: f.impl,
    sleep: noSleep
  })
  assert.equal(res.status, 200)
  assert.equal(f.calls(), 2)
})

test('a transient 503 is retried, because the provider being busy is not the user being wrong', async () => {
  const f = scriptedFetch([status(503), status(502), ok()])
  const res = await fetchWithRetry('https://x/y', {}, 'groq', {
    signal: live,
    fetchImpl: f.impl,
    sleep: noSleep
  })
  assert.equal(res.status, 200)
  assert.equal(f.calls(), 3)
})

test('a bad API key fails on the first try, since retrying 401 only burns the turn', async () => {
  const f = scriptedFetch([status(401)])
  await assert.rejects(
    () =>
      fetchWithRetry('https://x/y', {}, 'groq', {
        signal: live,
        fetchImpl: f.impl,
        sleep: noSleep
      }),
    /groq error 401/
  )
  assert.equal(f.calls(), 1)
})

test('retries are capped, so a provider that is down does not stall the whole question', async () => {
  const f = scriptedFetch([status(429)])
  await assert.rejects(
    () =>
      fetchWithRetry('https://x/y', {}, 'groq', {
        signal: live,
        fetchImpl: f.impl,
        sleep: noSleep,
        maxAttempts: 3
      }),
    /groq error 429/
  )
  assert.equal(f.calls(), 3)
})

test('a dropped connection is retried, which is the common case on conference wifi', async () => {
  const f = scriptedFetch([new Error('fetch failed'), ok()])
  const res = await fetchWithRetry('https://x/y', {}, 'groq', {
    signal: live,
    fetchImpl: f.impl,
    sleep: noSleep
  })
  assert.equal(res.status, 200)
  assert.equal(f.calls(), 2)
})

test('the error surfaced carries the provider detail, not a generic failure', async () => {
  const f = scriptedFetch([new Response('model_decommissioned', { status: 400 })])
  await assert.rejects(
    () =>
      fetchWithRetry('https://x/y', {}, 'groq', {
        signal: live,
        fetchImpl: f.impl,
        sleep: noSleep
      }),
    /model_decommissioned/
  )
})

test('a user cancel stops the retry loop instead of racing on in the background', async () => {
  const controller = new AbortController()
  const f = scriptedFetch([status(429), ok()])
  const attempt = fetchWithRetry('https://x/y', {}, 'groq', {
    signal: controller.signal,
    fetchImpl: f.impl,
    sleep: async () => controller.abort()
  })
  await assert.rejects(attempt, (e: Error) => e.name === 'AbortError')
})

test('a cancel that lands before the first attempt fires no request at all', async () => {
  const controller = new AbortController()
  controller.abort()
  const f = scriptedFetch([ok()])
  await assert.rejects(
    () =>
      fetchWithRetry('https://x/y', {}, 'groq', {
        signal: controller.signal,
        fetchImpl: f.impl,
        sleep: noSleep
      }),
    (e: Error) => e.name === 'AbortError'
  )
  assert.equal(f.calls(), 0)
})

test('backoff grows per attempt so a burst is not answered with another burst', () => {
  assert.equal(retryDelayMs(1, null), 400)
  assert.equal(retryDelayMs(2, null), 800)
  assert.equal(retryDelayMs(3, null), 1600)
})

test('backoff is capped, because a long wait mid-interview is a hang to the user', () => {
  assert.equal(retryDelayMs(9, null), 2000)
})

test("a provider's Retry-After is honoured when it is short enough to be worth waiting", () => {
  assert.equal(retryDelayMs(1, '1'), 1000)
})

test('an absurd Retry-After is clamped rather than obeyed, since 60s is a lost question', () => {
  assert.equal(retryDelayMs(1, '60'), 2000)
})

test('a malformed Retry-After falls back to plain backoff instead of NaN', () => {
  assert.equal(retryDelayMs(1, 'Wed, 21 Oct 2015 07:28:00 GMT'), 400)
  assert.equal(retryDelayMs(1, '-5'), 400)
})

test('only genuinely transient statuses are retried', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(s), true, `${s} should be retryable`)
  }
  for (const s of [400, 401, 403, 404, 413, 422]) {
    assert.equal(isRetryableStatus(s), false, `${s} should not be retryable`)
  }
})

test('a stream that goes silent trips the guard, turning an infinite hang into an error', async () => {
  let stalled = false
  const guard = createStallGuard(() => {
    stalled = true
  }, 20)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(stalled, true)
  guard.clear()
})

test('a stream that keeps delivering never trips the guard', async () => {
  let stalled = false
  const guard = createStallGuard(() => {
    stalled = true
  }, 50)
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20))
    guard.beat()
  }
  assert.equal(stalled, false)
  guard.clear()
})

test('a cleared guard never fires, so a finished stream cannot abort a later one', async () => {
  let stalled = false
  const guard = createStallGuard(() => {
    stalled = true
  }, 20)
  guard.clear()
  guard.beat()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(stalled, false)
})

/**
 * A 429 is the single most informative response the app ever gets about quota —
 * it arrives with the vendor's own rate-limit headers attached — and it used to
 * be the one response that threw them away, collapsing into a plain Error whose
 * only content was a string. The usage panel exists to answer "am I near a
 * limit", so the moment the answer is definitively "yes" must not be the moment
 * the evidence is destroyed.
 */
test('a rate-limited response throws an error that still carries its headers', async () => {
  const f = scriptedFetch([
    status(429, { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '30s' })
  ])
  await assert.rejects(
    () =>
      fetchWithRetry('https://x/y', {}, 'groq', {
        signal: live,
        fetchImpl: f.impl,
        sleep: noSleep,
        maxAttempts: 1
      }),
    (e: Error) => {
      const http = e as ProviderHttpError
      assert.equal(http.status, 429)
      assert.equal(http.headers?.get('x-ratelimit-remaining-tokens'), '0')
      return true
    }
  )
})

test('the error message is unchanged, because it is what the user is shown', async () => {
  const f = scriptedFetch([status(401)])
  await assert.rejects(
    () =>
      fetchWithRetry('https://x/y', {}, 'groq', {
        signal: live,
        fetchImpl: f.impl,
        sleep: noSleep
      }),
    /groq error 401/
  )
})

test('a transport failure has no status or headers to carry, and does not pretend to', async () => {
  // DNS failure, connection refused. There is no response, so anything other
  // than the original error here would be invented.
  const f = scriptedFetch([new Error('getaddrinfo ENOTFOUND')])
  await assert.rejects(
    () =>
      fetchWithRetry('https://x/y', {}, 'groq', {
        signal: live,
        fetchImpl: f.impl,
        sleep: noSleep,
        maxAttempts: 1
      }),
    (e: Error) => !(e instanceof ProviderHttpError)
  )
})
