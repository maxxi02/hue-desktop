import Anthropic from '@anthropic-ai/sdk'
import type { WebContents } from 'electron'
import { getSettings } from './settings'
import { record } from './usage-store'
import { parseRateLimitHeaders } from '../shared/usage'
import type { LlmMessage, LlmStreamRequest } from '../shared/types'

/** Block types this app actually sends; both accept cache_control. */
type SentBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam

/**
 * Translate our provider-neutral messages into Anthropic's content-block shape.
 * The final block of the final message carries a cache breakpoint so the whole
 * prefix (system prompt + every prior turn) is served from cache on the next
 * turn — each request then pays full input price only for what was appended
 * since the last one. Earlier breakpoints stay valid, so hits accrue as the
 * conversation grows. Below the model's minimum cacheable prefix the marker is
 * a silent no-op, so short conversations lose nothing.
 */
function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m, i) => {
    const blocks: SentBlock[] =
      typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content.map((b) =>
            b.type === 'text'
              ? ({ type: 'text', text: b.text } as const)
              : ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: b.mediaType,
                    data: b.dataBase64
                  }
                } as const)
          )
    if (i === messages.length - 1 && blocks.length > 0) {
      blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }
    }
    return { role: m.role, content: blocks }
  })
}

let client: Anthropic | null = null
let clientKey = ''

function getClient(): Anthropic {
  const { anthropicApiKey } = getSettings()
  if (!anthropicApiKey) {
    throw new Error('No Anthropic API key configured. Add one in Settings.')
  }
  if (!client || clientKey !== anthropicApiKey) {
    client = new Anthropic({ apiKey: anthropicApiKey })
    clientKey = anthropicApiKey
  }
  return client
}

interface ActiveStream {
  abort: () => void
}
const active = new Map<string, ActiveStream>()

export function startLlmStream(sender: WebContents, streamId: string, req: LlmStreamRequest): void {
  const send = (channel: string, payload: unknown): void => {
    if (!sender.isDestroyed()) sender.send(channel, payload)
  }

  let finished = false
  const finishDone = (aborted: boolean): void => {
    if (finished) return
    finished = true
    active.delete(streamId)
    send('hue:llm:done', { streamId, aborted })
  }
  const finishError = (message: string): void => {
    if (finished) return
    finished = true
    active.delete(streamId)
    send('hue:llm:error', { streamId, message })
  }

  try {
    const anthropic = getClient()
    const { model } = getSettings()
    const aborter = new AbortController()
    active.set(streamId, { abort: () => aborter.abort() })

    const stream = anthropic.messages.stream(
      {
        model,
        max_tokens: req.maxTokens ?? 300,
        // Cache breakpoint on the system prompt: it's deterministic for the
        // whole session (built once per turn from the same settings), so after
        // the first turn it's read from cache instead of re-processed at full
        // price. A second breakpoint rides on the last message block (see
        // toAnthropicMessages) to cache the growing conversation incrementally.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: toAnthropicMessages(req.messages)
      },
      { signal: aborter.signal }
    )

    stream.on('text', (delta) => send('hue:llm:delta', { streamId, text: delta }))
    stream.on('end', () => {
      // Token counts only, never headroom: `messages.stream()` hands back an
      // SDK stream rather than an HTTP response, so `anthropic-ratelimit-*`
      // never reaches this code. Getting it would mean hand-driving the stream
      // off `.withResponse()`, on the most latency-sensitive path in the app —
      // not worth it for a number the panel can show a dash for. A 429 still
      // reports headroom, because the SDK's error carries its headers.
      try {
        const usage = stream.receivedMessages[0]?.usage
        if (usage) {
          record({
            at: Date.now(),
            kind: 'llm',
            provider: 'anthropic',
            model,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined
          })
        }
      } catch (e) {
        console.error('anthropic usage not recorded:', e)
      }
      finishDone(false)
    })
    stream.on('abort', () => finishDone(true))
    stream.on('error', (err: unknown) => {
      const e = err as { name?: string; message?: string; headers?: Headers; status?: number }
      if (e?.name === 'APIUserAbortError' || aborter.signal.aborted) {
        finishDone(true)
        return
      }
      // The one path where Anthropic headroom is reachable: SDK errors carry
      // the response headers the success path hides. A 429 here is also the
      // moment the number matters most.
      try {
        if (e?.headers) {
          const limit = parseRateLimitHeaders('anthropic', e.headers, Date.now())
          if (limit) record({ at: Date.now(), kind: 'llm', provider: 'anthropic', model, limit })
        }
      } catch {
        // Never let usage accounting turn a reportable error into a silent one.
      }
      finishError(e?.message ?? String(err))
    })
  } catch (err) {
    finishError(err instanceof Error ? err.message : String(err))
  }
}

export function abortLlmStream(streamId: string): void {
  active.get(streamId)?.abort()
}

/**
 * A single request/response call, for work that is not a live turn.
 *
 * `startLlmStream` pushes deltas at a `WebContents` because the voice pipeline
 * renders as it goes. Ingest has no renderer to stream to and no latency
 * budget to defend — it runs once per upload, behind a progress bar — so it
 * gets the simpler shape rather than a fake stream it would only reassemble.
 */
export async function completeOnce(req: {
  system: string
  prompt: string
  model: string
  maxTokens: number
}): Promise<string> {
  const message = await getClient().messages.create({
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: req.prompt }] }]
  })
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
