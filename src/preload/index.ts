import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  HueSettings,
  LlmStreamRequest,
  LlmDeltaEvent,
  LlmDoneEvent,
  LlmErrorEvent,
  CloudAsrResult,
  OpenAiCompatProvider,
  PhoneMirrorEvent,
  PhoneMirrorStatus,
  ScreenCapture
} from '../shared/types'

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const hue = {
  settings: {
    get: (): Promise<HueSettings> => ipcRenderer.invoke('hue:settings:get'),
    set: (partial: Partial<HueSettings>): Promise<HueSettings> =>
      ipcRenderer.invoke('hue:settings:set', partial)
  },
  llm: {
    start: (streamId: string, req: LlmStreamRequest): Promise<string> =>
      ipcRenderer.invoke('hue:llm:start', streamId, req),
    abort: (streamId: string): void => ipcRenderer.send('hue:llm:abort', streamId),
    onDelta: (cb: (e: LlmDeltaEvent) => void): (() => void) => sub('hue:llm:delta', cb),
    onDone: (cb: (e: LlmDoneEvent) => void): (() => void) => sub('hue:llm:done', cb),
    onError: (cb: (e: LlmErrorEvent) => void): (() => void) => sub('hue:llm:error', cb),
    models: (provider: OpenAiCompatProvider, apiKey: string): Promise<string[]> =>
      ipcRenderer.invoke('hue:llm:models', provider, apiKey)
  },
  ollama: {
    models: (baseUrl: string): Promise<string[]> => ipcRenderer.invoke('hue:ollama:models', baseUrl)
  },
  asr: {
    cloud: (pcm16: ArrayBuffer): Promise<CloudAsrResult> =>
      ipcRenderer.invoke('hue:asr:cloud', pcm16)
  },
  capture: {
    /** Grab the primary screen (Hue hides itself for the shot) as a base64 PNG. */
    screen: (): Promise<ScreenCapture> => ipcRenderer.invoke('hue:capture:screen')
  },
  phone: {
    status: (): Promise<PhoneMirrorStatus> => ipcRenderer.invoke('hue:phone:status'),
    /** Persists phoneMirrorEnabled and starts/stops the LAN server in one step. */
    setEnabled: (enabled: boolean): Promise<PhoneMirrorStatus> =>
      ipcRenderer.invoke('hue:phone:set-enabled', enabled),
    /** Fire-and-forget mirror of a session event to any connected phones. */
    event: (ev: PhoneMirrorEvent): void => ipcRenderer.send('hue:phone:event', ev)
  },
  hotkey: {
    /** Fired by the configurable start-session shortcut (or the tray) to start/stop a session. */
    onToggleSession: (cb: () => void): (() => void) => sub('hue:hotkey:toggle-session', cb),
    /** Fired by the configurable capture-screen shortcut to snapshot the screen. */
    onCaptureScreen: (cb: () => void): (() => void) => sub('hue:hotkey:capture-screen', cb)
  }
}

export type HueApi = typeof hue

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('hue', hue)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.hue = hue
}
