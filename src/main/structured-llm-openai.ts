import { LlmRefusal, type LlmClient, type StructuredRequest } from './structured-llm.ts'
import { record } from './usage-store.ts'
import { parseRateLimitHeaders } from '../shared/usage.ts'

/**
 * The OpenAI-compatible arm of the model boundary.
 *
 * Groq, Mistral, Cohere, Google's compat layer and OpenAI itself all speak the
 * same wire shape — Bearer auth, `POST /chat/completions`, choices with a
 * `finish_reason`. They differ by base URL and by which optional fields they
 * honour, so one client covers all of them and no vendor SDK is needed. This is
 * the same bet `hue-desktop/src/main/openai-compat.ts` already makes.
 *
 * What it does *not* cover is the guarantee the Anthropic path has. There,
 * `output_config.format` constrains generation, so downstream code can assume a
 * shape. Here that guarantee exists only where the provider implements strict
 * `json_schema` structured outputs; where it does not, we degrade to
 * `json_object` — valid JSON, arbitrary shape — and the schema becomes a
 * described contract rather than an enforced one. That is survivable only
 * because `pipeline.ts` normalises and bounds every field it reads and
 * `grounding.ts` verifies every claim; nothing downstream trusts the model's
 * shape. Do not remove those passes on the assumption the schema holds.
 */

/** Groq's OpenAI-compatible surface. Same path shape as OpenAI, different host. */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
/** DeepSeek serves the compat surface at the root — no `/v1` segment. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/**
 * Structured extraction plus a long story-mining output, on a provider that
 * implements strict `json_schema`. gpt-oss-120b is the pick on Groq because its
 * output ceiling (~65k) comfortably clears a 15–25 story bank; the stronger
 * instruction-followers on that lineup cap output far lower, and a bank that
 * truncates at story 12 is exactly the failure `LlmRefusal` exists to turn into
 * an honest error rather than a quietly short profile.
 */
export const DEFAULT_OPENAI_COMPAT_MODEL = 'openai/gpt-oss-120b'

/** A resume yields 15–25 stories; that is a large structured document. */
const DEFAULT_MAX_TOKENS = 32_000

/**
 * Non-streaming, so the whole story-mining response arrives in one body and the
 * socket must stay open for the model's entire generation — minutes, not
 * seconds, at 32k output tokens on a loaded free tier. Ingest is asynchronous by
 * design (the client holds a job id, not a socket), so waiting is free here;
 * timing out is not, because it costs the user a re-upload. Hence a deliberately
 * generous ceiling rather than a typical API timeout.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Groq's free tier rate-limits aggressively — a handful of requests a minute,
 * and a single ingest fires three to five model calls back to back, so a 429
 * mid-pipeline is the expected case rather than the exceptional one. Retrying
 * is what makes the pipeline usable on a free key at all.
 */
const DEFAULT_MAX_RETRIES = 4
const DEFAULT_RETRY_BASE_MS = 1000
/** A provider may ask for a multi-minute `retry-after`; honour it, but not forever. */
const MAX_RETRY_DELAY_MS = 60_000

export interface OpenAiCompatOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  /**
   * Which provider this is, for usage accounting only — the request itself is
   * identical either way, since that is the point of a compatible surface.
   * Absent means usage goes unattributed rather than being guessed from the
   * base URL, because a guess here would silently file Ollama's local tokens
   * under whichever cloud vendor shares its URL shape.
   */
  provider?: string
  /**
   * Test seam, and the escape hatch for a provider we cannot detect: `false`
   * starts in `json_object` mode without spending a call to discover it.
   */
  strictSchema?: boolean
  maxRetries?: number
  timeoutMs?: number
  /** Test seam: tests must not spend real seconds proving backoff happened. */
  retryBaseMs?: number
  /** Test seam so a fake provider can be injected without touching globals. */
  fetch?: typeof fetch
  /**
   * Provider-specific fields merged into the request body — DeepSeek's
   * `thinking: { type: 'disabled' }` is the reason this exists. Kept as opaque
   * data rather than named options so a vendor quirk never becomes a branch in
   * the request builder.
   */
  extraBody?: Record<string, unknown>
}

/**
 * A non-2xx from the provider, carrying the body.
 *
 * The body is the only place a provider says *why* it rejected the request, and
 * telling "your schema dialect is unsupported" apart from "you are out of
 * quota" is the whole basis of the one-time downgrade below.
 */
export class ProviderError extends Error {
  // Fields, not constructor parameter properties: Node runs this service by
  // stripping types, and parameter properties emit code, so they are rejected.
  status: number
  body: string

  constructor(status: number, body: string) {
    super(`provider returned ${status}: ${body.slice(0, 400)}`)
    this.name = 'ProviderError'
    this.status = status
    this.body = body
  }
}

/**
 * `json_schema.name` must be a bare identifier on OpenAI, and the labels here
 * are human phrases ("profile extraction"). Derived rather than hand-maintained
 * so a new pipeline step cannot forget to add one.
 */
function schemaName(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'response'
}

/**
 * The schema as a prompt-level contract, for `json_object` mode where nothing
 * enforces it.
 *
 * Generic — the schema is inlined verbatim rather than prose-described per call
 * site — because `schemas.ts` is the single source of truth and a hand-written
 * restatement would drift from it silently, which is worse than no contract at
 * all. The two extra sentences are the deviations that actually show up: models
 * omit keys they consider empty, and they wrap JSON in a markdown fence.
 *
 * This string MUST keep containing the literal word "JSON". DeepSeek's
 * `json_object` mode rejects outright — a 400, before any generation — a request
 * whose prompt never mentions json, and this contract is the only place the word
 * reliably appears in the DeepSeek path (it runs in `json_object` mode always).
 * Rewording the block to say "structured object" would break every DeepSeek
 * ingest and look like a provider outage.
 */
function schemaContract(schema: Record<string, unknown>): string {
  return [
    '',
    '',
    'Respond with a single JSON object and nothing else — no prose, no explanation,',
    'no markdown code fence. It must satisfy this JSON Schema:',
    '',
    JSON.stringify(schema),
    '',
    'Every key listed in "required" must be present, at every level. A field whose type',
    'includes "null" takes null when the value is unknown — never omit the key, and never',
    'substitute a guess for null.'
  ].join('\n')
}

/**
 * A provider rejecting the strict-schema dialect rather than the request.
 *
 * Deliberately broad: providers word this a dozen ways ("response_format.type
 * json_schema is not supported", "unknown parameter", "model does not support
 * structured outputs"), and the cost of a false positive is one degraded run
 * while the cost of a false negative is every ingest failing on a provider that
 * would have worked in `json_object` mode.
 */
function isSchemaRejection(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false
  if (err.status !== 400 && err.status !== 404 && err.status !== 422) return false
  return /json_schema|response_format|structured output|schema/i.test(err.body)
}

function isRetryable(err: unknown): boolean {
  // A transport failure (DNS, reset socket, timeout) has no status and is worth
  // one more go; a 4xx other than 429 is a request we would re-send unchanged.
  if (!(err instanceof ProviderError)) return true
  return err.status === 429 || err.status >= 500
}

/**
 * `retry-after` in seconds, or an HTTP date. Groq sends fractional seconds on
 * its free tier, which is more useful than our backoff curve — it knows when the
 * window resets and we are guessing.
 */
function retryAfterMs(body: string, header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS)
  // Some providers only put the wait in the message body; not worth parsing.
  void body
  return null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface ChatCompletion {
  choices?: {
    finish_reason?: string | null
    message?: { content?: string | null; refusal?: string | null }
  }[]
  /**
   * Always present — this call is deliberately non-streaming, and the
   * OpenAI-compatible shape puts token counts on every non-streamed reply. It
   * was arriving all along and being erased by the cast to this interface,
   * which declared only `choices`.
   */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

/**
 * Pull the JSON object out of the assistant's text.
 *
 * In `json_object` mode nothing stops a model from fencing its output, and a
 * fence is a formatting slip rather than a refusal — recovering from it is the
 * difference between a working ingest and a user re-uploading for no reason.
 * Anything past that is genuinely unusable and must not be guessed at.
 */
function parseJson<T>(text: string, label: string): T {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  if (fenced) candidates.push(fenced[1])

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      // Try the next shape.
    }
  }
  throw new LlmRefusal(`The ${label} step returned output that was not JSON.`, label)
}

export function openAiCompatClient(opts: OpenAiCompatOptions = {}): LlmClient {
  const apiKey =
    opts.apiKey ??
    process.env.HUE_INGEST_API_KEY ??
    process.env.GROQ_API_KEY ??
    process.env.OPENAI_API_KEY ??
    ''
  const baseUrl = (opts.baseUrl ?? process.env.HUE_INGEST_BASE_URL ?? GROQ_BASE_URL).replace(
    /\/+$/,
    ''
  )
  const model = opts.model ?? process.env.HUE_INGEST_MODEL ?? DEFAULT_OPENAI_COMPAT_MODEL
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  const doFetch = opts.fetch ?? fetch
  const extraBody = opts.extraBody ?? {}

  /**
   * Negotiated once, then remembered — scoped to the client, which lives for the
   * life of the process (the server builds one lazily and keeps it). Re-probing
   * strict schema on every call would spend a wasted round trip and a rate-limit
   * token per pipeline step against a provider we already know cannot do it.
   */
  let strict = opts.strictSchema ?? true

  async function post(body: unknown): Promise<ChatCompletion> {
    let lastError: unknown = null

    /**
     * One deadline for the whole call, not one per attempt.
     *
     * `timeoutMs` used to bound a single fetch, and a fresh signal was minted
     * inside every retry — so with four retries and a provider sending
     * `retry-after`, a "2 minute timeout" was really closer to ten. That is not
     * a timeout anyone can reason about, and on a desktop where a user is
     * watching a progress bar it is the difference between a slow upload and an
     * apparently dead one.
     *
     * Now the budget covers retries and backoff together: whatever is left is
     * what the next attempt gets, and when it runs out the call gives up rather
     * than starting another round.
     */
    const deadline = Date.now() + timeoutMs
    const remaining = (): number => deadline - Date.now()

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (remaining() <= 0) break
      try {
        const res = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(remaining())
        })

        if (res.ok) {
          const completion = (await res.json()) as ChatCompletion
          // Headers and body together — the one call site in the app where both
          // are in hand at once, because this request is not streamed.
          record({
            at: Date.now(),
            kind: 'llm',
            provider: opts.provider ?? 'openai-compat',
            model,
            inputTokens: completion.usage?.prompt_tokens,
            outputTokens: completion.usage?.completion_tokens,
            limit: opts.provider
              ? (parseRateLimitHeaders(opts.provider, res.headers, Date.now()) ?? undefined)
              : undefined
          })
          return completion
        }

        const text = await res.text().catch(() => '')
        const err = new ProviderError(res.status, text)
        if (!isRetryable(err)) throw err
        lastError = err
        if (attempt === maxRetries) break
        const wait =
          retryAfterMs(text, res.headers.get('retry-after')) ?? retryBaseMs * Math.pow(2, attempt)
        // Sleeping past the deadline would burn the remaining budget doing
        // nothing and still leave no time to retry in.
        if (wait >= remaining()) break
        await sleep(wait)
        continue
      } catch (err) {
        // A ProviderError we already decided not to retry must escape the loop
        // intact, so the schema-rejection check upstream can still see it.
        if (err instanceof ProviderError && !isRetryable(err)) throw err
        lastError = err
        if (attempt === maxRetries) break
        const wait = retryBaseMs * Math.pow(2, attempt)
        if (wait >= remaining()) break
        await sleep(wait)
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  async function once<T>(request: StructuredRequest, useStrict: boolean): Promise<T> {
    const system = useStrict ? request.system : request.system + schemaContract(request.schema)

    const completion = await post({
      model,
      // The OpenAI format carries the system prompt as a leading message. There
      // is no cache_control equivalent here: prompt caching on these providers
      // is automatic and prefix-based, which the identical system block already
      // satisfies without us asking for it.
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: request.user }
      ],
      // `max_tokens` rather than `max_completion_tokens`: it is the field every
      // compat provider accepts. Only OpenAI's own reasoning models insist on
      // the newer name, and those are not the target of this path.
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Extraction, not composition. Sampling variance here shows up as a
      // company name spelled differently between two runs of the same resume,
      // which breaks the content hash for no gain.
      temperature: 0,
      response_format: useStrict
        ? {
            type: 'json_schema',
            json_schema: { name: schemaName(request.label), schema: request.schema, strict: true }
          }
        : { type: 'json_object' },
      // `request.effort` is deliberately dropped: reasoning-effort is spelled
      // differently by every provider that has it and rejected outright by those
      // that do not, and a hard 400 on an advisory hint is a bad trade.
      //
      // Spread last so a provider quirk can override one of the defaults above
      // — DeepSeek's `thinking` toggle is what makes `temperature: 0` mean
      // anything at all, since it ignores temperature while thinking is on.
      ...extraBody
    })

    const choice = completion.choices?.[0]

    if (choice?.message?.refusal) {
      throw new LlmRefusal(
        `The model declined to process this document (${request.label}).`,
        request.label,
        // The compat format carries prose, not a refusal category.
        null
      )
    }
    if (choice?.finish_reason === 'content_filter') {
      throw new LlmRefusal(
        `The model declined to process this document (${request.label}).`,
        request.label,
        'content_filter'
      )
    }
    if (choice?.finish_reason === 'insufficient_system_resource') {
      // DeepSeek ends a stream this way when its own capacity runs out
      // mid-generation. It arrives as a 200 with a short or empty body, so
      // without this branch it fell through to "returned output that was not
      // JSON" — which points the user at their document and at us, when the
      // truth is the provider was full and the very same upload will work in a
      // minute. Wrong diagnosis is worse than no diagnosis here.
      throw new LlmRefusal(
        `The provider ran out of capacity partway through the ${request.label} step. ` +
          'Nothing is wrong with your document — try the upload again in a moment, ' +
          'or set a different Ingest provider in Settings.',
        request.label,
        'insufficient_system_resource'
      )
    }
    if (choice?.finish_reason === 'length') {
      // Truncated JSON will not parse, and a half-extracted profile is worse
      // than none — it looks complete and silently omits a job.
      throw new LlmRefusal(
        `The ${request.label} step ran past its output budget. The document may be too long.`,
        request.label
      )
    }

    return parseJson<T>(choice?.message?.content ?? '', request.label)
  }

  return {
    async structured<T>(request: StructuredRequest): Promise<T> {
      try {
        return await once<T>(request, strict)
      } catch (err) {
        // A provider without strict structured outputs rejects the very first
        // call. Downgrade once and remember, rather than failing every ingest on
        // a feature the model was never going to have. Note this is per-client
        // and per-provider, not per-schema: one schema the provider dislikes
        // (`GAP_ANSWER_SCHEMA`'s nullable object is the likely candidate)
        // downgrades the whole process. That is the conservative direction —
        // `json_object` always works, strict mode does not.
        if (strict && isSchemaRejection(err)) {
          strict = false
          return once<T>(request, false)
        }
        throw err
      }
    }
  }
}
