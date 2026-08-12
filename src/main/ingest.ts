import { extractResume, type ExtractResult } from './resume-extract.ts'
import { answerGap, runIngest } from './resume-pipeline.ts'
import { sealBundle } from './resume-profile.ts'
import { clientForSettings, LlmRefusal, MissingApiKey, quotaMessage } from './structured-llm.ts'
import {
  parseProfileBundle,
  type GapAnswerOutcome,
  type IngestOutcome,
  type IngestProgress,
  type ProfileBundle
} from '../shared/profile.ts'

/**
 * Resume ingest, in the main process.
 *
 * This used to be an HTTP client for `hue-ingest`: mint an account, POST the
 * bytes, poll a job, download the bundle. All of that is gone. The pipeline runs
 * here, which is what makes Hue a single app with nothing to start alongside it.
 *
 * It also buys the same privacy property `cuesheet-ingest.ts` already had: a
 * resume reaches the configured model provider and nowhere else — never Hue's
 * own infrastructure, because there is none. With Ollama selected it does not
 * leave the machine at all.
 */

/**
 * `./settings` is imported lazily throughout this file, never at module scope.
 *
 * It pulls in real Electron `app` and `safeStorage` bindings, and a static
 * import would make this module unloadable under plain `node --test` — which
 * would leave the outcome-mapping below, the part that decides what a user is
 * told when an ingest fails, with no test coverage at all.
 */
const settingsModule = (): Promise<typeof import('./settings')> => import('./settings')

function failure(message: string, retryable = true): IngestOutcome {
  return { ok: false, message, retryable }
}

/**
 * An extraction refusal, as an outcome.
 *
 * Never retryable: the extractor already decided these bytes cannot be read, and
 * the same file will fail the same way. Offering a retry would be an invitation
 * to click it forever.
 */
export function outcomeForExtractFailure(
  result: Extract<ExtractResult, { ok: false }>
): IngestOutcome {
  return failure(result.message, false)
}

/** Turns a thrown pipeline error into something a user can act on. */
export function outcomeForError(err: unknown): IngestOutcome {
  // The one configuration a user can still get wrong now that there is no
  // endpoint to misconfigure. Points at Settings, not at the network.
  if (err instanceof MissingApiKey) return failure(err.message, false)

  // Quota failures arrive as a wall of provider JSON. `quotaMessage` separates
  // the two cases that look identical and call for opposite actions: a request
  // too large for any single call, versus a daily allowance that is simply
  // spent. Never retryable here — the client has already exhausted its own
  // backoff, and a document does not get smaller on a second try.
  const quota = quotaMessage(err)
  if (quota) return failure(quota, false)

  // A refusal or a truncation is not worth retrying with the same input; a
  // transport error or an ordinary rate limit is.
  if (err instanceof LlmRefusal) return failure(err.message, false)
  return failure(err instanceof Error ? err.message : String(err))
}

export async function ingestResume(
  bytes: Uint8Array,
  onProgress: (progress: IngestProgress) => void
): Promise<IngestOutcome> {
  onProgress({ phase: 'extracting', elapsedSeconds: 0 })

  const extracted = await extractResume(Buffer.from(bytes))
  if (!extracted.ok) return outcomeForExtractFailure(extracted)

  const started = Date.now()
  const elapsed = (): number => Math.round((Date.now() - started) / 1000)

  try {
    const llm = await clientForSettings('ingest')
    const { bundle } = await runIngest(extracted.text, llm, {
      onPhase: (phase) => onProgress({ phase, elapsedSeconds: elapsed() })
    })
    // Persisting here rather than in the renderer keeps a single writer: the
    // renderer reads settings, it does not decide what a valid bundle is.
    const { updateSettings } = await settingsModule()
    updateSettings({ profileBundleJson: JSON.stringify(bundle) })
    return { ok: true, bundle }
  } catch (err) {
    return outcomeForError(err)
  }
}

/**
 * Returns the bundle already on disk.
 *
 * Kept so the renderer's IPC surface does not change, but there is no longer a
 * server that could be holding a newer copy — the local bundle is the only one.
 */
export async function refreshBundle(): Promise<IngestOutcome> {
  const bundle = await currentBundle()
  if (!bundle) return failure('No profile is linked yet. Upload your resume first.', false)
  return { ok: true, bundle }
}

/** Deletes the profile. There is no server copy to delete any more. */
export async function deleteProfile(): Promise<void> {
  const { updateSettings } = await settingsModule()
  updateSettings({ profileBundleJson: '' })
}

async function currentBundle(): Promise<ProfileBundle | null> {
  const { getSettings } = await settingsModule()
  return parseProfileBundle(getSettings().profileBundleJson)
}

/** Folds a typed gap answer back into the bank. */
export async function answerProfileGap(gapId: string, text: string): Promise<GapAnswerOutcome> {
  const bundle = await currentBundle()
  if (!bundle) return { ok: false, message: 'No profile is linked yet. Upload your resume first.' }

  try {
    const llm = await clientForSettings('ingest')
    // The renderer's bundle type is the wide one (competencies as strings,
    // because it is parsed from user-editable JSON); the pipeline works in the
    // narrow one. The cast is the single conversion point, and it is safe
    // because `answerGap` re-normalises everything it touches against
    // `COMPETENCIES` before returning.
    const result = await answerGap(
      bundle as unknown as Parameters<typeof answerGap>[0],
      gapId,
      text,
      llm
    )
    const next = result.bundle as unknown as ProfileBundle
    const { updateSettings } = await settingsModule()
    updateSettings({ profileBundleJson: JSON.stringify(next) })
    return { ok: true, bundle: next, accepted: result.accepted, reason: result.reason }
  } catch (err) {
    const outcome = outcomeForError(err)
    return { ok: false, message: outcome.ok === false ? outcome.message : 'Ingest failed.' }
  }
}

/**
 * Records that the user has no story for this gap.
 *
 * Deliberately does not call the model. "I don't have one" is a fact the user
 * asserted, not a judgement to be made — and routing it through a model would
 * make the honest answer the one path that needs an API key and a network.
 * Recording it truthfully is the entire point of the gap scan.
 */
export async function skipProfileGap(gapId: string): Promise<ProfileBundle> {
  const bundle = await currentBundle()
  if (!bundle) throw new Error('No profile is linked yet.')

  const gaps = bundle.gaps.map((g) => (g.id === gapId ? { ...g, status: 'skipped' as const } : g))
  // Reseal: the bank changed, so the content hash must change with it, or every
  // cached copy keyed on that hash goes quietly stale.
  const sealed = sealBundle(
    { version: bundle.version, profile: bundle.profile, stories: bundle.stories, gaps },
    new Date().toISOString()
  )
  const { updateSettings } = await settingsModule()
  updateSettings({ profileBundleJson: JSON.stringify(sealed) })
  return sealed
}
