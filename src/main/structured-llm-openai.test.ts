import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LlmRefusal, openAiCompatClient } from './structured-llm.ts'
import type { StructuredRequest } from './structured-llm.ts'

/**
 * These tests stand up a real HTTP server on an ephemeral port rather than
 * stubbing `fetch`. The behaviour under test *is* the wire contract — status
 * codes, `finish_reason`, `response_format` echoed back — and a stub would let
 * a change in how the request is built pass unnoticed, which is the only class
 * of bug this file exists to catch.
 */

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string' } }
}

const REQUEST: StructuredRequest = {
  label: 'profile extraction',
  system: 'You extract things.',
  user: 'Resume text.',
  schema: SCHEMA
}

interface Recorded {
  body: Record<string, unknown>
}

/** One scripted response per call, in order. */
type Reply =
  | { status: 200; json: unknown }
  | { status: number; body: string; headers?: Record<string, string> }

let open: Server | null = null

afterEach(() => {
  open?.close()
  open = null
})

async function fakeProvider(
  replies: Reply[]
): Promise<{ calls: Recorded[]; baseUrl: string; path: (i: number) => unknown }> {
  const calls: Recorded[] = []
  let next = 0

  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      calls.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      const reply = replies[Math.min(next++, replies.length - 1)]
      if (reply.status === 200 && 'json' in reply) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.json))
        return
      }
      const failure = reply as { status: number; body: string; headers?: Record<string, string> }
      res
        .writeHead(failure.status, { 'Content-Type': 'application/json', ...failure.headers })
        .end(failure.body)
    })
  })
  open = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    calls,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    path: (i: number) => calls[i].body
  }
}

/** An OpenAI-format completion carrying `content` and a finish reason. */
function completion(content: string, finishReason = 'stop'): unknown {
  return { choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }] }
}

function client(baseUrl: string, overrides: Record<string, unknown> = {}): LlmClient {
  return openAiCompatClient({
    apiKey: 'test-key',
    baseUrl,
    model: 'test-model',
    // Backoff is proven by the retry happening, not by the wall clock.
    retryBaseMs: 1,
    timeoutMs: 5000,
    ...overrides
  })
}

test('a valid structured response comes back parsed, with the schema sent strictly', async () => {
  const provider = await fakeProvider([
    { status: 200, json: completion('{"name":"Jordan Reyes"}') }
  ])

  const result = await client(provider.baseUrl).structured<{ name: string }>(REQUEST)
  assert.deepEqual(result, { name: 'Jordan Reyes' })

  const sent = provider.path(0) as {
    model: string
    messages: { role: string; content: string }[]
    response_format: {
      type: string
      json_schema: { name: string; schema: unknown; strict: boolean }
    }
  }
  assert.equal(sent.model, 'test-model')
  assert.equal(sent.response_format.type, 'json_schema')
  assert.equal(sent.response_format.json_schema.strict, true)
  assert.equal(sent.response_format.json_schema.name, 'profile_extraction')
  assert.deepEqual(sent.response_format.json_schema.schema, SCHEMA)
  // In strict mode the schema is enforced, so it must not also bloat the prompt.
  assert.equal(sent.messages[0].content, REQUEST.system)
  assert.equal(sent.messages[1].content, REQUEST.user)
})

test('a provider that rejects json_schema is downgraded once and the downgrade sticks', async () => {
  const provider = await fakeProvider([
    {
      status: 400,
      body: JSON.stringify({
        error: { message: "response_format.type 'json_schema' is not supported by this model" }
      })
    },
    { status: 200, json: completion('{"name":"first"}') },
    { status: 200, json: completion('{"name":"second"}') }
  ])

  const llm = client(provider.baseUrl)
  assert.deepEqual(await llm.structured<{ name: string }>(REQUEST), { name: 'first' })
  assert.deepEqual(await llm.structured<{ name: string }>(REQUEST), { name: 'second' })

  // Three calls, not four: the second `structured()` must not re-negotiate.
  assert.equal(provider.calls.length, 3)
  const modes = provider.calls.map((c) => (c.body.response_format as { type: string }).type)
  assert.deepEqual(modes, ['json_schema', 'json_object', 'json_object'])

  // json_object enforces nothing, so the schema has to travel as a prompt contract.
  const downgraded = provider.path(2) as { messages: { content: string }[] }
  assert.match(downgraded.messages[0].content, /^You extract things\./)
  assert.ok(downgraded.messages[0].content.includes('"additionalProperties":false'))
  assert.match(downgraded.messages[0].content, /JSON Schema/)
})

test('a truncated response is a refusal, not a half-extracted profile', async () => {
  const provider = await fakeProvider([
    { status: 200, json: completion('{"name":"Jordan Rey', 'length') }
  ])

  await assert.rejects(
    () => client(provider.baseUrl).structured(REQUEST),
    (err: unknown) => {
      assert.ok(err instanceof LlmRefusal)
      assert.equal(err.label, 'profile extraction')
      assert.match(err.message, /output budget/)
      return true
    }
  )
})

test('output that is not JSON is a refusal rather than a crash downstream', async () => {
  const provider = await fakeProvider([
    { status: 200, json: completion('Sure! Here is the profile you asked for.') }
  ])

  await assert.rejects(
    () => client(provider.baseUrl).structured(REQUEST),
    (err: unknown) => err instanceof LlmRefusal && /not JSON/.test(err.message)
  )
})

test('a refusal from the model surfaces as LlmRefusal, not as a parse failure', async () => {
  const provider = await fakeProvider([
    {
      status: 200,
      json: {
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' }
          }
        ]
      }
    }
  ])

  await assert.rejects(
    () => client(provider.baseUrl).structured(REQUEST),
    (err: unknown) => err instanceof LlmRefusal && /declined/.test(err.message)
  )
})

test('a 429 is retried rather than failing the ingest', async () => {
  const provider = await fakeProvider([
    {
      status: 429,
      body: '{"error":{"message":"rate limit reached"}}',
      headers: { 'retry-after': '0' }
    },
    { status: 200, json: completion('{"name":"Jordan Reyes"}') }
  ])

  assert.deepEqual(await client(provider.baseUrl).structured<{ name: string }>(REQUEST), {
    name: 'Jordan Reyes'
  })
  assert.equal(provider.calls.length, 2)
})

test('a 401 is not retried — the key will not fix itself', async () => {
  const provider = await fakeProvider([
    { status: 401, body: '{"error":{"message":"invalid api key"}}' }
  ])

  await assert.rejects(() => client(provider.baseUrl).structured(REQUEST), /401/)
  assert.equal(provider.calls.length, 1)
})

test('a fenced JSON body is recovered, since a fence is formatting rather than refusal', async () => {
  const provider = await fakeProvider([
    { status: 200, json: completion('```json\n{"name":"Jordan Reyes"}\n```') }
  ])

  assert.deepEqual(
    await client(provider.baseUrl, { strictSchema: false }).structured<{ name: string }>(REQUEST),
    { name: 'Jordan Reyes' }
  )
})

test('a provider out of capacity says so, rather than blaming the output', async () => {
  // DeepSeek ends a stream with this `finish_reason` when its own capacity runs
  // out. It arrives as a 200 with nothing usable in it, so before this branch
  // existed it fell through to "returned output that was not JSON" — sending
  // the user to inspect a document that was never the problem, when the fix is
  // to press upload again.
  const provider = await fakeProvider([
    { status: 200, json: completion('', 'insufficient_system_resource') }
  ])

  await assert.rejects(
    () => client(provider.baseUrl).structured(REQUEST),
    (err: unknown) => {
      assert.ok(err instanceof LlmRefusal)
      assert.equal(err.category, 'insufficient_system_resource')
      assert.match(err.message, /capacity/i)
      assert.doesNotMatch(err.message, /not JSON/)
      return true
    }
  )
})

test('extraBody reaches the request body, which is how DeepSeek gets thinking off', async () => {
  const provider = await fakeProvider([{ status: 200, json: completion('{"name":"Jordan"}') }])

  await client(provider.baseUrl, {
    strictSchema: false,
    extraBody: { thinking: { type: 'disabled' } }
  }).structured(REQUEST)

  const sent = provider.path(0) as { thinking?: unknown; temperature?: number }
  assert.deepEqual(sent.thinking, { type: 'disabled' })
  // Both halves matter together: ingest asks for temperature 0 so two runs of
  // one résumé hash the same, and DeepSeek silently ignores temperature while
  // thinking is on. Sending the toggle is what makes the zero mean anything.
  assert.equal(sent.temperature, 0)
})

test('extraBody wins over a default it collides with, rather than being dropped', async () => {
  const provider = await fakeProvider([{ status: 200, json: completion('{"name":"Jordan"}') }])

  await client(provider.baseUrl, { extraBody: { temperature: 0.7 } }).structured(REQUEST)

  assert.equal((provider.path(0) as { temperature: number }).temperature, 0.7)
})

test('the timeout budgets the whole call, not each attempt', async () => {
  // Two 429s in a row, each asking for a long wait. With a per-attempt timeout
  // this would retry happily; with an overall deadline it must give up inside
  // the budget rather than multiplying it by the retry count.
  const provider = await fakeProvider([
    { status: 429, body: '{"error":"slow down"}', headers: { 'retry-after': '5' } },
    { status: 429, body: '{"error":"slow down"}', headers: { 'retry-after': '5' } },
    { status: 429, body: '{"error":"slow down"}', headers: { 'retry-after': '5' } }
  ])
  const started = Date.now()
  await assert.rejects(() =>
    client(provider.baseUrl, { timeoutMs: 600, retryBaseMs: 1 }).structured({
      label: 'budget',
      system: 's',
      user: 'u',
      schema: { type: 'object', additionalProperties: false, properties: {} }
    })
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, `gave up after ${elapsed}ms, which is past the whole-call budget`)
})
