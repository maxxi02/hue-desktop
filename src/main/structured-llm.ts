import Anthropic from '@anthropic-ai/sdk'

/**
 * The model boundary.
 *
 * Everything above this file is deterministic and unit-testable; everything
 * below it is a network call to a model. `LlmClient` is the seam — the pipeline
 * takes one as an argument, so the whole extract → mine → gap-scan flow runs in
 * `node:test` against a scripted fake with no key and no network.
 */

export interface StructuredRequest {
  /** Cached prefix. Keep byte-identical across calls that share it. */
  system: string
  user: string
  /**
   * JSON Schema the response must satisfy.
   *
   * Structured outputs constrain generation rather than asking politely for
   * JSON, which is what makes the downstream code able to assume a shape.
   * Note the schema dialect is restricted: every object needs
   * `additionalProperties: false`, and `minLength` / `maximum` and friends are
   * not enforced — bound those in code instead (see `pipeline.ts`).
   */
  schema: Record<string, unknown>
  /** Label used in errors and in the request log. */
  label: string
  maxTokens?: number
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface LlmClient {
  structured<T>(request: StructuredRequest): Promise<T>
}

/**
 * A model declined the request, or produced nothing usable.
 *
 * Separate from a transport error because the caller's response differs: a
 * refusal or a truncation is not worth retrying with the same input, whereas a
 * 500 is.
 */
export class LlmRefusal extends Error {
  // Declared as fields rather than constructor parameter properties: Node runs
  // these services by stripping types, and parameter properties emit code, so
  // they are rejected outright rather than erased.
  label: string
  category: string | null

  constructor(message: string, label: string, category: string | null = null) {
    super(message)
    this.name = 'LlmRefusal'
    this.label = label
    this.category = category
  }
}

/** Ingest is not on the hot path, so the strongest model is the right default. */
export const DEFAULT_MODEL = 'claude-opus-5'

/**
 * Server-side refusal fallback. Enabled by default per Anthropic's guidance for
 * Opus 5: on a policy decline the API re-runs the request on a fallback model
 * chosen by refusal category, rather than handing back an unusable refusal.
 *
 * `"default"` rather than a pinned model, so a deprecated fallback target is not
 * a migration this service has to do.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** A resume yields 15–25 stories; that is a large structured document. */
const DEFAULT_MAX_TOKENS = 32_000

interface AnthropicOptions {
  apiKey?: string
  model?: string
  /** Test seam, and the escape hatch if an org has not enabled the beta. */
  fallbacks?: boolean
  client?: Anthropic
}

/**
 * Extracts the assistant's text.
 *
 * Structured outputs still arrive as ordinary text blocks; the constraint is on
 * what those blocks may contain, not on where they live. Thinking blocks are
 * skipped — on Opus 5 thinking is on by default and its text is omitted anyway.
 */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export function anthropicClient(opts: AnthropicOptions = {}): LlmClient {
  const model = opts.model ?? process.env.HUE_INGEST_MODEL ?? DEFAULT_MODEL
  // Explicit `false` disables; anything else leaves the guidance default on.
  let useFallbacks = opts.fallbacks ?? process.env.HUE_INGEST_FALLBACKS !== '0'

  const client =
    opts.client ??
    new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      // Ingest is asynchronous by design — a slow extraction is fine, a failed
      // one costs the user a re-upload.
      maxRetries: 4
    })

  async function once<T>(request: StructuredRequest, withFallbacks: boolean): Promise<T> {
    // Streaming rather than a plain create: a full story bank is tens of
    // thousands of output tokens, and a non-streaming request that large runs
    // into the SDK's HTTP timeout well before the model finishes.
    const stream = client.beta.messages.stream({
      model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: request.system,
          // The system block is identical across every call that shares a
          // prompt, so later calls in a run read it from cache.
          cache_control: { type: 'ephemeral' }
        }
      ],
      output_config: {
        effort: request.effort ?? 'high',
        format: { type: 'json_schema', schema: request.schema }
      },
      ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
      messages: [{ role: 'user', content: request.user }]
      // `fallbacks` and `output_config.format` are newer than the SDK's typings
      // in some releases; the wire shape is what the API documents.
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming)

    const message = (await stream.finalMessage()) as unknown as Anthropic.Message

    if (message.stop_reason === 'refusal') {
      const details = (message as { stop_details?: { category?: string | null } }).stop_details
      throw new LlmRefusal(
        `The model declined to process this document (${request.label}).`,
        request.label,
        details?.category ?? null
      )
    }
    if (message.stop_reason === 'max_tokens') {
      // Truncated JSON will not parse, and a half-extracted profile is worse
      // than none — it looks complete and silently omits a job.
      throw new LlmRefusal(
        `The ${request.label} step ran past its output budget. The document may be too long.`,
        request.label
      )
    }

    const text = textOf(message)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new LlmRefusal(
        `The ${request.label} step returned output that was not JSON.`,
        request.label
      )
    }
  }

  return {
    async structured<T>(request: StructuredRequest): Promise<T> {
      try {
        return await once<T>(request, useFallbacks)
      } catch (err) {
        // An org without the fallback beta gets a 400 naming it. Downgrade once
        // and remember, rather than failing every ingest on an opt-in feature.
        if (useFallbacks && isBetaRejection(err)) {
          useFallbacks = false
          return once<T>(request, false)
        }
        throw err
      }
    }
  }
}

function isBetaRejection(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false
  const message = String(err.message ?? '')
  return message.includes('fallback') || message.includes(FALLBACK_BETA)
}

/**
 * The second implementation of the same seam, for Groq and anything else that
 * speaks the OpenAI chat-completions format. Re-exported here so `LlmClient`
 * stays the one boundary every caller imports — a caller that reached past this
 * file for a provider would be a caller the tests cannot fake.
 */
export {
  openAiCompatClient,
  ProviderError,
  DEFAULT_OPENAI_COMPAT_MODEL,
  GROQ_BASE_URL,
  OPENAI_BASE_URL,
  type OpenAiCompatOptions
} from './structured-llm-openai.ts'

// --- Desktop wiring: which provider a workload runs on -----------------------

import type { LlmProvider } from '../shared/types.ts'
// The re-export at the foot of this file makes `openAiCompatClient` part of
// this module's public surface, but a re-export does not bind the name locally
// — `clientForSettings` below calls it, so it needs a real import too.
import { openAiCompatClient, ProviderError } from './structured-llm-openai.ts'

/** The OpenAI-compatible surfaces the app already speaks (see `openai-compat.ts`). */
export const PROVIDER_BASE_URLS: Record<'google' | 'groq' | 'mistral' | 'cohere', string> = {
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1'
}

/**
 * Resolves which provider a given workload runs on.
 *
 * Ingest and live drafting are configured separately because Groq — the right
 * choice for drafting, being both cheapest and fastest — cannot run ingest at
 * all on its free tier: `gpt-oss-120b` is capped at 8,000 TPM and the
 * story-mining call is 11-12k tokens in one request. Groq's Developer tier is
 * unavailable to buy, so this is not a wait-and-it-resolves problem. `''` means
 * "same as drafting", which is the default and right for every other provider.
 */
export function providerFor(
  role: 'drafting' | 'ingest',
  llmProvider: LlmProvider,
  ingestProvider: LlmProvider | ''
): LlmProvider {
  return role === 'ingest' && ingestProvider ? ingestProvider : llmProvider
}

/** Ollama's OpenAI-compatible surface hangs off the user's own host. */
export function baseUrlFor(provider: LlmProvider, ollamaBaseUrl: string): string {
  if (provider === 'ollama') {
    return `${(ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '')}/v1`
  }
  if (provider === 'anthropic') {
    throw new Error('anthropic does not use an OpenAI-compatible base URL')
  }
  return PROVIDER_BASE_URLS[provider]
}

/**
 * Thrown when the selected provider has no key.
 *
 * Its own type because it is the one configuration a user can still get wrong
 * now that there is no endpoint to misconfigure, and it deserves a message that
 * points at Settings rather than reading as a network failure.
 */
export class MissingApiKey extends Error {
  // A field plus assignment, not a constructor parameter property: Node runs
  // this by stripping types, and parameter properties emit code.
  provider: string

  constructor(provider: string) {
    super(`No API key configured for ${provider}. Add one in Settings.`)
    this.name = 'MissingApiKey'
    this.provider = provider
  }
}

/**
 * A provider quota failure, in words a user can act on.
 *
 * Returns null when the error is not a quota problem, so callers can fall
 * through to their own handling.
 *
 * Two different failures arrive as the same 429/413 shape and need opposite
 * advice, which is why this exists rather than a single "rate limited" string:
 *
 *  - **Per-minute or per-request** — the document is bigger than one request is
 *    allowed to be. Waiting never fixes it; a provider with more headroom does.
 *  - **Per-day** — the quota is spent. The document is fine, the account is out
 *    of tokens until the window rolls over, and the provider tells us exactly
 *    when. Suggesting a different provider here would be wrong twice over: it
 *    implies the upload was faulty, and the same account may be fine in an hour.
 */
export function quotaMessage(err: unknown): string | null {
  if (!(err instanceof ProviderError)) return null
  if (err.status !== 429 && err.status !== 413) return null

  const body = String(err.body ?? '')
  if (!/rate.?limit|too large|tokens per/i.test(body)) return null

  if (/tokens per day|\bTPD\b/i.test(body)) {
    // The provider states the reset precisely; quoting it beats "try later".
    const when = body.match(/try again in ([0-9hms.]+)/i)?.[1]
    return (
      `This provider's daily token allowance is used up${when ? `, and resets in about ${when}` : ''}. ` +
      'Nothing is wrong with your document. Either wait for the allowance to reset, ' +
      'or set a different Ingest provider in Settings to finish now.'
    )
  }

  if (/tokens per minute|\bTPM\b|too large/i.test(body)) {
    return (
      'Reading a whole document needs more tokens in one request than this provider allows. ' +
      'Free tiers cap this well below what ingest needs, and retrying will not help because ' +
      'the document is the same size each time. Set a different Ingest provider in Settings ' +
      '(Google or Ollama); drafting can stay where it is.'
    )
  }

  return 'This provider is rate limiting the request. Try again shortly, or use a different Ingest provider.'
}

/**
 * How long one ingest request may take before it is abandoned.
 *
 * The compat client's own default is ten minutes, chosen when ingest ran as a
 * service: the client held a job id and polled, so nobody was waiting on the
 * socket and a generous ceiling cost nothing. In the desktop that is no longer
 * true — the user is the one holding it, watching a progress line — and ten
 * minutes of silence is indistinguishable from a hang.
 *
 * Local models get the long ceiling anyway, because there the wait is real
 * rather than wedged: a small model on CPU has been measured at nearly two
 * minutes for a single step, and cutting it off would break the offline path
 * to protect a user who is not paying for the time.
 */
const CLOUD_INGEST_TIMEOUT_MS = 2 * 60 * 1000
const LOCAL_INGEST_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Builds the client a workload runs on, from settings.
 *
 * Async because `./settings` is imported lazily: it pulls in real Electron
 * `app` and `safeStorage` bindings, and a static import would drag Electron's
 * runtime into every `node --test` run of this module. Same reason
 * `cuesheet-ingest.ts` defers its own imports.
 */
export async function clientForSettings(role: 'drafting' | 'ingest'): Promise<LlmClient> {
  const { getSettings } = await import('./settings')
  const s = getSettings()
  const provider = providerFor(role, s.llmProvider, s.ingestProvider)

  if (provider === 'anthropic') {
    if (!s.anthropicApiKey) throw new MissingApiKey('Anthropic')
    return anthropicClient({ apiKey: s.anthropicApiKey, model: s.model || undefined })
  }

  if (provider === 'ollama') {
    // No key: a local server does not have one, and demanding a placeholder
    // would be the one thing standing between an offline user and an offline
    // ingest. The compat client still wants a non-empty bearer.
    return openAiCompatClient({
      apiKey: 'ollama',
      baseUrl: baseUrlFor('ollama', s.ollamaBaseUrl),
      model: s.ollamaModel || undefined,
      timeoutMs: LOCAL_INGEST_TIMEOUT_MS
    })
  }

  const keys: Record<'google' | 'groq' | 'mistral' | 'cohere', string> = {
    google: s.googleApiKey,
    groq: s.groqApiKey,
    mistral: s.mistralApiKey,
    cohere: s.cohereApiKey
  }
  const models: Record<'google' | 'groq' | 'mistral' | 'cohere', string> = {
    google: s.googleModel,
    groq: s.groqModel,
    mistral: s.mistralModel,
    cohere: s.cohereModel
  }

  const apiKey = keys[provider]
  if (!apiKey) throw new MissingApiKey(provider)

  return openAiCompatClient({
    apiKey,
    baseUrl: baseUrlFor(provider, s.ollamaBaseUrl),
    // Empty means "auto-pick", which the compat client's default already does.
    model: models[provider] || undefined,
    timeoutMs: CLOUD_INGEST_TIMEOUT_MS
  })
}
