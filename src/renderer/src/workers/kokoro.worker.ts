import { KokoroTTS } from 'kokoro-js'
import { env, type ProgressInfo } from '@huggingface/transformers'

// Force single-threaded onnxruntime-web. See whisper.worker.ts: with no
// cross-origin isolation there's no SharedArrayBuffer, so numThreads > 1 would
// hang. kokoro-js shares the @huggingface/transformers onnx backend, so this
// env applies here too.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1
}

// Minimal worker-scope typing (see whisper.worker.ts for rationale).
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent) => void) | null
}
const ctx = self as unknown as WorkerScope

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

type InMessage =
  | { type: 'load' }
  | { type: 'synth'; id: number; text: string; voice: string; speed: number }

type OutMessage =
  | { type: 'ready' }
  | { type: 'progress'; data: ProgressInfo }
  | { type: 'audio'; id: number; audio: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string }

const post = (msg: OutMessage, transfer?: Transferable[]): void => ctx.postMessage(msg, transfer)
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

let ttsPromise: Promise<KokoroTTS> | null = null

function getTTS(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (data: ProgressInfo) => post({ type: 'progress', data })
    })
  }
  return ttsPromise
}

ctx.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as InMessage

  if (msg.type === 'load') {
    try {
      await getTTS()
      post({ type: 'ready' })
    } catch (err) {
      post({ type: 'error', id: -1, message: errMsg(err) })
    }
    return
  }

  if (msg.type === 'synth') {
    try {
      const tts = await getTTS()
      const opts = { voice: msg.voice, speed: msg.speed } as unknown as Parameters<
        typeof tts.generate
      >[1]
      const audio = await tts.generate(msg.text, opts)
      post({ type: 'audio', id: msg.id, audio: audio.audio, sampleRate: audio.sampling_rate }, [
        audio.audio.buffer
      ])
    } catch (err) {
      post({ type: 'error', id: msg.id, message: errMsg(err) })
    }
  }
}
