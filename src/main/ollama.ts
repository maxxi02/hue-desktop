import type { WebContents } from 'electron'
import { getSettings } from './settings'
import type { LlmStreamRequest } from '../shared/types'

interface ActiveStream {
  abort: () => void
}
const active = new Map<string, ActiveStream>()

function normalizeBaseUrl(url: string): string {
  return (url || 'http://localhost:11434').replace(/\/$/, '')
}

/** List the models installed on the Ollama server, for the Settings dropdown. */
export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: { name: string }[] }
    return (data.models ?? []).map((m) => m.name).filter(Boolean)
  } catch {
    return []
  }
}

// Make sure we send a model that's actually installed. Prevents a 404 when the
// configured model is stale or the tag differs (e.g. "llama3.2" vs the installed
// "llama3.2:latest").
async function resolveModel(baseUrl: string, requested: string): Promise<string> {
  const installed = await fetchOllamaModels(baseUrl)
  if (installed.length === 0) return requested // server unreachable — let the chat call surface the real error
  if (installed.includes(requested)) return requested
  const base = requested.split(':')[0]
  return installed.find((m) => m.split(':')[0] === base) ?? installed[0]
}

export function startOllamaStream(
  sender: WebContents,
  streamId: string,
  req: LlmStreamRequest
): void {
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

  const aborter = new AbortController()
  active.set(streamId, { abort: () => aborter.abort() })

  void (async () => {
    try {
      const { ollamaBaseUrl, ollamaModel } = getSettings()
      const baseUrl = normalizeBaseUrl(ollamaBaseUrl)
      const model = await resolveModel(baseUrl, ollamaModel)

      // Ollama takes the system prompt as a leading system-role message.
      const messages = [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...req.messages.map((m) => ({ role: m.role, content: m.content }))
      ]

      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          options: { num_predict: req.maxTokens ?? 300 }
        }),
        signal: aborter.signal
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Ollama error ${response.status}: ${detail || response.statusText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body from Ollama')

      const decoder = new TextDecoder()
      let buffer = ''

      // Ollama streams newline-delimited JSON, not SSE.
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let event: { message?: { content?: string }; done?: boolean }
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event.message?.content) send('hue:llm:delta', { streamId, text: event.message.content })
          if (event.done) {
            finishDone(false)
            return
          }
        }
      }
      finishDone(false)
    } catch (err) {
      const e = err as { name?: string; message?: string }
      if (e?.name === 'AbortError' || aborter.signal.aborted) {
        finishDone(true)
        return
      }
      finishError(e?.message ?? String(err))
    }
  })()
}

export function abortOllamaStream(streamId: string): void {
  active.get(streamId)?.abort()
}
