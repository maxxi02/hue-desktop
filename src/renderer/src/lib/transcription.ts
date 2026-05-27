import type { HueSettings, ResolvedTier } from '@shared/types'

export interface TranscriptionResult {
  text: string
  tier: ResolvedTier
  latencyMs: number
}

export type ModelLoadState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number; file?: string }
  | { status: 'ready'; device?: 'webgpu' | 'wasm' }
  | { status: 'error'; message: string }

type WorkerOut =
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'progress'; data: { status: string; file?: string; progress?: number } }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>()

let loadState: ModelLoadState = { status: 'idle' }
const loadListeners = new Set<(s: ModelLoadState) => void>()

function setLoadState(s: ModelLoadState): void {
  loadState = s
  loadListeners.forEach((cb) => cb(s))
}

export function onModelLoadStateChange(cb: (s: ModelLoadState) => void): () => void {
  loadListeners.add(cb)
  cb(loadState)
  return () => loadListeners.delete(cb)
}

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<WorkerOut>): void => {
    const msg = e.data
    switch (msg.type) {
      case 'ready':
        console.info(`[whisper] on-device model ready on ${msg.device}`)
        setLoadState({ status: 'ready', device: msg.device })
        break
      case 'progress':
        if (msg.data.status === 'progress') {
          setLoadState({
            status: 'loading',
            progress: Math.round(msg.data.progress ?? 0),
            file: msg.data.file
          })
        }
        break
      case 'result': {
        pending.get(msg.id)?.resolve(msg.text)
        pending.delete(msg.id)
        break
      }
      case 'error': {
        if (msg.id === -1) {
          setLoadState({ status: 'error', message: msg.message })
        } else {
          pending.get(msg.id)?.reject(new Error(msg.message))
          pending.delete(msg.id)
        }
        break
      }
    }
  }
  return worker
}

/** Kick off the on-device model download/initialisation early (e.g. on app start). */
export function preloadOnDeviceModel(): void {
  if (loadState.status === 'idle' || loadState.status === 'error') {
    setLoadState({ status: 'loading', progress: 0 })
    getWorker().postMessage({ type: 'load' })
  }
}

/** On-device tier: Whisper-base.en running locally in a Web Worker. */
export function transcribeOnDevice(audio: Float32Array): Promise<string> {
  const w = getWorker()
  const id = nextId++
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    // Transfer the underlying buffer to avoid a copy.
    w.postMessage({ type: 'transcribe', id, audio }, [audio.buffer])
  })
}

/** Convert mono Float32 [-1,1] samples to 16-bit little-endian PCM. */
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out.buffer
}

/** Cloud tier: cloud ASR, proxied through the main process (key stays in main). */
export async function transcribeCloud(audio: Float32Array): Promise<string> {
  const pcm = floatTo16BitPCM(audio)
  const res = await window.hue.asr.cloud(pcm)
  return res.text
}

function cloudKeyPresent(s: HueSettings): boolean {
  switch (s.cloudAsrProvider) {
    case 'deepgram':
      return !!s.deepgramApiKey
    case 'assemblyai':
      return !!s.assemblyAiApiKey
    case 'groq':
      return !!s.groqApiKey
    default:
      return false
  }
}

/**
 * Resolve which tier to actually use. In 'auto' we prefer cloud when a key is
 * configured, otherwise fall back to on-device Whisper (the always-works tier).
 */
function resolveTier(s: HueSettings): ResolvedTier {
  if (s.asrTier === 'on-device') return 'on-device'
  if (s.asrTier === 'cloud') return cloudKeyPresent(s) ? 'cloud' : 'on-device'
  // auto
  return cloudKeyPresent(s) ? 'cloud' : 'on-device'
}

/**
 * Unified entry point. Picks the best available ASR tier and transcribes.
 */
export async function transcribe(audio: Float32Array): Promise<TranscriptionResult> {
  const settings = await window.hue.settings.get()
  const tier = resolveTier(settings)
  const t0 = performance.now()
  const text = tier === 'cloud' ? await transcribeCloud(audio) : await transcribeOnDevice(audio)
  return { text, tier, latencyMs: Math.round(performance.now() - t0) }
}
