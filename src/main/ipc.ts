import { ipcMain, BrowserWindow } from 'electron'
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
import type {
  HueSettings,
  LlmStreamRequest,
  OpenAiCompatProvider,
  PhoneMirrorEvent
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

  ipcMain.handle('hue:settings:get', () => getSettings())
  ipcMain.handle('hue:settings:set', (_e, partial: Partial<HueSettings>) => {
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
  // Session events from the renderer, fanned out to connected phones. The shape
  // is validated here — the payload crosses a process boundary — and text is
  // bounded so a runaway transcript can't balloon the SSE stream.
  ipcMain.on('hue:phone:event', (_e, ev: PhoneMirrorEvent) => {
    if (!ev || typeof ev !== 'object' || !PHONE_EVENT_TYPES.has(ev.type)) return
    const text = typeof ev.text === 'string' ? ev.text.slice(0, 20_000) : undefined
    broadcastPhoneEvent({ type: ev.type, text })
  })

  // Grab the primary screen for the vision feature. Hue floats on top of every
  // app (alwaysOnTop), so it would photobomb its own screenshot — hide it for the
  // duration of the grab, then restore it exactly as it was.
  ipcMain.handle('hue:capture:screen', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const wasVisible = win?.isVisible() ?? false
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
