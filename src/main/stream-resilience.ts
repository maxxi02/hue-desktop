/**
 * Resilience for the *live* drafting path — the one that runs while an
 * interviewer is mid-sentence.
 *
 * The ingest path already had retries and deadlines (see structured-llm-openai);
 * the streaming path had neither, which left two failures that a user meets as
 * "Hue just stopped working":
 *
 *   1. A stalled socket. A VPN flap or a provider that hangs the connection
 *      without sending FIN leaves `reader.read()` pending forever. No delta, no
 *      `done`, no `error` — the answer card spins for the rest of the session
 *      and the stream entry never leaves the active map.
 *   2. A 429 or a 5xx on the one turn that mattered. Groq's free tier rate
 *      limits aggressively, and a single non-2xx killed that answer outright.
 *
 * Both fixes are deliberately impatient. This is a latency path: a draft that
 * arrives after the candidate has already had to answer is worth no more than
 * no draft at all, so the budgets here are seconds, not the tens of seconds an
 * offline ingest can afford.
 */

/** No first byte within this long and we give up rather than hang. */
export const CONNECT_TIMEOUT_MS = 15_000
/**
 * Longest silence tolerated *between* chunks once the stream is flowing. Real
 * token streams emit far faster than this; a gap this size means the socket is
 * dead, not slow.
 */
export const STALL_TIMEOUT_MS = 20_000

const DEFAULT_MAX_ATTEMPTS = 3
/** Short, because the user is waiting. Attempt N waits BASE * 2^(N-1). */
const BASE_BACKOFF_MS = 400
const MAX_BACKOFF_MS = 2_000

/**
 * Statuses worth a second try. 408/425/429 are explicit "try again" signals;
 * 500/502/503/504 are transient server-side. Anything else (401 bad key, 400
 * malformed request, 404 wrong model) will fail identically on a retry, so
 * retrying only burns the user's remaining time.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600)
}

/**
 * How long to wait before the next attempt. A `Retry-After` header wins when the
 * provider sends a sane one — but it is clamped, because some providers answer
 * a burst with "retry after 60", and a 60-second wait mid-interview is
 * indistinguishable from a hang. Past the cap we would rather fail fast and let
 * the speculation scheduler fire a fresh draft.
 */
export function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS)
  if (!retryAfter) return backoff
  const seconds = Number(retryAfter.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return backoff
  return Math.min(Math.max(seconds * 1000, backoff), MAX_BACKOFF_MS)
}

/**
 * A non-ok response, with the response's own evidence still attached.
 *
 * This used to be a plain `Error` holding only a formatted string, which meant
 * every 429 — the one response that arrives with the vendor's rate-limit headers
 * filled in — destroyed those headers at the throw. Since the usage panel exists
 * to answer "how close am I to a limit", losing the numbers at exactly the
 * moment the limit is hit was the worst possible place to lose them.
 *
 * The message is unchanged and still what surfaces to the user; `status` and
 * `headers` are extra for callers that want them. Transport failures (DNS,
 * refused) still throw the original error — there is no response behind them, so
 * there is nothing to carry.
 */
export class ProviderHttpError extends Error {
  readonly status: number
  readonly headers: Headers

  constructor(message: string, status: number, headers: Headers) {
    super(message)
    this.name = 'ProviderHttpError'
    this.status = status
    this.headers = headers
  }
}

export interface RetryingFetchOptions {
  /** Caller's cancellation (user hit stop / the question was withdrawn). */
  signal: AbortSignal
  maxAttempts?: number
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injected in tests so backoff does not cost real seconds. */
  sleep?: (ms: number) => Promise<void>
  /** Called before each retry, for logging. */
  onRetry?: (attempt: number, status: number, delayMs: number) => void
}

/**
 * POST with bounded connect time and retries on transient statuses.
 *
 * Retries happen only *before* any body is read, so a caller can never receive
 * the same tokens twice: once a stream is flowing, a failure is the caller's to
 * report, not ours to paper over by starting a second generation whose text
 * would be appended to the first one's.
 *
 * The returned response is guaranteed `ok`; a non-retryable or
 * attempts-exhausted status throws with the provider's own detail text.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  opts: RetryingFetchOptions
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal.aborted) throw abortError()

    // Two independent reasons to give up: the caller cancelled, or the provider
    // never answered. Combining them means the connect budget can never outlive
    // a cancelled draft.
    const timeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS)
    const combined = anySignal([opts.signal, timeout])

    let response: Response
    try {
      response = await doFetch(url, { ...init, signal: combined })
    } catch (err) {
      if (opts.signal.aborted) throw abortError()
      // A transport-level failure (DNS, refused, reset, connect timeout) is
      // exactly as retryable as a 503, and on flaky conference wifi it is the
      // common case.
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt >= maxAttempts) throw lastError
      const delay = retryDelayMs(attempt, null)
      opts.onRetry?.(attempt, 0, delay)
      await sleep(delay)
      continue
    }

    if (response.ok) return response

    const detail = await response.text().catch(() => '')
    const message = `${label} error ${response.status}: ${detail || response.statusText}`

    if (!isRetryableStatus(response.status) || attempt >= maxAttempts) {
      throw new ProviderHttpError(message, response.status, response.headers)
    }

    const delay = retryDelayMs(attempt, response.headers.get('retry-after'))
    opts.onRetry?.(attempt, response.status, delay)
    await sleep(delay)
    lastError = new ProviderHttpError(message, response.status, response.headers)
  }

  throw lastError ?? new Error(`${label} failed after ${maxAttempts} attempts`)
}

/**
 * Watchdog for a flowing stream. `beat()` on every chunk; if a full
 * STALL_TIMEOUT_MS passes without one, `onStall` fires — the caller aborts the
 * request, which turns an infinite hang into an ordinary error the renderer can
 * show and the scheduler can retry from.
 *
 * `clear()` is mandatory in a finally: a live timer keeps the event loop busy
 * and, worse, could abort a *later* stream that reused the controller.
 */
export function createStallGuard(
  onStall: () => void,
  timeoutMs: number = STALL_TIMEOUT_MS
): { beat: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let cleared = false

  const arm = (): void => {
    if (cleared) return
    timer = setTimeout(() => {
      timer = null
      onStall()
    }, timeoutMs)
    // Never hold the process open on the watchdog alone.
    timer.unref?.()
  }

  const clear = (): void => {
    cleared = true
    if (timer) clearTimeout(timer)
    timer = null
  }

  arm()
  return {
    beat: () => {
      if (cleared) return
      if (timer) clearTimeout(timer)
      arm()
    },
    clear
  }
}

function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/**
 * `AbortSignal.any` exists on Node 20+, but is guarded here because this module
 * also runs under the renderer-facing typecheck config.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any
  if (any) return any.call(AbortSignal, signals)
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason)
      break
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}
