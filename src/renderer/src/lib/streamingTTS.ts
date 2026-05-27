export type TtsLoadState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number; file?: string }
  | { status: 'ready' }
  | { status: 'error'; message: string }

interface SynthResult {
  audio: Float32Array
  sampleRate: number
}

type WorkerOut =
  | { type: 'ready' }
  | { type: 'progress'; data: { status: string; file?: string; progress?: number } }
  | { type: 'audio'; id: number; audio: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: SynthResult) => void; reject: (e: Error) => void }>()

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
        setLoadState({ status: 'ready' })
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
      case 'audio':
        pending.get(msg.id)?.resolve({ audio: msg.audio, sampleRate: msg.sampleRate })
        pending.delete(msg.id)
        break
      case 'error':
        if (msg.id === -1) {
          setLoadState({ status: 'error', message: msg.message })
        } else {
          pending.get(msg.id)?.reject(new Error(msg.message))
          pending.delete(msg.id)
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

function synthesize(text: string, voice: string, speed: number): Promise<SynthResult> {
  const w = getWorker()
  const id = nextId++
  return new Promise<SynthResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ type: 'synth', id, text, voice, speed })
  })
}

export interface StreamingTTSQueueOptions {
  voice?: string
  speed?: number
  /** Notified on each state change so the UI can show speaking/idle. */
  onSpeakingChange?: (speaking: boolean) => void
}

// Chunking targets (characters). Each chunk is flushed at a sentence boundary
// once it passes CHUNK_TARGET, so chunks stay small and roughly uniform. Two
// competing failure modes: feeding Kokoro very tiny fragments ("Yes." "Okay,")
// makes the voice choppy (each gets its own intonation + a seam), while letting
// a chunk grow large makes its synthesis take longer than the previous chunk's
// playback — and on a single-threaded CPU that means the synthesizer falls
// behind and you get an audible gap at the boundary. Small, uniform chunks let
// synthesis stay ahead of playback so clips butt together gaplessly. CHUNK_TARGET
// only groups consecutive *short* sentences; the HARD_MAX caps bound latency when
// a "sentence" runs on without any terminator.
const CHUNK_TARGET = 90
const FIRST_HARD_MAX = 120
const HARD_MAX = 200

/**
 * Accepts streaming LLM text, flushes complete sentences to Kokoro TTS, and
 * plays the resulting audio clips back-to-back. Designed to start speaking
 * before the full LLM response is ready, and to be interrupted instantly.
 */
export class StreamingTTSQueue {
  private voice: string
  private speed: number
  private onSpeakingChange?: (speaking: boolean) => void

  private buffer = '' // text not yet forming a flushable chunk
  private textQueue: string[] = [] // chunks awaiting synthesis
  private synthesizing = false
  private speaking = false
  /** Whether we've already flushed a chunk this response. The first chunk is
   *  flushed eagerly (one sentence) for a fast start; later ones are grouped. */
  private hasFlushed = false

  private ctx: AudioContext | null = null
  /** Sources scheduled but not yet finished, so interrupt() can stop them all. */
  private sources = new Set<AudioBufferSourceNode>()
  /** Audio-clock time at which the next clip should start, for gapless playback. */
  private nextStartTime = 0
  /** Bumped on interrupt to invalidate any in-flight synthesis/playback. */
  private generation = 0

  /** Synthesized clips that are ready but not yet scheduled. Playback starts on
   *  the first clip; thereafter the synthesizer runs ahead of the speaker (short,
   *  uniform chunks synthesize faster than they play), so by the time one clip
   *  finishes the next is already here and waiting — no pause after a sentence. */
  private readyClips: SynthResult[] = []
  /** True once we've begun scheduling clips (the initial lead has been built). */
  private playing = false
  /** True once the text stream has ended (flush), so we play whatever we have. */
  private ended = false

  constructor(opts: StreamingTTSQueueOptions = {}) {
    this.voice = opts.voice ?? 'af_heart'
    this.speed = opts.speed ?? 1.05
    this.onSpeakingChange = opts.onSpeakingChange
  }

  /** Feed a chunk of streamed text; complete sentences are flushed automatically. */
  appendText(delta: string): void {
    this.buffer += delta
    let cut = this.findCut(this.buffer)
    while (cut > 0) {
      const chunk = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut)
      if (chunk) this.enqueue(chunk)
      cut = this.findCut(this.buffer)
    }
  }

  /** Flush any remaining buffered text (call when the LLM stream ends). */
  flush(): void {
    const chunk = this.buffer.trim()
    this.buffer = ''
    if (chunk) this.enqueue(chunk)
    // No more text is coming, so stop waiting to build a lead — play what we have.
    this.ended = true
    this.drainReady()
  }

  /** Stop playback immediately and drop everything queued. */
  interrupt(): void {
    this.generation++
    this.textQueue = []
    this.buffer = ''
    this.hasFlushed = false
    this.synthesizing = false
    this.readyClips = []
    this.playing = false
    this.ended = false
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

  /** Returns the position to cut a flushable chunk, or -1 if none yet. */
  private findCut(s: string): number {
    // Prefer to cut at a sentence boundary. The lookahead (?=\s|$) means a dot
    // only counts when followed by whitespace or end-of-text, so decimals like
    // "3.5" don't trigger a false cut. Group sentences until CHUNK_TARGET, but
    // flush the very first sentence immediately so speech starts without delay.
    const re = /[.!?]+(?=\s|$)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) {
      const end = m.index + m[0].length
      if (!this.hasFlushed || end >= CHUNK_TARGET) return this.skipSpace(s, end)
    }

    // No flushable sentence boundary yet. Only force a cut once the buffer grows
    // past the cap, and break at a clause (comma/semicolon) or word boundary so
    // we never slice a word in half (which would mangle pronunciation).
    const hardMax = this.hasFlushed ? HARD_MAX : FIRST_HARD_MAX
    if (s.length >= hardMax) {
      const clause = Math.max(s.lastIndexOf(', ', hardMax), s.lastIndexOf('; ', hardMax))
      if (clause > 40) return clause + 2
      const space = s.lastIndexOf(' ', hardMax)
      return space > 40 ? space + 1 : hardMax
    }
    return -1
  }

  /** Advance past whitespace so the next chunk doesn't begin with a leading space. */
  private skipSpace(s: string, i: number): number {
    while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\t')) i++
    return i
  }

  private enqueue(chunk: string): void {
    this.hasFlushed = true
    this.textQueue.push(chunk)
    void this.pump()
  }

  // Synthesis pump: converts queued text to audio *ahead* of playback, scheduling
  // each clip on the audio timeline the moment it's ready. Running synthesis ahead
  // of (rather than interleaved with) playback is what keeps speech gapless — the
  // next clip is being prepared while the current one is still playing.
  private async pump(): Promise<void> {
    if (this.synthesizing) return
    this.synthesizing = true
    const gen = this.generation
    try {
      while (this.textQueue.length > 0) {
        const chunk = this.textQueue.shift() as string
        let result: SynthResult
        try {
          result = await synthesize(chunk, this.voice, this.speed)
        } catch {
          continue // skip a failed clip rather than stalling the whole response
        }
        if (gen !== this.generation) return // interrupted; a newer pump owns the flag now
        this.readyClips.push(result)
        this.drainReady()
      }
    } finally {
      // Only clear the flag if we still own it — an interrupt + re-enqueue during
      // our await may have handed ownership to a newer pump.
      if (gen === this.generation) this.synthesizing = false
    }
  }

  // Start (or continue) playback. We start the moment the first clip is ready so
  // speech begins as soon as possible (waiting for a second clip added seconds of
  // dead air before the first word). Keeping chunks small and uniform is what
  // prevents a pause at the next period: the next clip finishes synthesizing
  // before the current one ends, so once playing, every ready clip is scheduled
  // right away and butts gaplessly onto the audio timeline.
  private drainReady(): void {
    if (!this.playing) {
      if (this.readyClips.length < 1 && !this.ended) return
      this.playing = true
    }
    while (this.readyClips.length > 0) {
      const clip = this.readyClips.shift() as SynthResult
      this.schedule(clip.audio, clip.sampleRate)
    }
  }

  private getCtx(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private schedule(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return
    const ctx = this.getCtx()
    const buf = ctx.createBuffer(1, samples.length, sampleRate)
    buf.getChannelData(0).set(samples)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)

    // Give the first clip of a run a small head start so it doesn't begin
    // mid-buffer (which can click) and the next clip has a moment to synthesize.
    if (this.nextStartTime === 0) this.nextStartTime = ctx.currentTime + 0.1
    // Butt this clip up against the previous one on the audio clock. If synthesis
    // fell behind playback, the cursor is in the past, so resume from "now".
    const startAt = Math.max(ctx.currentTime, this.nextStartTime)
    this.nextStartTime = startAt + buf.duration

    src.onended = (): void => {
      this.sources.delete(src)
      // Only fall silent once nothing more is queued, synthesizing, or scheduled.
      if (
        this.sources.size === 0 &&
        this.readyClips.length === 0 &&
        this.textQueue.length === 0 &&
        !this.synthesizing
      ) {
        this.setSpeaking(false)
        // Reset for the next response so it rebuilds its own lead from scratch.
        this.playing = false
        this.ended = false
        this.hasFlushed = false
        this.nextStartTime = 0
      }
    }
    this.sources.add(src)
    src.start(startAt)
    this.setSpeaking(true)
  }

  private setSpeaking(value: boolean): void {
    if (this.speaking === value) return
    this.speaking = value
    this.onSpeakingChange?.(value)
  }
}
