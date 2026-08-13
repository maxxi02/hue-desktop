import type { WebContents } from 'electron'
import { getSettings } from './settings'
import { createStallGuard, fetchWithRetry } from './stream-resilience'
import type {
  HueSettings,
  LlmMessage,
  LlmStreamRequest,
  OpenAiCompatProvider
} from '../shared/types'

/**
 * OpenAI-format message content: a bare string, or (for multimodal turns) an
 * array of text / image_url parts. Images ride as base64 data URIs.
 */
type OpenAiContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

function toOpenAiContent(content: LlmMessage['content']): OpenAiContent {
  if (typeof content === 'string') return content
  return content.map((b) =>
    b.type === 'text'
      ? { type: 'text' as const, text: b.text }
      : {
          type: 'image_url' as const,
          image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` }
        }
  )
}

/**
 * Google Gemini, Groq, Mistral and Cohere all expose an OpenAI-compatible
 * surface (Bearer-auth, POST /chat/completions with SSE streaming, GET /models).
 * They differ only by base URL and which settings key holds the credential, so
 * one client serves all four. No vendor SDKs needed — plain fetch, like ollama.
 */
interface ProviderConfig {
  baseUrl: string
  /** Which HueSettings field holds this provider's API key. */
  keyField: keyof HueSettings
  /** Which HueSettings field holds the selected model. */
  modelField: keyof HueSettings
}

const PROVIDERS: Record<OpenAiCompatProvider, ProviderConfig> = {
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyField: 'googleApiKey',
    modelField: 'googleModel'
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    // Reuses the same Groq account key as the ASR provider.
    keyField: 'groqApiKey',
    modelField: 'groqModel'
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    keyField: 'mistralApiKey',
    modelField: 'mistralModel'
  },
  cohere: {
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    keyField: 'cohereApiKey',
    modelField: 'cohereModel'
  }
}

export function isOpenAiCompatProvider(p: string): p is OpenAiCompatProvider {
  return p === 'google' || p === 'groq' || p === 'mistral' || p === 'cohere'
}

function keyForProvider(provider: OpenAiCompatProvider, s: HueSettings): string {
  return (s[PROVIDERS[provider].keyField] as string).trim()
}

/** List the chat models the provider exposes, for the Settings dropdown. */
export async function fetchOpenAiModels(
  provider: OpenAiCompatProvider,
  apiKey: string
): Promise<string[]> {
  const key = apiKey.trim()
  if (!key) return []
  try {
    const res = await fetch(`${PROVIDERS[provider].baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: { id?: string }[] }
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      .sort()
  } catch {
    return []
  }
}

// Pick a model to actually call with. Honour the user's choice; otherwise fetch
// the provider's list and take the first, so we never bake in a model version.
async function resolveModel(
  provider: OpenAiCompatProvider,
  key: string,
  requested: string
): Promise<string> {
  if (requested.trim()) return requested.trim()
  const models = await fetchOpenAiModels(provider, key)
  if (models.length === 0) {
    throw new Error(
      `No model selected for ${provider} and none could be listed. Open Settings, ` +
        'enter your API key, and click "Detect models".'
    )
  }
  return models[0]
}

interface ActiveStream {
  abort: () => void
}
const active = new Map<string, ActiveStream>()

export function startOpenAiCompatStream(
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

  // A stall aborts through the same controller a user cancel does, so the catch
  // below has to be able to tell them apart: a cancel is a clean `done`, a stall
  // is an error the user needs to see.
  let stalled = false

  void (async () => {
    try {
      const s = getSettings()
      const provider = s.llmProvider
      if (!isOpenAiCompatProvider(provider)) {
        throw new Error(`startOpenAiCompatStream called for non-compatible provider: ${provider}`)
      }
      const key = keyForProvider(provider, s)
      if (!key) {
        throw new Error(`No API key configured for ${provider}. Add one in Settings.`)
      }
      const model = await resolveModel(provider, key, s[PROVIDERS[provider].modelField] as string)

      // OpenAI format carries the system prompt as a leading system-role message.
      const messages = [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...req.messages.map((m) => ({ role: m.role, content: toOpenAiContent(m.content) }))
      ]

      const response = await fetchWithRetry(
        `${PROVIDERS[provider].baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            max_tokens: req.maxTokens ?? 300
          })
        },
        provider,
        {
          signal: aborter.signal,
          onRetry: (attempt, code, delay) =>
            console.warn(
              `${provider} ${code || 'transport'} on attempt ${attempt}, retrying in ${delay}ms`
            )
        }
      )

      const reader = response.body?.getReader()
      if (!reader) throw new Error(`No response body from ${provider}`)

      const decoder = new TextDecoder()
      let buffer = ''

      // Without this, a socket that goes quiet without closing leaves the read
      // below pending forever: no delta, no done, no error, and an answer card
      // that spins for the rest of the interview.
      const guard = createStallGuard(() => {
        stalled = true
        aborter.abort()
      })

      // OpenAI-compatible SSE: lines like `data: {json}`, terminated by `data: [DONE]`.
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          guard.beat()
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const raw of lines) {
            const line = raw.trim()
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            if (payload === '[DONE]') {
              finishDone(false)
              return
            }
            let event: { choices?: { delta?: { content?: string } }[] }
            try {
              event = JSON.parse(payload)
            } catch {
              continue
            }
            const text = event.choices?.[0]?.delta?.content
            if (text) send('hue:llm:delta', { streamId, text })
          }
        }
      } finally {
        guard.clear()
      }
      finishDone(false)
    } catch (err) {
      const e = err as { name?: string; message?: string }
      // Order matters: a stall aborts the same controller a user cancel does,
      // and reporting a dead socket as a clean cancel is how the spinning card
      // stayed invisible in the first place.
      if (stalled) {
        finishError(`${getSettings().llmProvider} stopped responding mid-answer.`)
        return
      }
      if (e?.name === 'AbortError' || aborter.signal.aborted) {
        finishDone(true)
        return
      }
      finishError(e?.message ?? String(err))
    }
  })()
}

export function abortOpenAiCompatStream(streamId: string): void {
  active.get(streamId)?.abort()
}
