import type { WebContents } from 'electron'
// Explicit `.ts`, unlike the rest of this file's siblings: Node's type stripping
// resolves relative imports literally, and this module is now loadable under
// `node --test` (see the deferred `./settings` import below) — which it is not
// if this specifier needs a bundler to find its extension.
import { createStallGuard, fetchWithRetry } from './stream-resilience.ts'
// Safe to import at module load despite this file being loadable under
// `node --test`: `usage-store` only reaches for Electron inside `usageDir()`,
// and `record()` swallows the failure if it is not there.
import { record } from './usage-store.ts'
import { parseRateLimitHeaders } from '../shared/usage.ts'
import type {
  HueSettings,
  LlmMessage,
  LlmProvider,
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
 * Google Gemini, Groq, Mistral, Cohere and DeepSeek all expose an
 * OpenAI-compatible surface (Bearer-auth, POST /chat/completions with SSE
 * streaming, GET /models). They differ only by base URL, which settings key
 * holds the credential, and a couple of per-provider quirks, so one client
 * serves them all. No vendor SDKs needed — plain fetch, like ollama.
 *
 * The quirks live here as data rather than as `provider === 'deepseek'` checks
 * scattered through the streaming code: a name check at a call site is a fifth
 * copy of the provider list, and the next provider added would silently miss it.
 */
interface ProviderConfig {
  baseUrl: string
  /** Which HueSettings field holds this provider's API key. */
  keyField: keyof HueSettings
  /** Which HueSettings field holds the selected model. */
  modelField: keyof HueSettings
  /** Extra fields merged into the /chat/completions body for this provider. */
  extraBody?: Record<string, unknown>
  /**
   * Whether the provider accepts `image_url` content parts. Absent means yes —
   * every provider here but DeepSeek takes a screen capture.
   */
  vision?: boolean
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
  },
  deepseek: {
    // No `/v1` on this one — DeepSeek serves the compat surface at the root.
    baseUrl: 'https://api.deepseek.com',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    // Thinking is on by default on DeepSeek, and it streams the reasoning as
    // `delta.reasoning_content` — a field this renderer never reads — before the
    // first `delta.content` token arrives. Left on, the answer card sits empty
    // for the whole reasoning phase, mid-interview, on the hot path: exactly the
    // dead air this product exists to remove. A slightly weaker answer that
    // starts immediately beats a better one that starts after the question has
    // gone stale, so thinking is disabled rather than plumbed through.
    extraBody: { thinking: { type: 'disabled' } },
    // Text only: DeepSeek's chat API takes no `image_url` parts, so a screen
    // capture would come back as a bare 400.
    vision: false
  }
}

/**
 * The compat providers, read off the table rather than listed again.
 *
 * Exported so `provider-tables.test.ts` can cross-check this table against
 * `PROVIDER_BASE_URLS` in `structured-llm.ts` — half-adding a provider to one
 * table and not the other is the failure mode this whole file is arranged to
 * make impossible, and a test that hand-listed the providers would be one more
 * copy of the list rather than a check on the copies that exist.
 */
export const OPENAI_COMPAT_PROVIDERS = Object.keys(PROVIDERS) as OpenAiCompatProvider[]

/**
 * Derived from PROVIDERS rather than a hand-written `p === 'google' || ...`
 * chain.
 *
 * That chain was a fourth copy of the provider list (types, PROVIDERS,
 * PROVIDER_BASE_URLS, this), and it was the only copy the compiler could not
 * check — `false` is a perfectly valid answer for this function, so forgetting
 * to extend it typechecks clean and then throws "called for non-compatible
 * provider" at DRAFT time, mid-interview, on a provider the user configured
 * exactly right. Reading the table means adding a provider in one place.
 */
export function isOpenAiCompatProvider(p: string): p is OpenAiCompatProvider {
  return Object.hasOwn(PROVIDERS, p)
}

/**
 * Whether a provider can take a screen capture.
 *
 * `ipc.ts` asks before sending one, so a capture on a text-only provider comes
 * back as a sentence telling the user to switch providers rather than as a raw
 * 400 from the vendor. Non-compat providers (anthropic, ollama's vision models)
 * are not in the table and are assumed capable — the same default the table's
 * absent `vision` field carries.
 */
export function providerSupportsVision(provider: LlmProvider): boolean {
  if (!isOpenAiCompatProvider(provider)) return true
  return PROVIDERS[provider].vision !== false
}

/**
 * The order models are offered in — and, because `resolveModel` takes the first
 * of them, which model an unconfigured provider auto-picks.
 *
 * Plain alphabetical, which is not as arbitrary as it looks: on DeepSeek it puts
 * `deepseek-v4-flash` ahead of `deepseek-v4-pro`, and flash is the cheaper and
 * faster of the pair — the right default on the drafting hot path, where a
 * second of latency costs more than a shade of answer quality. Its own exported
 * function so that property can be asserted without a network round trip.
 */
export function sortModelIds(ids: string[]): string[] {
  return [...ids].sort()
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
    return sortModelIds(
      (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
    )
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
  req: LlmStreamRequest,
  /**
   * Which compatible provider serves this request, overriding `llmProvider`.
   *
   * Explicit rather than re-derived from settings: `hue:llm:start` has already
   * resolved the role for this one request, and reading `llmProvider` again here
   * would silently send an assessment question to the drafting provider. Optional
   * so every existing three-argument call keeps its meaning.
   */
  override?: OpenAiCompatProvider
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

  // Named in the stall message below, which runs in a catch that must not go
  // back to settings for it — see the lazy import inside the try.
  let providerLabel = 'The provider'

  void (async () => {
    try {
      // `./settings` is imported here rather than at module top level: it pulls
      // in real Electron `app` and `safeStorage` bindings, and a static import
      // drags Electron's runtime into every `node --test` run of this module —
      // including the one that only wants to read the PROVIDERS table. Same
      // reason `structured-llm.ts` defers its own settings import.
      const { getSettings } = await import('./settings')
      const s = getSettings()
      // The override wins. Everything below — the key, the model field, the base
      // URL, the extraBody quirks — is selected from this one binding, so the
      // whole request follows the resolved provider rather than half of it.
      const provider = override ?? s.llmProvider
      providerLabel = provider
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
            max_tokens: req.maxTokens ?? 300,
            // Provider-specific fields (see ProviderConfig.extraBody). Spread
            // last so a provider quirk can override a default we set above.
            ...(PROVIDERS[provider].extraBody ?? {})
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

      // Read before the body is touched. These headers are the only quota
      // signal on the drafting path: without `stream_options: {include_usage}`
      // these providers put no token counts in the stream at all, so the
      // vendor's own "remaining" figure is all there is — and it is stated on
      // every response, including this one.
      record({
        at: Date.now(),
        kind: 'llm',
        provider,
        model,
        limit: parseRateLimitHeaders(provider, response.headers, Date.now()) ?? undefined
      })

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
        finishError(`${providerLabel} stopped responding mid-answer.`)
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
