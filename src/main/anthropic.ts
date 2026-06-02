import Anthropic from '@anthropic-ai/sdk'
import type { WebContents } from 'electron'
import { getSettings } from './settings'
import type { LlmMessage, LlmStreamRequest } from '../shared/types'

/** Translate our provider-neutral messages into Anthropic's content-block shape. */
function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) =>
            b.type === 'text'
              ? { type: 'text' as const, text: b.text }
              : {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: b.mediaType,
                    data: b.dataBase64
                  }
                }
          )
  }))
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
        system: req.system,
        messages: toAnthropicMessages(req.messages)
      },
      { signal: aborter.signal }
    )

    stream.on('text', (delta) => send('hue:llm:delta', { streamId, text: delta }))
    stream.on('end', () => finishDone(false))
    stream.on('abort', () => finishDone(true))
    stream.on('error', (err: unknown) => {
      const e = err as { name?: string; message?: string }
      if (e?.name === 'APIUserAbortError' || aborter.signal.aborted) {
        finishDone(true)
        return
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
