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

// Force single-threaded onnxruntime-web. The app is NOT cross-origin isolated
// (see main/index.ts), so there's no SharedArrayBuffer and any numThreads > 1
// would make pthread_create fail and hang. Pinning to 1 keeps inference purely
// single-threaded — slower than threaded, but it never freezes the UI and works
// without cross-origin isolation.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1
}

const MODEL_ID = 'Xenova/whisper-base.en'

type InMessage = { type: 'load' } | { type: 'transcribe'; id: number; audio: Float32Array }

type OutMessage =
  | { type: 'ready' }
  | { type: 'progress'; data: ProgressInfo }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string }

const post = (msg: OutMessage): void => ctx.postMessage(msg)

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null

function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', MODEL_ID, {
      // Force q8 for EVERY module (a single string applies to all files) and pin
      // the device so dtype resolution is fully deterministic.
      dtype: 'q8',
      device: 'wasm',
      // Disable graph optimization. The onnxruntime-web build bundled with
      // transformers v4 runs the QDQ "TransposeDQWeightsForMatMulNBits" pass at
      // session creation. Whisper's decoder weight-ties embed_tokens to the
      // output projection, and that pass mis-identifies the tied 8-bit DQ weight
      // as a 4-bit MatMulNBits candidate, then aborts because an 8-bit weight has
      // no per-block scale ("Missing required scale ...
      // embed_tokens.weight_merged_0_scale"), so the session never creates. The
      // pass runs at the basic optimization level, so only 'disabled' skips it;
      // the q8 ops then just execute unfused (correct, slightly slower load).
      session_options: { graphOptimizationLevel: 'disabled' },
      progress_callback: (data: ProgressInfo) => post({ type: 'progress', data })
    }) as Promise<AutomaticSpeechRecognitionPipeline>
  }
  return transcriberPromise
}

ctx.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as InMessage

  if (msg.type === 'load') {
    try {
      await getTranscriber()
      post({ type: 'ready' })
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
