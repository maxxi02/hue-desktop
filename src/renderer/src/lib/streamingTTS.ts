export type TtsLoadState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number; file?: string }
  | { status: 'ready'; device?: 'webgpu' | 'wasm' }
  | { status: 'error'; message: string }

type WorkerOut =
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'progress'; data: { status: string; file?: string; progress?: number } }
  | { type: 'chunk'; id: number; audio: Float32Array; sampleRate: number; text: string }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string }

interface StreamHandlers {
  onChunk: (audio: Float32Array, sampleRate: number) => void
  onDone: () => void
  onError: (message: string) => void
}

let worker: Worker | null = null
let nextStreamId = 1
/** Active streaming utterances keyed by id, so worker messages route to the right queue. */
const streams = new Map<number, StreamHandlers>()

let loadState: TtsLoadState = { status: 'idle' }
const loadListeners = new Set<(s: TtsLoadState) => void>()

function setLoadState(s: TtsLoadState): void {
  loadState = s
  loadListeners.forEach((cb) => cb(s))
}

export function onTtsLoadStateChange(cb: (s: TtsLoadState) => void): () => void {
  loadListeners.add(cb)
  cb(loadState)
  return () => loadListeners.delete(cb)
}

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../workers/kokoro.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<WorkerOut>): void => {
    const msg = e.data
    switch (msg.type) {
      case 'ready':
        console.info(`[kokoro] TTS model ready on ${msg.device}`)
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
      case 'chunk':
        streams.get(msg.id)?.onChunk(msg.audio, msg.sampleRate)
        break
      case 'done':
        streams.get(msg.id)?.onDone()
        break
      case 'error':
        if (msg.id === -1) {
          setLoadState({ status: 'error', message: msg.message })
        } else {
          streams.get(msg.id)?.onError(msg.message)
        }
        break
    }
  }
  return worker
}

export function preloadTtsModel(): void {
  if (loadState.status === 'idle' || loadState.status === 'error') {
    setLoadState({ status: 'loading', progress: 0 })
    getWorker().postMessage({ type: 'load' })
  }
}

export interface StreamingTTSQueueOptions {
  voice?: string
  speed?: number
  /** Notified on each state change so the UI can show speaking/idle. */
  onSpeakingChange?: (speaking: boolean) => void
}

/**
 * Streams LLM text to Kokoro and plays the resulting audio gaplessly.
 *
 * Text is pushed into the worker's kokoro-js TextSplitterStream, which yields one
 * audio clip per sentence as it's synthesized — so sentences are never sliced by
 * a hand-rolled chunker. The worker synthesizes ahead of playback (especially on
 * WebGPU), so by the time one clip finishes the next is already here; clips butt
 * together on the audio clock with no gap. Designed to start speaking before the
 * full LLM response is ready and to be interrupted instantly.
 */
export class StreamingTTSQueue {
  private voice: string
  private speed: number
  private onSpeakingChange?: (speaking: boolean) => void

  private id = 0
  private started = false
  /** Set when the worker reports the utterance is fully synthesized ('done'). */
  private streamEnded = false

  private ctx: AudioContext | null = null
  /** Sources scheduled but not yet finished, so interrupt() can stop them all. */
  private sources = new Set<AudioBufferSourceNode>()
  /** Audio-clock time at which the next clip should start, for gapless playback. */
  private nextStartTime = 0
  private speaking = false

  constructor(opts: StreamingTTSQueueOptions = {}) {
    this.voice = opts.voice ?? 'af_heart'
    this.speed = opts.speed ?? 1.05
    this.onSpeakingChange = opts.onSpeakingChange
  }

  /** Feed a chunk of streamed text; the worker splits it into sentences itself. */
  appendText(delta: string): void {
    this.ensureStarted()
    getWorker().postMessage({ type: 'push', id: this.id, text: delta })
  }

  /** Signal the LLM stream has ended so the worker flushes any trailing text. */
  flush(): void {
    if (!this.started) return
    getWorker().postMessage({ type: 'end', id: this.id })
  }

  /** Stop playback immediately and drop everything queued. */
  interrupt(): void {
    if (this.started) {
      getWorker().postMessage({ type: 'cancel', id: this.id })
      streams.delete(this.id)
    }
    this.started = false
    this.streamEnded = false
    for (const src of this.sources) {
      try {
        src.onended = null
        src.stop()
      } catch {
        // already stopped
      }
    }
    this.sources.clear()
    this.nextStartTime = 0
    this.setSpeaking(false)
  }

  // Begin a fresh worker stream. Reused across responses: each new response (the
  // first appendText after the previous one finished) gets its own id and stream.
  private ensureStarted(): void {
    if (this.started) return
    this.started = true
    this.streamEnded = false
    this.id = nextStreamId++
    streams.set(this.id, {
      onChunk: (audio, sampleRate) => this.schedule(audio, sampleRate),
      onDone: () => {
        this.streamEnded = true
        this.maybeFinish()
      },
      onError: () => {
        // A failed sentence shouldn't kill the utterance; end the stream and let
        // whatever already played finish.
        this.streamEnded = true
        this.maybeFinish()
      }
    })
    getWorker().postMessage({ type: 'start', id: this.id, voice: this.voice, speed: this.speed })
  }

  /**
   * Release the audio device. A queue is built per pipeline, i.e. per session,
   * and Chromium caps a document at a handful of AudioContexts — so without this
   * a few start/stop rounds in one app run exhausted them, and the next
   * `new AudioContext()` threw from inside the worker's message handler, leaving
   * TTS permanently silent for the rest of the run.
   */
  dispose(): void {
    this.interrupt()
    const ctx = this.ctx
    this.ctx = null
    if (ctx) void ctx.close().catch(() => {})
  }

  private getCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private schedule(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) {
      this.maybeFinish()
      return
    }
    try {
      this.scheduleChunk(samples, sampleRate)
    } catch (e) {
      // Runs from the worker's onmessage handler, where a throw is an unhandled
      // error rather than a failed sentence. Losing the audio for one chunk is
      // recoverable; losing the handler is not.
      console.warn('[tts] could not schedule an audio chunk:', e)
      this.maybeFinish()
    }
  }

  private scheduleChunk(samples: Float32Array, sampleRate: number): void {
    const ctx = this.getCtx()
    const buf = ctx.createBuffer(1, samples.length, sampleRate)
    buf.getChannelData(0).set(samples)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)

    // Give the first clip of a run a small head start so it doesn't begin
    // mid-buffer (which can click) and the next clip has a moment to arrive.
    if (this.nextStartTime === 0) this.nextStartTime = ctx.currentTime + 0.1
    // Butt this clip up against the previous one on the audio clock. If synthesis
    // fell behind playback, the cursor is in the past, so resume from "now".
    const startAt = Math.max(ctx.currentTime, this.nextStartTime)
    this.nextStartTime = startAt + buf.duration

    src.onended = (): void => {
      this.sources.delete(src)
      this.maybeFinish()
    }
    this.sources.add(src)
    src.start(startAt)
    this.setSpeaking(true)
  }

  // Fall silent and reset for the next response once the worker is done and every
  // scheduled clip has finished playing. Worker messages are ordered, so by the
  // time 'done' arrives every clip has already been scheduled.
  private maybeFinish(): void {
    if (!this.streamEnded || this.sources.size > 0) return
    this.setSpeaking(false)
    if (this.started) streams.delete(this.id)
    this.started = false
    this.streamEnded = false
    this.nextStartTime = 0
  }

  private setSpeaking(value: boolean): void {
    if (this.speaking === value) return
    this.speaking = value
    this.onSpeakingChange?.(value)
  }
}
