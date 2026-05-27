import { ipcMain } from 'electron'
import { getSettings, updateSettings } from './settings'
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
    // Re-bind the global triggers if either the summon or start-session one changed.
    if (
      next.summonHotkey !== prev.summonHotkey ||
      next.startSessionHotkey !== prev.startSessionHotkey
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
}
