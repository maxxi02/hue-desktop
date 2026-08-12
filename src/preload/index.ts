import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
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
  RelayStatus,
  ScreenCapture,
  StealthStatus
} from '../shared/types'
import type {
  GapAnswerOutcome,
  IngestOutcome,
  IngestProgress,
  ProfileBundle
} from '../shared/profile'
import type { CueSheet } from '../shared/cuesheet'

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const hue = {
  /** The running build's version, for the label in Settings. */
  version: (): Promise<string> => ipcRenderer.invoke('hue:app:version'),
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
  profile: {
    /**
     * Upload a resume and wait for the structured bundle. Takes about a minute;
     * subscribe to `onProgress` first or the pane looks frozen.
     */
    ingest: (bytes: ArrayBuffer): Promise<IngestOutcome> =>
      ipcRenderer.invoke('hue:profile:ingest', bytes),
    onProgress: (cb: (p: IngestProgress) => void): (() => void) => sub('hue:profile:progress', cb),
    /** Re-read the bundle from disk. There is no server copy any more. */
    refresh: (): Promise<IngestOutcome> => ipcRenderer.invoke('hue:profile:refresh'),
    /** Deletes the profile. */
    delete: (): Promise<void> => ipcRenderer.invoke('hue:profile:delete'),
    /** Fold a typed answer for one gap question back into the story bank. */
    answerGap: (gapId: string, text: string): Promise<GapAnswerOutcome> =>
      ipcRenderer.invoke('hue:profile:answer-gap', gapId, text),
    /** Record that the user has no story for this gap. Costs no model call. */
    skipGap: (gapId: string): Promise<ProfileBundle> =>
      ipcRenderer.invoke('hue:profile:skip-gap', gapId)
  },
  cueSheet: {
    /**
     * Upload a cue sheet document and wait for the parsed cards. Takes a while;
     * subscribe to `onProgress` first or the pane looks frozen.
     */
    ingest: (bytes: ArrayBuffer, filename: string, label: string): Promise<CueSheet> =>
      ipcRenderer.invoke('hue:cuesheet:ingest', bytes, filename, label),
    list: (): Promise<CueSheet[]> => ipcRenderer.invoke('hue:cuesheet:list'),
    /** Arms the given sheet id as `selectedCueSheetId`. */
    select: (id: string): Promise<HueSettings> => ipcRenderer.invoke('hue:cuesheet:select', id),
    /** Deletes the sheet; clears the selection if it was the one selected. */
    delete: (id: string): Promise<void> => ipcRenderer.invoke('hue:cuesheet:delete', id),
    onProgress: (cb: (p: { phase: string; pct: number }) => void): (() => void) =>
      sub('hue:cuesheet:progress', cb)
  },
  phone: {
    status: (): Promise<PhoneMirrorStatus> => ipcRenderer.invoke('hue:phone:status'),
    /** Persists phoneMirrorEnabled and starts/stops the LAN server in one step. */
    setEnabled: (enabled: boolean): Promise<PhoneMirrorStatus> =>
      ipcRenderer.invoke('hue:phone:set-enabled', enabled),
    /** Fire-and-forget mirror of a session event to any connected phones. */
    event: (ev: PhoneMirrorEvent): void => ipcRenderer.send('hue:phone:event', ev)
  },
  relay: {
    status: (): Promise<RelayStatus> => ipcRenderer.invoke('hue:relay:status'),
    /** Persists relayEnabled and registers/tears down the relay room in one step. */
    setEnabled: (enabled: boolean): Promise<RelayStatus> =>
      ipcRenderer.invoke('hue:relay:set-enabled', enabled)
  },
  stealth: {
    /**
     * Whether the window is currently kept out of screen captures, and whether
     * this platform can do that at all — the setting on its own doesn't say.
     */
    getStealthStatus: (): Promise<StealthStatus> => ipcRenderer.invoke('hue:stealth:status')
  },
  hotkey: {
    /** Fired by the configurable start-session shortcut (or the tray) to start/stop a session. */
    onToggleSession: (cb: () => void): (() => void) => sub('hue:hotkey:toggle-session', cb),
    /** Fired by the configurable capture-screen shortcut to snapshot the screen. */
    onCaptureScreen: (cb: () => void): (() => void) => sub('hue:hotkey:capture-screen', cb)
  }
}

export type HueApi = typeof hue

// The renderer is sandboxed with context isolation on (see createWindow), so the
// bridge is the only surface exposed to page code — no generic ipcRenderer.
contextBridge.exposeInMainWorld('hue', hue)
