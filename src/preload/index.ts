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
import type { UsageSummary } from '../shared/usage'
import type {
  GapAnswerOutcome,
  IngestOutcome,
  IngestProgress,
  ProfileBundle
} from '../shared/profile'
import type { JobSpec } from '../shared/job-spec'
import type { MemoryPolicy, MemorySnapshot } from '../shared/memory-policy'

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const hue = {
  /** The running build's version, for the label in Settings. */
  version: (): Promise<string> => ipcRenderer.invoke('hue:app:version'),
  system: {
    /**
     * How much of itself Hue may keep resident here — whether to warm the models
     * before a session, which Whisper device to use, and whether to hand the
     * memory back when a session ends. Measured in main (the renderer cannot see
     * free physical memory) and re-read per call, since that is the number that
     * moves while the app is open.
     */
    memory: (): Promise<MemoryPolicy & { snapshot: MemorySnapshot }> =>
      ipcRenderer.invoke('hue:system:memory')
  },
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
      ipcRenderer.invoke('hue:profile:skip-gap', gapId),
    /**
     * Re-run the gap scan against the stored bundle. One model call, a few
     * seconds; the story bank is not touched.
     */
    rescanGaps: (): Promise<ProfileBundle> => ipcRenderer.invoke('hue:profile:rescan-gaps')
  },
  usage: {
    /** Totals and remaining quota per provider, already summarised. */
    get: (): Promise<UsageSummary> => ipcRenderer.invoke('hue:usage:get'),
    /**
     * Ask main to start pushing updates, then listen for them. Both halves are
     * needed: the subscribe tells main which renderer to push to, and the
     * returned unsubscribe drops the listener when the panel closes.
     */
    watch: (cb: (s: UsageSummary) => void): (() => void) => {
      ipcRenderer.send('hue:usage:subscribe')
      return sub('hue:usage:changed', cb)
    }
  },
  jobSpec: {
    /** Analyse the pasted posting into a JobSpec and persist it. Subscribe to onProgress first. */
    analyze: (text: string): Promise<JobSpec> => ipcRenderer.invoke('hue:jobspec:analyze', text),
    /** Clears both the pasted posting and its analysis. */
    clear: (): Promise<HueSettings> => ipcRenderer.invoke('hue:jobspec:clear'),
    onProgress: (cb: (p: { phase: string; pct: number }) => void): (() => void) =>
      sub('hue:jobspec:progress', cb)
  },
  /**
   * Saved applications. Every call returns the whole settings document, because
   * a switch rewrites six fields at once and the drawer has to re-render from
   * the result rather than guess which ones moved.
   */
  targets: {
    /** Adopt the current fields as the first application if none exists yet. */
    ensure: (): Promise<HueSettings> => ipcRenderer.invoke('hue:targets:ensure'),
    switch: (id: string): Promise<HueSettings> => ipcRenderer.invoke('hue:targets:switch', id),
    create: (name: string): Promise<HueSettings> => ipcRenderer.invoke('hue:targets:create', name),
    duplicate: (name: string): Promise<HueSettings> =>
      ipcRenderer.invoke('hue:targets:duplicate', name),
    rename: (id: string, name: string): Promise<HueSettings> =>
      ipcRenderer.invoke('hue:targets:rename', id, name),
    /** Permanent, and may take the only copy of an ingested résumé. Confirm first. */
    delete: (id: string): Promise<HueSettings> => ipcRenderer.invoke('hue:targets:delete', id)
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
