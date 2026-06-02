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
import type { HueSettings, LlmStreamRequest, OpenAiCompatProvider } from '../shared/types'

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
