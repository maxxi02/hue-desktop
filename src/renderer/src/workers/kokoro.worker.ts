import { KokoroTTS, TextSplitterStream } from 'kokoro-js'
import { env, type ProgressInfo } from '@huggingface/transformers'

// The wasm fallback must stay single-threaded (see whisper.worker.ts): with no
// cross-origin isolation there's no SharedArrayBuffer, so numThreads > 1 would
// hang. kokoro-js shares the @huggingface/transformers onnx backend, so this env
// applies here too. WebGPU runs on the GPU and is unaffected — it's preferred below.
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

type Device = 'webgpu' | 'wasm'

type InMessage =
  | { type: 'load' }
  | { type: 'start'; id: number; voice: string; speed: number }
  | { type: 'push'; id: number; text: string }
  | { type: 'end'; id: number }
  | { type: 'cancel'; id: number }

type OutMessage =
  | { type: 'ready'; device: Device }
  | { type: 'progress'; data: ProgressInfo }
  | { type: 'chunk'; id: number; audio: Float32Array; sampleRate: number; text: string }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string }

const post = (msg: OutMessage, transfer?: Transferable[]): void => ctx.postMessage(msg, transfer)
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

let ttsPromise: Promise<KokoroTTS> | null = null
let activeDevice: Device = 'wasm'

function build(device: Device): Promise<KokoroTTS> {
  // WebGPU runs fp32 on the GPU (kokoro-js recommends fp32 for WebGPU): parallel,
  // so synthesis stays ahead of playback and clips butt together gaplessly. The
  // wasm fallback keeps the proven single-threaded q8 path.
  const dtype = device === 'webgpu' ? 'fp32' : 'q8'
  return KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: (data: ProgressInfo) => post({ type: 'progress', data })
  })
}

async function createTTS(): Promise<KokoroTTS> {
  // Pin Kokoro to single-threaded wasm (q8). The fp32 WebGPU path produces
  // distorted, breathy/"whispering" audio — the synthesized voice loses its
  // vocal tone — on many GPUs/drivers via the kokoro-js/transformers.js onnx
  // WebGPU backend, while the wasm q8 path sounds correct. TTS clips are short
  // and the streaming queue tolerates wasm's slower-but-steady synthesis, so we
  // trade a little speed for reliable audio quality. (Whisper ASR still uses
  // WebGPU; see whisper.worker.ts — only the TTS voice is affected by this bug.)
  const t = await build('wasm')
  activeDevice = 'wasm'
  return t
}

function getTTS(): Promise<KokoroTTS> {
  if (!ttsPromise) ttsPromise = createTTS()
  return ttsPromise
}

// Only one streaming utterance is active at a time. `currentId` identifies it;
// stray push/end/cancel for a superseded id are ignored, and the consumer loop
// breaks when it notices it is no longer current.
let currentId = -1
let splitter: TextSplitterStream | null = null

function stopCurrent(): void {
  currentId = -1
  if (splitter) {
    // Closing lets a suspended stream generator terminate instead of hanging on
    // the next sentence.
    try {
      splitter.close()
    } catch {
      // already closed
    }
    splitter = null
  }
}

async function runStream(
  id: number,
  s: TextSplitterStream,
  voice: string,
  speed: number
): Promise<void> {
  let tts: KokoroTTS
  try {
    tts = await getTTS()
  } catch (err) {
    if (currentId === id) post({ type: 'error', id, message: errMsg(err) })
    return
  }
  try {
    const opts = { voice, speed } as unknown as Parameters<typeof tts.stream>[1]
    // kokoro-js's own sentence splitter yields one clip per sentence as it's
    // synthesized — no hand-rolled chunking, so sentences are never sliced.
    for await (const { text, audio } of tts.stream(s, opts)) {
      if (currentId !== id) break // superseded or cancelled
      const samples = audio.audio
      post({ type: 'chunk', id, audio: samples, sampleRate: audio.sampling_rate, text }, [
        samples.buffer
      ])
    }
    if (currentId === id) post({ type: 'done', id })
  } catch (err) {
    if (currentId === id) post({ type: 'error', id, message: errMsg(err) })
  }
}

ctx.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as InMessage

  switch (msg.type) {
    case 'load':
      try {
        await getTTS()
        post({ type: 'ready', device: activeDevice })
      } catch (err) {
        post({ type: 'error', id: -1, message: errMsg(err) })
      }
      return

    case 'start': {
      // A new utterance supersedes any in-flight one. Create the splitter
      // synchronously so push/end that arrive before the model finishes loading
      // are buffered into it.
      stopCurrent()
      currentId = msg.id
      const s = new TextSplitterStream()
      splitter = s
      void runStream(msg.id, s, msg.voice, msg.speed)
      return
    }

    case 'push':
      if (msg.id === currentId && splitter) splitter.push(msg.text)
      return

    case 'end':
      if (msg.id === currentId && splitter) splitter.close()
      return

    case 'cancel':
      if (msg.id === currentId) stopCurrent()
      return
  }
}
