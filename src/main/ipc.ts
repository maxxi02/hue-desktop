import { app, ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { getSettings, updateSettings } from './settings'
import { captureScreen } from './capture'
import { startLlmStream, abortLlmStream } from './anthropic'
import { startOllamaStream, abortOllamaStream, fetchOllamaModels } from './ollama'
import {
  startOpenAiCompatStream,
  abortOpenAiCompatStream,
  fetchOpenAiModels,
  isOpenAiCompatProvider,
  providerSupportsVision
} from './openai-compat'
import { transcribeCloud } from './asr-cloud'
import { applyHotkeys } from './hotkeys'
import {
  startPhoneMirror,
  stopPhoneMirror,
  getPhoneMirrorStatus,
  broadcastPhoneEvent
} from './phone-mirror'
import { startRelay, stopRelay, getRelayStatus, publishRelayEvent } from './relay-client'
import {
  answerProfileGap,
  deleteProfile,
  ingestResume,
  refreshBundle,
  skipProfileGap
} from './ingest'
import { analyzeJobDescription } from './job-spec-ingest'
import { JOB_DESCRIPTION_LIMIT } from '../shared/job-spec'
import { parseProfileBundle } from '../shared/profile'
import {
  createTarget,
  deleteTarget,
  duplicateTarget,
  ensureTargets,
  renameTarget,
  switchTarget,
  type TargetPatch
} from '../shared/targets'
import { applyStealth, isStealthSupported } from './stealth'
import { currentEvents, onRecorded } from './usage-store'
import { summarize, type UsageSummary } from '../shared/usage'
import { applyWindowAnchor } from './window-placement'
import { currentPolicy } from './system-memory'
import type {
  HueSettings,
  LlmStreamRequest,
  OpenAiCompatProvider,
  PhoneMirrorEvent,
  ScreenCapture,
  StealthStatus
} from '../shared/types'

const PHONE_EVENT_TYPES: ReadonlySet<PhoneMirrorEvent['type']> = new Set([
  'question',
  'answer',
  'state',
  'clear'
])

let registered = false

export function registerIpc(): void {
  if (registered) return
  registered = true

  // The running build's version. Surfaced in Settings because 'which build am
  // I on' is otherwise unanswerable from inside the app, and a stale install
  // looks identical to a bug in the current one.
  ipcMain.handle('hue:app:version', () => app.getVersion())

  // How much of itself Hue may keep resident on this machine. Read fresh on each
  // call rather than cached at startup: free memory is exactly the thing that
  // moves while the app is open, and a session started at hour three should be
  // judged on what is free then, not on what was free at launch.
  ipcMain.handle('hue:system:memory', () => currentPolicy())

  ipcMain.handle('hue:settings:get', () => getSettings())
  ipcMain.handle('hue:settings:set', (event, partial: Partial<HueSettings>) => {
    const prev = getSettings()
    const next = updateSettings(partial)
    // Re-bind the global triggers if any of them changed.
    if (
      next.summonHotkey !== prev.summonHotkey ||
      next.startSessionHotkey !== prev.startSessionHotkey ||
      next.captureScreenHotkey !== prev.captureScreenHotkey
    ) {
      applyHotkeys()
    }
    // Same pattern for stealth: the flag lives on the window, not in the store,
    // so a saved setting only means anything once it is pushed to the window the
    // request came from. Saving from Settings must not need a restart.
    if (next.stealthMode !== prev.stealthMode) {
      applyStealth(BrowserWindow.fromWebContents(event.sender), next.stealthMode)
    }
    // Anchoring is likewise a property of the window rather than of the store.
    // Only re-place on an actual change: applying on every save would yank a
    // window the user had just dragged back to the anchor, on a save they made
    // for some unrelated setting.
    if (
      next.windowAnchor !== prev.windowAnchor ||
      next.windowAnchorMargin !== prev.windowAnchorMargin
    ) {
      applyWindowAnchor(BrowserWindow.fromWebContents(event.sender))
    }
    return next
  })

  ipcMain.handle('hue:llm:start', (event, streamId: string, req: LlmStreamRequest) => {
    const provider = getSettings().llmProvider
    if (provider === 'ollama') {
      startOllamaStream(event.sender, streamId, req)
    } else if (isOpenAiCompatProvider(provider)) {
      startOpenAiCompatStream(event.sender, streamId, req)
    } else {
      startLlmStream(event.sender, streamId, req)
    }
    return streamId
  })
  // The streamId is unique across providers, so abort all; only the owner acts.
  ipcMain.on('hue:llm:abort', (_e, streamId: string) => {
    abortLlmStream(streamId)
    abortOllamaStream(streamId)
    abortOpenAiCompatStream(streamId)
  })

  ipcMain.handle('hue:ollama:models', (_e, baseUrl: string) => fetchOllamaModels(baseUrl))
  ipcMain.handle('hue:llm:models', (_e, provider: OpenAiCompatProvider, apiKey: string) =>
    fetchOpenAiModels(provider, apiKey)
  )

  ipcMain.handle('hue:asr:cloud', (_e, pcm: ArrayBuffer) => transcribeCloud(pcm))

  // Usage. Summarised in the main process rather than shipping the raw event
  // log to the renderer: a week of interviews is thousands of rows, and the
  // panel only ever renders the totals.
  ipcMain.handle('hue:usage:get', (): UsageSummary => {
    const now = Date.now()
    return summarize(currentEvents(now), now)
  })

  // Pushed so the panel is live while a session runs. Coalesced on a timer —
  // an event fires per utterance and per model turn, and re-rendering a
  // stats panel at that rate is pure overhead for numbers nobody reads that
  // fast.
  // One subscription per renderer, however many times it asks.
  //
  // The panel subscribes on mount, and closing it only removes the listener on
  // the renderer's side — this one would survive. Opening and closing the panel
  // ten times would then leave ten live subscriptions here, each re-summarising
  // the entire event log on every utterance, for a panel nobody is looking at.
  const usageSubscribers = new Map<number, () => void>()

  ipcMain.on('hue:usage:subscribe', (event) => {
    const id = event.sender.id
    if (usageSubscribers.has(id)) return

    let pending = false
    const stop = onRecorded(() => {
      // Coalesced: an event fires per utterance and per model turn, and
      // re-rendering a stats panel at that rate is pure overhead for numbers
      // nobody reads that fast.
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        if (event.sender.isDestroyed()) return
        const now = Date.now()
        event.sender.send('hue:usage:changed', summarize(currentEvents(now), now))
      }, 1_000).unref?.()
    })

    const release = (): void => {
      stop()
      usageSubscribers.delete(id)
    }
    usageSubscribers.set(id, release)
    // A reloaded renderer would otherwise leave its listener behind for a
    // WebContents that no longer exists.
    event.sender.once('destroyed', release)
  })

  // Phone mirror: the toggle persists the setting and starts/stops the server in
  // one step, so the QR code appears immediately without a separate Save.
  ipcMain.handle('hue:phone:status', () => getPhoneMirrorStatus())
  ipcMain.handle('hue:phone:set-enabled', async (_e, enabled: boolean) => {
    updateSettings({ phoneMirrorEnabled: Boolean(enabled) })
    if (enabled) return startPhoneMirror()
    stopPhoneMirror()
    return getPhoneMirrorStatus()
  })

  // Relay: same shape as the phone-mirror toggle, but the room lives on a remote
  // service so the phone works off-LAN. Enabling registers a fresh room, which
  // invalidates any previously scanned QR — that is deliberate.
  ipcMain.handle('hue:relay:status', () => getRelayStatus())
  ipcMain.handle('hue:relay:set-enabled', async (_e, enabled: boolean) => {
    updateSettings({ relayEnabled: Boolean(enabled) })
    if (enabled) return startRelay(getSettings().relayBaseUrl)
    stopRelay()
    return getRelayStatus()
  })

  // Session events from the renderer, fanned out to connected phones. The shape
  // is validated here — the payload crosses a process boundary — and text is
  // bounded so a runaway transcript can't balloon the SSE stream.
  // Unlike `handle`, a throw in an `on` listener has no promise to land in — it
  // is an uncaught main-process exception. This fires on every LLM delta, so it
  // is the highest-frequency listener in the app: whatever the mirror does, it
  // must not be able to take the session down with it.
  ipcMain.on('hue:phone:event', (_e, ev: PhoneMirrorEvent) => {
    try {
      if (!ev || typeof ev !== 'object' || !PHONE_EVENT_TYPES.has(ev.type)) return
      const text = typeof ev.text === 'string' ? ev.text.slice(0, 20_000) : undefined
      broadcastPhoneEvent({ type: ev.type, text })
      // Both transports get every event: the LAN mirror for offline use, the relay
      // for the phone app on mobile data. Neither blocks the voice pipeline.
      publishRelayEvent({ type: ev.type, text })
    } catch (e) {
      console.error('phone event fan-out failed:', e)
    }
  })

  // Resume ingest. The bytes come from the renderer's file picker and the whole
  // pipeline runs here — no service, no account, no upload. The resume reaches
  // the configured model provider and nowhere else, and with Ollama selected it
  // does not leave the machine.
  ipcMain.handle('hue:profile:ingest', async (event, bytes: ArrayBuffer) => {
    return ingestResume(new Uint8Array(bytes), (progress) => {
      // Progress on a side channel rather than as the return value: the call
      // takes about a minute, and a Settings pane showing nothing for that long
      // is indistinguishable from a hang.
      if (!event.sender.isDestroyed()) event.sender.send('hue:profile:progress', progress)
    })
  })

  ipcMain.handle('hue:profile:refresh', () => refreshBundle())
  ipcMain.handle('hue:profile:delete', () => deleteProfile())

  // Gap answers. These used to be answerable only in the phone app, which left
  // a desktop-only user with a permanently incomplete bundle — and the gaps are
  // precisely the questions a model would otherwise invent an answer to.
  ipcMain.handle('hue:profile:answer-gap', async (_e, gapId: string, text: string) => {
    if (typeof gapId !== 'string' || !gapId) throw new Error('A gap id is required.')
    // Bounded because the payload crosses a process boundary and the answer is
    // pasted straight into a prompt.
    return answerProfileGap(gapId, String(text ?? '').slice(0, 10_000))
  })

  ipcMain.handle('hue:profile:skip-gap', async (_e, gapId: string) => {
    if (typeof gapId !== 'string' || !gapId) throw new Error('A gap id is required.')
    return skipProfileGap(gapId)
  })

  // The job posting. Same progress-on-a-side-channel shape again, and for the
  // same reason: the analysis is several model calls deep, and a Settings pane
  // that shows nothing for that long is indistinguishable from a hang.
  ipcMain.handle('hue:jobspec:analyze', async (event, text: string) => {
    if (typeof text !== 'string') throw new Error('A job description is required.')
    // Bounded because the payload crosses a process boundary and the posting is
    // pasted straight into a prompt.
    const bounded = String(text ?? '').slice(0, JOB_DESCRIPTION_LIMIT)
    const spec = await analyzeJobDescription(bounded, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('hue:jobspec:progress', progress)
    })
    // The brief: the questions this posting implies, each pointed at the story
    // in the user's own bank that answers it. It needs the bank, so an install
    // with no résumé analysed simply gets no brief — there is nothing for the
    // questions to point at.
    //
    // Failure here is not failure of the analysis. The spec is the thing the
    // user pressed the button for and it is already built; losing the brief
    // costs some context on later answers, while throwing would lose the spec
    // too and make a working analysis look broken.
    let briefJson = ''
    const bundle = parseProfileBundle(getSettings().profileBundleJson)
    if (bundle && bundle.stories.length > 0) {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send('hue:jobspec:progress', {
            phase: 'Anticipating their questions',
            pct: 85
          })
        }
        const { jobDescriptionBrief } = await import('./resume-pipeline.ts')
        const { clientForSettings } = await import('./structured-llm.ts')
        const brief = await jobDescriptionBrief(bundle, bounded, await clientForSettings('ingest'))
        briefJson = JSON.stringify(brief)
      } catch (e) {
        console.error('the job brief could not be generated; the analysis stands:', e)
      }
    }

    // All three fields in one write: the posting, its analysis, and its brief
    // are only ever read together, and separate writes leave a window where a
    // crash strands an analysis whose source text is a different posting.
    updateSettings({
      jobDescription: bounded,
      jobSpecJson: JSON.stringify(spec),
      jobBriefJson: briefJson
    })
    return spec
  })
  // A throw above persists nothing — deliberately, not by omission. Settings
  // already saves the textarea through the ordinary settings path, so the raw
  // posting survives a failed analysis without this handler writing it, and the
  // error travels to the renderer to be shown.

  ipcMain.handle('hue:jobspec:clear', () => updateSettings({ jobDescription: '', jobSpecJson: '' }))

  /*
    Saved applications.

    Every one of these is the same three lines — compute a patch, write it if
    there is one, hand back the settings — and they live in main rather than in
    the renderer for one reason: ingest and the job-spec analysis also write
    these fields, from here. A renderer that read settings, computed a switch,
    and wrote it back would have a window in which a finishing ingest could land
    a résumé bundle into the application the user just left.

    They return the full `HueSettings` so the drawer can re-render from one
    round-trip. `null` from the pure function means "nothing to do" — an unknown
    id, an already-active slot, the last application — and the current settings
    come back unchanged rather than an error, because none of those are failures
    the user needs told about.
  */
  const applyTargetPatch = (patch: TargetPatch | null): HueSettings =>
    patch ? updateSettings(patch) : getSettings()

  /**
   * Adopt the current fields as the first application if there is none yet.
   *
   * Called by the renderer when the drawer opens rather than at startup: it is
   * the only moment the list is about to be looked at, and doing it at launch
   * would rewrite the settings file of every install on upgrade before anyone
   * had asked for the feature.
   */
  ipcMain.handle('hue:targets:ensure', () => applyTargetPatch(ensureTargets(getSettings())))

  ipcMain.handle('hue:targets:switch', (_e, id: string) =>
    applyTargetPatch(switchTarget(getSettings(), id))
  )

  ipcMain.handle('hue:targets:create', (_e, name: string) =>
    applyTargetPatch(createTarget(getSettings(), name))
  )

  ipcMain.handle('hue:targets:duplicate', (_e, name: string) =>
    applyTargetPatch(duplicateTarget(getSettings(), name))
  )

  ipcMain.handle('hue:targets:rename', (_e, id: string, name: string) =>
    applyTargetPatch(renameTarget(getSettings(), id, name))
  )

  ipcMain.handle('hue:targets:delete', (_e, id: string) =>
    applyTargetPatch(deleteTarget(getSettings(), id))
  )

  // Stealth status for the renderer: the setting alone doesn't tell the UI
  // whether the window is really hidden from capture, so the platform's verdict
  // travels with it. `effective` is what the header badge should trust.
  ipcMain.handle('hue:stealth:status', (): StealthStatus => {
    const enabled = getSettings().stealthMode
    const supported = isStealthSupported()
    return { enabled, supported, effective: enabled && supported }
  })

  // Grab the primary screen for the vision feature. Hue floats on top of every
  // app (alwaysOnTop), so it would photobomb its own screenshot — hide it for the
  // duration of the grab, then restore it exactly as it was.
  // Serialised: the trigger is a global hotkey, so it is mashable. Two
  // overlapping grabs meant the first one's restore ran while the second was
  // still capturing — Hue photobombing the screenshot it just hid for — and on a
  // multi-monitor 4K rig the window could be invisible for seconds with no
  // failure path back.
  let captureInFlight: Promise<ScreenCapture> | null = null

  ipcMain.handle('hue:capture:screen', async (event) => {
    // Refused here rather than in `hue:llm:start`, where the image block would
    // also be visible: this is the earliest point in the flow, so a text-only
    // provider costs the user nothing — no window hide/restore flicker, no
    // multi-megabyte PNG, no wait — and the message can name the capture as the
    // thing that failed instead of arriving as a failed answer mid-interview.
    // DeepSeek has no `image_url` content part, so the alternative is a raw HTTP
    // 400 from the vendor at the worst possible moment. Asked of the table in
    // openai-compat rather than by name, so a new text-only provider is one
    // entry, not another branch here.
    const provider = getSettings().llmProvider
    if (!providerSupportsVision(provider)) {
      throw new Error(
        `${provider} is text-only, so it can't read a screenshot. ` +
          'Switch the AI provider in Settings to use screen capture.'
      )
    }
    if (captureInFlight) return captureInFlight
    const run = doCaptureScreen(event)
    captureInFlight = run
    try {
      return await run
    } finally {
      captureInFlight = null
    }
  })

  async function doCaptureScreen(event: IpcMainInvokeEvent): Promise<ScreenCapture> {
    const win = BrowserWindow.fromWebContents(event.sender)
    // With stealth in force the window is already excluded from desktopCapturer,
    // so hiding it would buy nothing and cost a visible flicker on every capture
    // — skip the hide/restore dance entirely in that case.
    const stealthy = getSettings().stealthMode && isStealthSupported()
    const wasVisible = !stealthy && (win?.isVisible() ?? false)
    if (win && wasVisible) {
      win.hide()
      // Give the compositor a beat to actually paint the window away before the
      // capture is taken, so Hue isn't still in the frame.
      await new Promise((r) => setTimeout(r, 120))
    }
    try {
      return await captureScreen()
    } finally {
      if (win && wasVisible && !win.isDestroyed()) win.showInactive()
    }
  }
}
