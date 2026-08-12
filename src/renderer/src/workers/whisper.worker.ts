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

// `preferWasm` forces the single-threaded wasm/CPU path and skips WebGPU. It's
// set in companion mode (a live call): the call's WebRTC stack is already
// saturating the GPU, so loading an fp32 model onto the same GPU can exhaust
// VRAM and trigger a driver reset (TDR) that freezes the whole machine. Keeping
// ASR on the CPU there leaves the GPU to the call. See useVoiceMode.ts.
type InMessage =
  | { type: 'load'; preferWasm?: boolean }
  // `interim` marks a partial, mid-utterance transcription of the speech so far.
  // It is droppable by definition: another one is along in under a second, and
  // the segment's real transcript is still coming. See the busy check below.
  | { type: 'transcribe'; id: number; audio: Float32Array; interim?: boolean }

type OutMessage =
  | { type: 'ready'; device: Device }
  | { type: 'progress'; data: ProgressInfo }
  | { type: 'result'; id: number; text: string }
  // An interim that arrived while the model was busy and was thrown away rather
  // than queued. Reported instead of silently dropped so the caller's promise
  // settles and its bookkeeping doesn't leak.
  | { type: 'skipped'; id: number }
  | { type: 'error'; id: number; message: string }

const post = (msg: OutMessage): void => ctx.postMessage(msg)

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null
let activeDevice: Device = 'wasm'
// Which device preference the current transcriberPromise was built for, so a
// later load with a different preference (e.g. entering a companion call) can
// tear down the resident model and rebuild on the right device.
let loadedPreferWasm: boolean | null = null

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

async function createTranscriber(preferWasm: boolean): Promise<AutomaticSpeechRecognitionPipeline> {
  // Prefer WebGPU unless the caller asked to stay on the CPU (companion/live-call
  // mode). Fall back to single-threaded wasm if there's no usable GPU adapter or
  // session creation fails (driver quirks, unsupported hardware).
  if (!preferWasm && (await hasUsableWebGpu())) {
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

// `'gpu' in navigator` only tells us the API surface exists — the browser may
// still hand us no adapter (no GPU, blocked driver, headless boot, software
// rasterizer). Without calling requestAdapter() we'd push the fp32 model into a
// non-existent device, which has hung the GPU process on weak/integrated GPUs.
async function hasUsableWebGpu(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    const gpu = (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu
    const adapter = await gpu.requestAdapter()
    return adapter !== null && adapter !== undefined
  } catch {
    return false
  }
}

function getTranscriber(
  preferWasm: boolean = loadedPreferWasm ?? false
): Promise<AutomaticSpeechRecognitionPipeline> {
  // If a model is already loaded for a different device preference, tear it down
  // first. This is what frees the fp32 GPU model's VRAM when a companion call
  // starts after an earlier interviewer session left Whisper resident on WebGPU.
  if (transcriberPromise && loadedPreferWasm !== preferWasm) {
    const old = transcriberPromise
    transcriberPromise = null
    void old.then((t) => (t as { dispose?: () => Promise<void> }).dispose?.()).catch(() => {})
  }
  if (!transcriberPromise) {
    loadedPreferWasm = preferWasm
    transcriberPromise = createTranscriber(preferWasm)
  }
  return transcriberPromise
}

/**
 * Transcriptions run strictly one at a time.
 *
 * Whichever device we end up on, this worker owns a single ONNX session and can
 * only decode one utterance at once: the wasm path is pinned to one thread (see
 * the top of this file), and the WebGPU path shares one queue. Two overlapping
 * `transcriber()` calls would interleave on the same session rather than run in
 * parallel, so work is serialised through this chain instead of being handed to
 * the runtime to sort out.
 */
let chain: Promise<void> = Promise.resolve()
/**
 * Whether a transcription is running *or already scheduled*. Incremented
 * synchronously on receipt, so an interim that lands while the previous one is
 * still decoding is skipped rather than queued.
 *
 * Interims must never queue behind each other: a backlog would push the
 * *final* transcript — the one the answer is actually generated from — behind a
 * pile of stale partials and make the app slower, which is the exact opposite of
 * what speculation is for. A skipped interim costs nothing; the next one covers
 * the same audio plus more.
 */
let outstanding = 0

async function runTranscription(id: number, audio: Float32Array): Promise<void> {
  try {
    const transcriber = await getTranscriber()
    // Audio is expected to be mono Float32 @ 16 kHz (Whisper's sample rate).
    const output = await transcriber(audio)
    const text = Array.isArray(output) ? (output[0]?.text ?? '') : (output.text ?? '')
    post({ type: 'result', id, text: text.trim() })
  } catch (err) {
    post({
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

ctx.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as InMessage

  if (msg.type === 'load') {
    try {
      await getTranscriber(msg.preferWasm ?? false)
      post({ type: 'ready', device: activeDevice })
    } catch (err) {
      post({ type: 'error', id: -1, message: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg.type === 'transcribe') {
    if (msg.interim && outstanding > 0) {
      post({ type: 'skipped', id: msg.id })
      return
    }
    // Finals are never dropped: if an interim is mid-decode, the final waits for
    // it (one interim at most, so the wait is bounded by a single decode).
    outstanding++
    chain = chain
      .then(() => runTranscription(msg.id, msg.audio))
      .finally(() => {
        outstanding--
      })
  }
}
