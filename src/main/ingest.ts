import { getSettings, updateSettings } from './settings'
import {
  isProfileBundle,
  type IngestOutcome,
  type IngestProgress
} from '../shared/profile'
import {
  NO_ENDPOINT_MESSAGE,
  accountRefusedMessage,
  isBlankBaseUrl,
  normalizeBaseUrl,
  unreachableMessage,
  uploadFailure
} from './ingest-errors'

/**
 * Client for `hue-ingest`, in the main process.
 *
 * The account token lives here and only here — the same principle the app
 * already applies to cloud ASR keys, and for the same reason: a credential that
 * reads someone's whole career history has no business in a renderer that also
 * renders remote content.
 *
 * Upload is a poll, not a held request: extraction takes tens of seconds, and
 * the service is built around the client checking back.
 */

const POLL_INITIAL_MS = 2000
const POLL_MAX_MS = 8000
const POLL_DEADLINE_MS = 5 * 60 * 1000

interface JobStatus {
  state: 'queued' | 'running' | 'done' | 'failed'
  bundleHash?: string | null
  error?: string | null
}

function baseUrl(): string {
  return normalizeBaseUrl(getSettings().ingestBaseUrl)
}

function failure(message: string, retryable = true): IngestOutcome {
  return { ok: false, message, retryable }
}

/** Prefers the service's own wording — it knows whether the file was a scan or a zip. */
async function serviceMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { message?: unknown }
    return typeof body.message === 'string' && body.message ? body.message : null
  } catch {
    return null
  }
}

interface Account {
  id: string
  token: string
}

type AccountResult = { ok: true; account: Account } | { ok: false; outcome: IngestOutcome }

/** Mints a fresh account, reporting *why* it could not rather than a bare null. */
async function createAccount(): Promise<AccountResult> {
  const url = baseUrl()
  if (isBlankBaseUrl(url)) return { ok: false, outcome: failure(NO_ENDPOINT_MESSAGE, false) }

  let response: Response
  try {
    response = await fetch(`${url}/v1/accounts`, { method: 'POST' })
  } catch {
    // Every reason the endpoint did not answer lands here — an unresolvable
    // host most of all, which is exactly what the shipped default is.
    return { ok: false, outcome: failure(unreachableMessage(url)) }
  }
  if (!response.ok) {
    return { ok: false, outcome: failure(accountRefusedMessage(url, response.status)) }
  }
  const created = (await response.json().catch(() => ({}))) as {
    accountId?: string
    token?: string
  }
  if (!created.accountId || !created.token) {
    return { ok: false, outcome: failure(accountRefusedMessage(url, response.status)) }
  }
  updateSettings({ ingestAccountId: created.accountId, ingestAccountToken: created.token })
  return { ok: true, account: { id: created.accountId, token: created.token } }
}

async function ensureAccount(): Promise<AccountResult> {
  const settings = getSettings()
  if (settings.ingestAccountId && settings.ingestAccountToken) {
    return { ok: true, account: { id: settings.ingestAccountId, token: settings.ingestAccountToken } }
  }
  return createAccount()
}

/** Forgets the saved account so the next mint is not blocked by a dead one. */
function forgetAccount(): void {
  updateSettings({ ingestAccountId: '', ingestAccountToken: '' })
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

async function fetchBundle(account: { id: string; token: string }, hash: string): Promise<IngestOutcome> {
  const response = await fetch(`${baseUrl()}/v1/accounts/${account.id}/bundles/${hash}`, {
    headers: authHeaders(account.token)
  })
  if (!response.ok) {
    return failure('That profile is no longer on the server. Upload your resume again.', false)
  }
  const bundle: unknown = await response.json()
  if (!isProfileBundle(bundle)) {
    return failure("Hue's server sent a profile this version can't read. Try updating Hue.", false)
  }
  // Persisting here rather than in the renderer keeps a single writer: the
  // renderer reads settings, it does not decide what a valid bundle is.
  updateSettings({ profileBundleJson: JSON.stringify(bundle) })
  return { ok: true, bundle }
}

/**
 * Uploads a resume and waits for the bundle.
 *
 * `onProgress` drives the Settings label. Naming the current step is what makes
 * a minute-long wait tolerable — a bare spinner at forty seconds reads as a hang.
 */
export async function ingestResume(
  bytes: Uint8Array,
  onProgress: (progress: IngestProgress) => void
): Promise<IngestOutcome> {
  const ensured = await ensureAccount()
  if (!ensured.ok) return ensured.outcome
  let account = ensured.account

  onProgress({ phase: 'uploading', elapsedSeconds: 0 })

  const upload = async (to: Account): Promise<Response | IngestOutcome> => {
    try {
      return await fetch(`${baseUrl()}/v1/accounts/${to.id}/ingest`, {
        method: 'POST',
        headers: { ...authHeaders(to.token), 'Content-Type': 'application/octet-stream' },
        body: bytes.buffer as ArrayBuffer
      })
    } catch {
      return failure(unreachableMessage(baseUrl()))
    }
  }

  let accepted = await upload(account)
  if (!(accepted instanceof Response)) return accepted

  // hue-ingest keeps accounts in memory and answers every auth failure with a
  // bare 404, so restarting it invalidates the id saved here. Re-minting once is
  // the whole recovery, and doing it silently is right: the old account is
  // provably gone, so there is nothing for the user to decide.
  if (accepted.status === 401 || accepted.status === 403 || accepted.status === 404) {
    forgetAccount()
    const reminted = await createAccount()
    if (!reminted.ok) return reminted.outcome
    account = reminted.account
    accepted = await upload(account)
    if (!(accepted instanceof Response)) return accepted
  }

  if (!accepted.ok) {
    const detail = await serviceMessage(accepted)
    const { message, retryable } = uploadFailure(accepted.status, detail)
    return failure(message, retryable)
  }

  const { jobId } = (await accepted.json()) as { jobId: string }
  onProgress({ phase: 'extracting', elapsedSeconds: 0 })

  let waited = 0
  let interval = POLL_INITIAL_MS
  while (waited < POLL_DEADLINE_MS) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    waited += interval
    interval = Math.min(Math.round(interval * 1.5), POLL_MAX_MS)
    onProgress({ phase: 'working', elapsedSeconds: Math.round(waited / 1000) })

    let status: JobStatus
    try {
      const response = await fetch(`${baseUrl()}/v1/accounts/${account.id}/jobs/${jobId}`, {
        headers: authHeaders(account.token)
      })
      if (!response.ok) {
        // The job is still running on the server; a failed poll says nothing
        // about it. Keep waiting rather than abandoning a live extraction.
        continue
      }
      status = (await response.json()) as JobStatus
    } catch {
      continue
    }

    if (status.state === 'done' && status.bundleHash) return fetchBundle(account, status.bundleHash)
    if (status.state === 'failed') {
      return failure(status.error ?? 'That resume could not be processed.', false)
    }
  }

  return failure('This is taking longer than expected. Your resume is still processing — check back shortly.')
}

/** Re-fetches the current bundle, e.g. after answering gap questions on the phone. */
export async function refreshBundle(): Promise<IngestOutcome> {
  const settings = getSettings()
  if (!settings.ingestAccountId || !settings.ingestAccountToken) {
    return failure('No profile is linked yet. Upload your resume first.', false)
  }
  const account = { id: settings.ingestAccountId, token: settings.ingestAccountToken }
  try {
    const response = await fetch(`${baseUrl()}/v1/accounts/${account.id}/bundle`, {
      headers: authHeaders(account.token)
    })
    if (!response.ok) {
      return failure('That profile is no longer on the server. Upload your resume again.', false)
    }
    const bundle: unknown = await response.json()
    if (!isProfileBundle(bundle)) {
      return failure("Hue's server sent a profile this version can't read.", false)
    }
    updateSettings({ profileBundleJson: JSON.stringify(bundle) })
    return { ok: true, bundle }
  } catch {
    return failure(unreachableMessage(baseUrl()))
  }
}

/**
 * Deletes the profile here and on the server.
 *
 * Both, or it is not a delete. The local clear happens regardless of whether the
 * server call succeeds — a user who asked for their data to be gone should not
 * find it still on their own disk because a request timed out.
 */
export async function deleteProfile(): Promise<void> {
  const settings = getSettings()
  if (settings.ingestAccountId && settings.ingestAccountToken) {
    try {
      await fetch(`${baseUrl()}/v1/accounts/${settings.ingestAccountId}`, {
        method: 'DELETE',
        headers: authHeaders(settings.ingestAccountToken)
      })
    } catch {
      // Best effort; the local wipe below is the part the user can see.
    }
  }
  updateSettings({ profileBundleJson: '', ingestAccountId: '', ingestAccountToken: '' })
}
