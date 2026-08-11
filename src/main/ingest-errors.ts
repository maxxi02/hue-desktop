/**
 * The wording layer for `ingest.ts`, kept pure and free of `electron` imports so
 * it can be tested without a running app.
 *
 * These strings are the whole user-visible surface of a failed upload — the
 * Settings pane renders `IngestOutcome.message` verbatim and nothing else. That
 * makes "check your connection" an expensive thing to say when the connection
 * was never the problem: `ingestBaseUrl` defaults to a hosted service that a
 * self-hosting user has not deployed, and the honest fix is to name the URL that
 * failed and say what to do about it.
 */

/** Trailing slashes are the difference between `/v1/x` and `//v1/x`. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** True when the setting cannot name a service at all. */
export function isBlankBaseUrl(raw: string): boolean {
  return normalizeBaseUrl(raw).length === 0
}

export const NO_ENDPOINT_MESSAGE =
  'No résumé service is configured. Set the résumé service URL in Settings — ' +
  'run hue-ingest yourself (npm start, port 8788) and point this at ' +
  'http://localhost:8788.'

/**
 * The endpoint did not answer at all: DNS failure, refused connection, TLS.
 *
 * Naming the URL is the point. A user told only "check your connection" has no
 * way to discover that the address itself is the fault — which it usually is,
 * since the service is one the user runs locally rather than one we host.
 */
export function unreachableMessage(baseUrl: string): string {
  return (
    `Couldn't reach the résumé service at ${baseUrl}. ` +
    'Start hue-ingest (npm start, port 8788) and set the résumé service URL in Settings, ' +
    'or check your connection.'
  )
}

/** The endpoint answered, but would not mint an account. */
export function accountRefusedMessage(baseUrl: string, status: number): string {
  return `The résumé service at ${baseUrl} refused to create an account (HTTP ${status}).`
}

export interface Failure {
  message: string
  retryable: boolean
}

/**
 * Maps an upload response status to what the user should be told.
 *
 * `404` is the one worth separating. hue-ingest answers every auth failure with
 * a bare 404 so a scanner cannot learn an account exists, and it keeps accounts
 * in memory — so a service restart silently invalidates the account id saved on
 * this machine. Folded into the generic branch, that arrives as "that file
 * couldn't be read as a resume", permanently and about a file that is fine.
 */
export function uploadFailure(status: number, serviceMessage: string | null): Failure {
  if (status === 413) {
    return {
      message: 'That file is larger than 10 MB. Upload the resume itself, not a portfolio.',
      retryable: false
    }
  }
  if (status === 401 || status === 403 || status === 404) {
    return {
      message:
        'Your profile link is no longer valid — the résumé service was restarted or reset. ' +
        'Upload your resume again to relink.',
      retryable: true
    }
  }
  // 422 is the interesting one: an unreadable PDF, a scan, an unsupported
  // format. The service explains which, and re-uploading the same file will
  // fail identically — so this is not retryable.
  return {
    message: serviceMessage ?? "That file couldn't be read as a resume.",
    retryable: false
  }
}
