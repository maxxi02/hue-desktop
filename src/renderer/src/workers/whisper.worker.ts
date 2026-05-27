import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo
} from '@huggingface/transformers'

// Minimal worker-scope typing so this file compiles under the DOM lib
// without pulling in the conflicting WebWorker lib.
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent) => void) | null
}
const ctx = self as unknown as WorkerScope

// Always pull the model from the HF hub (no local model files bundled).
env.allowLocalModels = false

// The wasm fallback must stay single-threaded: the app is NOT cross-origin
// isolated (see main/index.ts), so there's no SharedArrayBuffer and any
// numThreads > 1 would make pthread_create fail and hang. WebGPU runs on the GPU
// and is unaffected by this limit — which is why it's the preferred device below.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1
}

const MODEL_ID = 'Xenova/whisper-base.en'

type Device = 'webgpu' | 'wasm'

type InMessage = { type: 'load' } | { type: 'transcribe'; id: number; audio: Float32Array }

type OutMessage =
  | { type: 'ready'; device: Device }
  | { type: 'progress'; data: ProgressInfo }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string }

const post = (msg: OutMessage): void => ctx.postMessage(msg)

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null
let activeDevice: Device = 'wasm'

function build(device: Device): Promise<AutomaticSpeechRecognitionPipeline> {
  // WebGPU runs fp32 on the GPU: parallel (no single-thread cap) and free of the
  // q4/q8 quantization landmines below, since fp32 has no quantized weights at all.
  // The wasm fallback keeps the proven q8 path.
  const dtype = device === 'webgpu' ? 'fp32' : 'q8'
  return pipeline('automatic-speech-recognition', MODEL_ID, {
    dtype,
    device,
    // Disable graph optimization. The onnxruntime-web build bundled with
    // transformers v4 runs the QDQ "TransposeDQWeightsForMatMulNBits" pass at
    // session creation. Whisper's decoder weight-ties embed_tokens to the
    // output projection, and that pass mis-identifies a tied 8-bit DQ weight as a
    // 4-bit MatMulNBits candidate, then aborts because an 8-bit weight has no
    // per-block scale ("Missing required scale ... embed_tokens.weight_merged_0_scale"),
    // so the session never creates. Only 'disabled' skips that basic-level pass.
    session_options: { graphOptimizationLevel: 'disabled' },
    progress_callback: (data: ProgressInfo) => post({ type: 'progress', data })
  }) as Promise<AutomaticSpeechRecognitionPipeline>
}

async function createTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  // Prefer WebGPU. Fall back to single-threaded wasm if there's no GPU adapter or
  // session creation fails (driver quirks, unsupported hardware).
  const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  if (hasWebGpu) {
    try {
      const t = await build('webgpu')
      activeDevice = 'webgpu'
      return t
    } catch (err) {
      console.warn('[whisper] WebGPU init failed, falling back to wasm:', err)
    }
  }
  const t = await build('wasm')
  activeDevice = 'wasm'
  return t
}

function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriberPromise) {
    transcriberPromise = createTranscriber()
  }
  return transcriberPromise
}

ctx.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as InMessage

  if (msg.type === 'load') {
    try {
      await getTranscriber()
      post({ type: 'ready', device: activeDevice })
    } catch (err) {
      post({ type: 'error', id: -1, message: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg.type === 'transcribe') {
    try {
      const transcriber = await getTranscriber()
      // Audio is expected to be mono Float32 @ 16 kHz (Whisper's sample rate).
      const output = await transcriber(msg.audio)
      const text = Array.isArray(output) ? (output[0]?.text ?? '') : (output.text ?? '')
      post({ type: 'result', id: msg.id, text: text.trim() })
    } catch (err) {
      post({
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
