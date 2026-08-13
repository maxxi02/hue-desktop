import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { registerHooks } from 'node:module'

/**
 * These tests run a throwaway relay on an ephemeral port rather than stubbing
 * fetch, because the bug being guarded against lives in the timing between real
 * requests: the point is what the *server* observes, in what order.
 */

// Application code is written for the bundler, which resolves extensionless
// sibling imports; Node's ESM loader does not. Rather than bend the source to
// suit the test runner, teach the loader the same rule, then import for real.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) {
      return next(`${specifier}.ts`, context)
    }
    return next(specifier, context)
  }
})

const { startRelay, stopRelay, publishRelayEvent } = await import('./relay-client.ts')

interface FakeRelay {
  /** Text of every event the server accepted, in arrival order. */
  arrivals: string[]
  baseUrl: string
  close: () => Promise<void>
}

/**
 * Starts a relay that answers the first event request slowly and with a 500, so
 * that event has to retry. Everything after it is answered immediately — which is
 * what gives an unserialized publisher the chance to overtake the retry.
 */
async function startFakeRelay(firstDelayMs: number, firstStatus: number): Promise<FakeRelay> {
  const arrivals: string[] = []
  let seen = 0

  const server: Server = createServer((req, res) => {
    if (req.url === '/v1/rooms' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          roomId: '0123456789abcdef',
          publishToken: 'b'.repeat(32),
          subscribeToken: 'a'.repeat(32)
        })
      )
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString()) as { text?: string }
      arrivals.push(parsed.text ?? '')
      const isFirst = seen++ === 0
      setTimeout(
        () => {
          res.writeHead(isFirst ? firstStatus : 200).end('{}')
        },
        isFirst ? firstDelayMs : 0
      )
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    arrivals,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

after(() => stopRelay())

test('a retrying event is never overtaken by the event published after it', async () => {
  const relay = await startFakeRelay(400, 500)
  try {
    const status = await startRelay(relay.baseUrl)
    assert.equal(
      status.running,
      true,
      `relay did not start (${status.error}) — needs a non-loopback IPv4 address`
    )

    publishRelayEvent({ type: 'answer', text: 'first' })
    publishRelayEvent({ type: 'answer', text: 'first and second' })

    // Long enough for the slow 500, the 200ms backoff, the retry, and any late
    // arrival an unserialized implementation would produce.
    await sleep(1500)

    assert.ok(relay.arrivals.length >= 2, `nothing arrived: ${JSON.stringify(relay.arrivals)}`)
    // Arrivals may repeat (the retry), but must never go backwards: seeing 'first'
    // again after 'first and second' is the phone rendering the shorter answer.
    let highest = -1
    for (const text of relay.arrivals) {
      const index = text === 'first' ? 0 : 1
      assert.ok(index >= highest, `events arrived out of order: ${JSON.stringify(relay.arrivals)}`)
      highest = index
    }
    assert.equal(
      relay.arrivals.at(-1),
      'first and second',
      `relay's last write was stale: ${JSON.stringify(relay.arrivals)}`
    )
  } finally {
    stopRelay()
    await relay.close()
  }
})

test('stopping the relay drops work still queued behind an in-flight publish', async () => {
  const relay = await startFakeRelay(400, 200)
  try {
    const status = await startRelay(relay.baseUrl)
    assert.equal(status.running, true, `relay did not start (${status.error})`)

    publishRelayEvent({ type: 'answer', text: 'first' })
    // Let the first event get as far as the wire before queueing behind it.
    await sleep(50)
    publishRelayEvent({ type: 'answer', text: 'first and second' })
    stopRelay()

    await sleep(1000)
    assert.deepEqual(relay.arrivals, ['first'])
  } finally {
    stopRelay()
    await relay.close()
  }
})

test('a burst of answer deltas collapses to what the network can carry, ending on the full text', async () => {
  // The first request is held for 300ms, which is the window a real answer's
  // deltas arrive in. Everything queued behind it is superseded before it can
  // leave, and the relay keeps only the last write — so sending them all would
  // be 200 round trips whose only observable effect is the final one.
  const relay = await startFakeRelay(300, 200)
  try {
    const status = await startRelay(relay.baseUrl)
    assert.equal(status.running, true, `relay did not start (${status.error})`)

    let text = ''
    for (let i = 0; i < 200; i++) {
      text += `token${i} `
      publishRelayEvent({ type: 'answer', text })
    }

    await sleep(1200)

    assert.ok(
      relay.arrivals.length <= 5,
      `the queue did not coalesce: ${relay.arrivals.length} requests for 200 deltas`
    )
    assert.equal(
      relay.arrivals.at(-1),
      text,
      `the phone was left on a partial answer: ${JSON.stringify(relay.arrivals.at(-1))}`
    )
  } finally {
    stopRelay()
    await relay.close()
  }
})

test('coalescing never drops an event of a different type, since those do not supersede each other', async () => {
  const relay = await startFakeRelay(200, 200)
  try {
    const status = await startRelay(relay.baseUrl)
    assert.equal(status.running, true, `relay did not start (${status.error})`)

    publishRelayEvent({ type: 'answer', text: 'holding the queue' })
    publishRelayEvent({ type: 'question', text: 'the question' })
    publishRelayEvent({ type: 'state', text: 'listening' })

    await sleep(1200)

    assert.ok(
      relay.arrivals.includes('the question'),
      `the question was dropped: ${JSON.stringify(relay.arrivals)}`
    )
    assert.ok(
      relay.arrivals.includes('listening'),
      `the state was dropped: ${JSON.stringify(relay.arrivals)}`
    )
  } finally {
    stopRelay()
    await relay.close()
  }
})
