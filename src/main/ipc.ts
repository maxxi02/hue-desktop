import { app, ipcMain, BrowserWindow } from 'electron'
import { getSettings, updateSettings } from './settings'
import { captureScreen } from './capture'
import { startLlmStream, abortLlmStream } from './anthropic'
import { startOllamaStream, abortOllamaStream, fetchOllamaModels } from './ollama'
import {
  startOpenAiCompatStream,
  abortOpenAiCompatStream,
  fetchOpenAiModels,
  isOpenAiCompatProvider
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
import { ingestCueSheet } from './cuesheet-ingest'
import { listSheets, deleteSheet, sheetsDir, isValidSheetId } from './cuesheet-store'
import { applyStealth, isStealthSupported } from './stealth'
import { applyWindowAnchor } from './window-placement'
import type {
  HueSettings,
  LlmStreamRequest,
  OpenAiCompatProvider,
  PhoneMirrorEvent,
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
  ipcMain.on('hue:phone:event', (_e, ev: PhoneMirrorEvent) => {
    if (!ev || typeof ev !== 'object' || !PHONE_EVENT_TYPES.has(ev.type)) return
    const text = typeof ev.text === 'string' ? ev.text.slice(0, 20_000) : undefined
    broadcastPhoneEvent({ type: ev.type, text })
    // Both transports get every event: the LAN mirror for offline use, the relay
    // for the phone app on mobile data. Neither blocks the voice pipeline.
    publishRelayEvent({ type: ev.type, text })
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

  // Cue sheets. Same progress-on-a-side-channel shape as profile ingest: the
  // call takes long enough that a pane showing nothing is indistinguishable
  // from a hang.
  ipcMain.handle(
    'hue:cuesheet:ingest',
    async (event, bytes: ArrayBuffer, filename: string, label: string) => {
      return ingestCueSheet(new Uint8Array(bytes), filename, label, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('hue:cuesheet:progress', progress)
      })
    }
  )

  ipcMain.handle('hue:cuesheet:list', () => listSheets(sheetsDir()))
  // '' is the "no sheet armed" sentinel the radio group sends; anything else
  // has to be a well-formed id, or a malformed one gets persisted here and
  // throws much later out of `fileFor` when the user tries to delete it.
  ipcMain.handle('hue:cuesheet:select', (_e, id: string) => {
    if (id !== '' && !isValidSheetId(id)) throw new Error(`Invalid cue sheet id: ${id}`)
    return updateSettings({ selectedCueSheetId: id })
  })
  ipcMain.handle('hue:cuesheet:delete', (_e, id: string) => {
    deleteSheet(sheetsDir(), id)
    if (getSettings().selectedCueSheetId === id) updateSettings({ selectedCueSheetId: '' })
  })

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
  ipcMain.handle('hue:capture:screen', async (event) => {
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
  })
}
