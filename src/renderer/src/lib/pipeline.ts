import { MicVAD } from '@ricky0123/vad-web'
import { transcribe, transcribeInterim } from './transcription'
import { parseProfileBundle } from '../../../shared/profile'
import {
  buildSystemPrompt,
  captureInstruction,
  stripCaptureImage
} from '../../../shared/prompt'
import { StreamingTTSQueue } from './streamingTTS'
import { groundResponse, stripStreamingCitation, type Grounding } from '../../../shared/grounding'
import {
  assessmentRouting,
  captureRouting,
  looksLikeCodingQuestion
} from '../../../shared/assessment'
import { isFillerOnly } from '../../../shared/filler'
import { EndpointBuffer } from '../../../shared/endpointing'
import {
  SpeculationScheduler,
  type Command as SpeculationCommand,
  type Speaker
} from '../../../shared/speculation'
import type {
  HueSettings,
  LlmMessage,
  LlmContentBlock,
  LlmDeltaEvent,
  LlmDoneEvent,
  LlmErrorEvent,
  ResolvedTier,
  ScreenCapture
} from '@shared/types'

export type PipelineState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'

export interface PipelineCallbacks {
  onStateChange?: (state: PipelineState) => void
  onUserTranscript?: (text: string, tier: ResolvedTier, latencyMs: number) => void
  /** Fired when a screen capture has been taken and attached as the user's turn. */
  onScreenCapture?: (capture: ScreenCapture) => void
  /** Fired as the assistant response streams in (cumulative text). */
  onAssistantText?: (text: string) => void
  /**
   * Fired once, when a response has finished arriving whole.
   *
   * Carries the grounding receipt, which is why it cannot be folded into
   * onAssistantText: the `story_id` is the last thing the model writes, so a
   * partial stream always parses as "no citation" and would flash the ungrounded
   * warning on every answer before withdrawing it. `grounding` is null when a
   * receipt is not meaningful for the turn — see resolveTurnGrounding.
   */
  onAssistantComplete?: (text: string, grounding: Grounding | null) => void
  onError?: (message: string) => void
}

/** The VAD (and Whisper) sample rate; every buffer below is mono Float32 at this rate. */
const SAMPLE_RATE = 16000

/**
 * How much *new* speech has to arrive before another interim transcription runs.
 *
 * The tradeoff is straight latency against wasted decode. Shorter than this and
 * consecutive interims mostly re-decode the same audio for a word or two of new
 * text, and — because the worker runs one transcription at a time — that decode
 * is time the *final* transcript may have to wait for. Longer, and the draft
 * starts later, which is the latency this whole feature exists to remove. Around
 * 800 ms is also roughly how long whisper-base takes to decode a few seconds of
 * speech on the CPU path companion mode pins it to, so the model stays busy
 * without ever building a backlog.
 */
const INTERIM_INTERVAL_MS = 800

/**
 * Speech accumulated before the first interim is attempted.
 *
 * Whisper on a fragment shorter than this mostly emits punctuation, a hallucinated
 * "Thank you.", or one word — text the scheduler would rightly refuse to fire on
 * anyway, so decoding it is pure waste.
 */
const INTERIM_MIN_SPEECH_MS = 1500

/**
 * Ceiling on the audio retained for interim transcription — Whisper's own
 * context window, so trimming past it discards only audio the model could not
 * attend to anyway.
 *
 * A VAD segment is normally one sentence, but nothing guarantees it: a talkative
 * interviewer or a noisy line can hold the gate open for minutes, and this
 * buffer is copied whole and transferred to the worker on every interim tick.
 * Unbounded, that is the one allocation in the session that grows with time.
 */
const INTERIM_MAX_SAMPLES = 30 * SAMPLE_RATE

/**
 * How many past messages travel with each request — roughly a dozen
 * question/answer exchanges, which is more conversational thread than any single
 * answer actually draws on, and far short of any provider's context limit.
 */
const MAX_HISTORY_MESSAGES = 24

/**
 * How often the scheduler is told that time has passed.
 *
 * Its trigger requires the interim text to be *stable* for 400 ms, and stability
 * is the absence of an event — with interims arriving only every ~800 ms,
 * nothing would ever observe it without a tick. Runs only while a speech segment
 * is open.
 */
const SPECULATION_TICK_MS = 150

/**
 * Orchestrates the full voice loop: VAD detects an utterance -> ASR transcribes
 * it -> Claude streams a reply -> reply is spoken via streaming TTS. Speaking
 * while the assistant talks barges in (aborts the reply and stops audio).
 */
export class VoicePipeline {
  private vad: MicVAD | null = null
  private tts: StreamingTTSQueue
  private settings: HueSettings
  private callbacks: PipelineCallbacks

  private state: PipelineState = 'idle'
  private messages: LlmMessage[] = []
  private currentStreamId: string | null = null
  private assistantText = ''
  private unsubscribe: Array<() => void> = []

  /**
   * The full getDisplayMedia stream backing system/loopback audio. We hand the
   * VAD an audio-only stream but must keep this (with its live video track)
   * referenced for the whole session — Chromium binds the loopback audio to the
   * desktop-capture session the video track represents, so if that track is
   * stopped or garbage-collected the audio goes silent. Stopped in stop().
   */
  private systemStream: MediaStream | null = null

  /**
   * Index into `messages` of a screen-capture turn whose image is still attached
   * and awaiting its first answer. Once Hue replies, the image is stripped (it
   * would otherwise be re-sent in full on every later turn). null when none pends.
   */
  private pendingCaptureIndex: number | null = null

  /**
   * Whether the in-flight response is an assessment answer.
   *
   * Set per question by `assessmentRouting`, and read in two places that run
   * later than the decision: `startResponse`, which puts the role on the wire,
   * and `buildSystemPrompt`, which picks the shape. Held on the instance rather
   * than threaded through every call site because the commit path adopts a
   * stream started before the final transcript existed.
   */
  private currentAssessment = false

  /**
   * The last *spoken* question, kept so the user can re-answer it the other way.
   *
   * Null after a screen capture, and that is the point rather than an oversight.
   * `stripCaptureImage` drops the PNG once Hue has answered it, so re-running a
   * capture would send the model a turn whose image is gone and get a confident
   * answer about nothing. Refusing is the honest failure; silently answering a
   * question the model can no longer see is not.
   */
  private lastSpokenQuestion: string | null = null

  /**
   * Whether Hue's responses are spoken aloud. True in interviewer mode (Hue asks
   * questions out loud). False in companion mode — the response is a suggested
   * answer shown as text, so speaking it would talk over the user or be heard by
   * the real interviewer.
   */
  private readonly speakResponses: boolean

  /**
   * Whether the *current* in-flight response should be spoken. Defaults to
   * speakResponses, but screen-capture answers force it off — they're typically
   * long/code-heavy and meant to be read, not read aloud.
   */
  private currentSpeak = false

  /**
   * The speculation scheduler, or null when speculative drafting is off.
   *
   * Companion mode only, and only when the user opted in. In interviewer mode
   * the incoming voice is the *user's* (see speakerOfIncomingSpeech), and the
   * scheduler would correctly refuse to do anything with it — but not
   * constructing it at all keeps the per-frame audio bookkeeping off the hot
   * path entirely for every session that isn't using this.
   */
  private scheduler: SpeculationScheduler | null = null

  /** The in-flight speculative LLM stream, if any. Never `currentStreamId`. */
  private specStreamId: string | null = null
  /** The scheduler's id for that stream — the guard that stale deltas are tested against. */
  private specId: number | null = null
  /** Draft text accumulated so far. Held back from the UI until the draft commits. */
  private specText = ''
  /** True once the speculative stream finished on its own, before the final arrived. */
  private specFinished = false

  /**
   * Holds a finished segment briefly so a mid-sentence pause cannot split one
   * question into two.
   *
   * Companion mode only, where the incoming voice is the interviewer's and there
   * is a question to assemble. In interviewer mode the incoming voice is the
   * user answering, and joining their segments would only delay a turn nothing
   * is generated from.
   */
  private endpoint: EndpointBuffer | null = null
  /** The pending hold. Cleared by a continuation, by expiry, and by teardown. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null

  /** Speech captured since the VAD opened this segment, for interim transcription. */
  private speechFrames: Float32Array[] = []
  /** Cumulative samples in this segment. Drives the interim cadence. */
  private speechSamples = 0
  /** Samples actually retained in `speechFrames` — bounded, unlike the above. */
  private bufferedSamples = 0
  private samplesAtLastInterim = 0
  private interimInFlight = false
  private speechActive = false
  private tickTimer: ReturnType<typeof setInterval> | null = null

  constructor(settings: HueSettings, callbacks: PipelineCallbacks = {}) {
    this.settings = settings
    this.callbacks = callbacks
    this.speakResponses = settings.hueMode === 'interviewer'
    if (settings.speculativeDrafting && settings.hueMode === 'companion') {
      this.scheduler = new SpeculationScheduler()
    }
    // Independent of the scheduler on purpose: a split question is answered
    // wrongly whether or not speculation is on, so the repair must not be
    // something a user turns off with the drafting toggle.
    if (settings.hueMode === 'companion') this.endpoint = new EndpointBuffer()
    this.tts = new StreamingTTSQueue({
      voice: settings.ttsVoice,
      speed: settings.ttsSpeed
    })
  }

  async start(): Promise<void> {
    if (this.vad) return

    // Surface the loading phase immediately: model downloads + VAD init can take
    // a while on the first run, and the UI should reflect that rather than look dead.
    this.setState('connecting')

    // Listen for streamed LLM tokens once; filter by the active streamId.
    this.unsubscribe.push(
      window.hue.llm.onDelta((e: LlmDeltaEvent) => this.onLlmDelta(e)),
      window.hue.llm.onDone((e: LlmDoneEvent) => this.onLlmDone(e)),
      window.hue.llm.onError((e: LlmErrorEvent) => this.onLlmError(e))
    )

    // vad-web resolves its VAD model + onnxruntime wasm against these base paths.
    // If they're unset it falls back to a CDN / the host page, which in this
    // Electron renderer never resolves — MicVAD.new() then hangs forever, leaving
    // the session stuck on "connecting" with a wedged UI. Point both at our
    // bundled, version-matched assets (in public/, served at the renderer root)
    // so the model and wasm load locally. Works in dev (http) and packaged (file).
    const assetBase = new URL('./', window.location.href).href

    // Everything from here on acquires something that has to be given back. A
    // throw past this point used to escape start() with the LLM listeners still
    // registered and — worse — the desktop-capture session still live, video
    // track and all: the OS "sharing your screen" indicator stayed on, and the
    // caller had already dropped its reference to this pipeline, so nothing
    // could ever stop it. Each retry stacked another one.
    try {
      await this.startCapture(assetBase)
    } catch (e) {
      await this.releaseAfterFailedStart()
      throw e
    }
  }

  /** The acquiring half of `start()`. Separated so its failure has one owner. */
  private async startCapture(assetBase: string): Promise<void> {
    this.vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: assetBase,
      onnxWASMBasePath: assetBase,
      ortConfig: (ort) => {
        // Single-threaded WASM. onnxruntime-web only ships a threaded build, and
        // if it ever sees SharedArrayBuffer (cross-origin isolation) it spawns one
        // busy-waiting thread per core and freezes the window on startup. We keep
        // isolation OFF (see main/index.ts) and pin numThreads=1 so it runs purely
        // single-threaded. The Silero v5 model is tiny, so per-frame inference on
        // the VAD thread is fast enough.
        ort.env.wasm.numThreads = 1
        // Do NOT set ort.env.wasm.proxy = true here. The Silero VAD is stateful:
        // it feeds recurrent state tensors back into session.run() every frame.
        // In proxy mode onnxruntime transfers (detaches) the input ArrayBuffers
        // to the proxy worker, so the reused state buffer is already detached on
        // the next frame, throwing "ArrayBuffer is already detached" and killing
        // the VAD loop — after which the app never hears the user.
        ort.env.logLevel = 'error'
      },
      redemptionMs: 700,
      minSpeechMs: 250,
      preSpeechPadMs: 300,
      getStream: () => this.getStream(),
      onSpeechStart: () => this.onSpeechStart(),
      onSpeechEnd: (audio) => void this.onSpeechEnd(audio),
      // Every frame the VAD sees, speech or not. This is the only place the
      // audio of an utterance is available *while it is still being spoken* —
      // onSpeechEnd fires once, at the end, which is exactly the latency
      // speculation exists to remove. Returns immediately when speculation is
      // off or no segment is open.
      onFrameProcessed: (_probs, frame) => this.onFrame(frame),
      onVADMisfire: () => {
        // A misfire while a question is held is the case that must not simply
        // reset. onSpeechStart already cancelled the hold expiry on the
        // assumption this segment was the continuation, and a misfire means no
        // final is coming from it — so the held question has no timer left and
        // would sit there unanswered forever. The misfire is the evidence that
        // no continuation arrived, which is exactly what the expiry was waiting
        // to learn, so resolve the held question now rather than dropping it.
        const held = this.endpoint?.onHoldExpired(Date.now())
        this.clearHoldTimer()
        this.endSegment()
        if (held) {
          this.resolveQuestion(held.text)
          return
        }
        // Nothing held: the ordinary misfire. The segment produced no final, so
        // nothing will ever arrive to commit or discard a draft fired from it.
        // Tear it down here or it stays in flight forever, blocking every later
        // question (one draft, ever).
        this.discardSpeculation()
        this.scheduler?.reset()
        if (this.state === 'transcribing') this.setState('listening')
      }
    })

    this.vad.start()
    this.setState('listening')

    // In interviewer mode Hue leads, so open with the first question instead of
    // waiting for the user to speak. Companion mode waits for the interviewer.
    if (this.settings.hueMode === 'interviewer') this.kickoffInterview()
  }

  /**
   * Give back everything a partially-completed `start()` acquired. Best-effort by
   * design: this runs while an error is already propagating, and a throw in here
   * would replace the real cause with a teardown detail.
   */
  private async releaseAfterFailedStart(): Promise<void> {
    try {
      if (this.vad) {
        await this.vad.destroy()
        this.vad = null
      }
    } catch (e) {
      console.warn('[pipeline] VAD teardown after a failed start:', e)
    }
    if (this.systemStream) {
      this.systemStream.getTracks().forEach((t) => t.stop())
      this.systemStream = null
    }
    this.unsubscribe.forEach((u) => {
      try {
        u()
      } catch {
        // Nothing useful to do; the point is that the rest still unsubscribe.
      }
    })
    this.unsubscribe = []
    this.endSegment()
    this.clearHoldTimer()
    this.endpoint?.reset()
    this.setState('idle')
  }

  /** Resolve the audio source the VAD listens to (mic vs system/call audio). */
  private async getStream(): Promise<MediaStream> {
    if (this.settings.audioSource === 'system') {
      // getDisplayMedia routes to the main-process loopback handler. Chromium
      // requires a video track to be requested even for audio-only capture. We
      // ask for a 1fps video track to keep capture cost negligible. No echo
      // cancellation here — it's a clean digital tap, not a microphone.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: true
      })
      const audioTracks = display.getAudioTracks()
      if (audioTracks.length === 0) {
        display.getTracks().forEach((t) => t.stop())
        throw new Error(
          'No system audio was captured. System-audio loopback is supported on Windows; on other platforms use the microphone source.'
        )
      }
      // The loopback audio is bound to the desktop-capture session that the video
      // track represents: if that track is stopped — or garbage-collected because
      // nothing references it — Chromium tears the session down and the audio goes
      // silent, so the VAD hears nothing (the orb never reacts). Keep the FULL
      // stream (live video track included) referenced for the whole session, and
      // hand the VAD only an audio-only stream so its MediaStreamSource gets a
      // clean tap. systemStream is stopped in stop().
      this.systemStream = display
      return new MediaStream(audioTracks)
    }
    // Microphone. Echo cancellation keeps Hue's own spoken audio (interviewer
    // mode) from leaking back into the mic and falsely triggering a barge-in.
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
  }

  async stop(): Promise<void> {
    this.abortResponse()
    // The queue owns an AudioContext, and a new one is built per session — they
    // have to be handed back or a handful of start/stop rounds exhausts the
    // per-document limit and TTS goes silent for the rest of the app run.
    this.tts.dispose()
    this.endSegment()
    this.clearHoldTimer()
    this.endpoint?.reset()
    // Session-end metrics.
    //
    // `hitRate` is computed on every fire and has never been read. Its own
    // comment says to tune the trigger against this number rather than against
    // intuition, and speculation now ships on by default, so the number has to
    // be visible before anyone touches `minWords` or `stableMs`. Below ~55% the
    // trigger is too eager and margin is burning for nothing.
    if (this.scheduler) {
      const m = this.scheduler.metrics
      console.info(
        `[speculation] questions=${m.questions} fired=${m.fired} committed=${m.committed} ` +
          `aborted=${m.aborted} hitRate=${(m.hitRate * 100).toFixed(0)}% ` +
          `firesPerQuestion=${m.firesPerQuestion.toFixed(2)}`
      )
    }
    this.scheduler?.reset()
    if (this.vad) {
      await this.vad.destroy()
      this.vad = null
    }
    // vad.destroy() only stops the audio-only stream we handed it; the loopback's
    // backing display stream (with its video track) is ours to tear down.
    if (this.systemStream) {
      this.systemStream.getTracks().forEach((t) => t.stop())
      this.systemStream = null
    }
    this.unsubscribe.forEach((u) => u())
    this.unsubscribe = []
    this.setState('idle')
  }

  getState(): PipelineState {
    return this.state
  }

  /**
   * Wipe the conversation history so the next turn starts with a clean slate.
   * Aborts any in-flight reply first (and stops its audio) so a streaming
   * response can't repopulate the history we just cleared. Safe to call whether
   * or not a session is running.
   */
  clearHistory(): void {
    this.abortResponse()
    this.endSegment()
    this.clearHoldTimer()
    this.endpoint?.reset()
    this.scheduler?.reset()
    this.messages = []
    this.assistantText = ''
    this.pendingCaptureIndex = null
    if (this.vad) this.setState('listening')
  }

  private setState(state: PipelineState): void {
    if (this.state === state) return
    this.state = state
    this.callbacks.onStateChange?.(state)
  }

  private onSpeechStart(): void {
    // Barge-in: the user started talking over the assistant.
    if (this.state === 'thinking' || this.state === 'speaking') {
      this.abortResponse()
    }
    // Speech inside the hold is the back half of the question already held, not
    // a new one. Cancel the pending expiry and let this segment join it.
    if (this.endpoint?.onSpeechStart(Date.now())) this.clearHoldTimer()
    this.beginSegment()
  }

  /**
   * Drop any pending hold expiry.
   *
   * A timer that outlives its session fires an answer into a stopped pipeline,
   * so every teardown path calls this.
   */
  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
  }

  private async onSpeechEnd(audio: Float32Array): Promise<void> {
    this.endSegment()
    this.setState('transcribing')
    let text: string
    try {
      const res = await transcribe(audio, this.settings)
      text = res.text
      if (text) this.callbacks.onUserTranscript?.(text, res.tier, res.latencyMs)
    } catch (e) {
      this.callbacks.onError?.(e instanceof Error ? e.message : String(e))
      this.setState('listening')
      return
    }

    if (!text) {
      this.setState('listening')
      return
    }

    // A hesitation is not a question.
    //
    // The VAD segments on silence, so an interviewer pausing to think produces
    // a complete segment reading "um" and nothing else. The transcript callback
    // above has already run, so the utterance still appears on screen — the
    // user can see what the mic heard — but nothing is generated for it.
    //
    // This sits BEFORE the scheduler, not inside `onFinal`, and both halves of
    // that matter. An empty return from `onFinal` already means "declined the
    // turn" and is deliberately answered anyway by the fall-through below, so a
    // filler signalled that way would still reach the model. And gating here
    // covers the unspeculated path too, which does not consult the scheduler at
    // all.
    //
    // Leaving the scheduler untouched is correct rather than merely convenient:
    // an "um" in the middle of a question does not end the question, so the
    // draft in flight (if any) should survive it and be resolved by the real
    // final that follows. A filler segment can never have fired a draft of its
    // own — `maybeFire` requires `minWords` of them.
    if (isFillerOnly(text)) {
      this.setState('listening')
      return
    }

    // The question may not be over. Hold this segment; if speech resumes inside
    // the hold, onSpeechStart cancels the expiry and the next final joins it.
    if (this.endpoint) {
      const decision = this.endpoint.onSegmentFinal(text, Date.now())
      this.clearHoldTimer()
      if (decision.kind === 'complete') {
        this.resolveQuestion(decision.text)
        return
      }
      this.holdTimer = setTimeout(
        () => {
          this.holdTimer = null
          const done = this.endpoint?.onHoldExpired(Date.now())
          if (done) this.resolveQuestion(done.text)
        },
        Math.max(0, decision.until - Date.now())
      )
      return
    }

    this.resolveQuestion(text)
  }

  /**
   * The question is genuinely over: generate against it.
   *
   * Split out of `onSpeechEnd` so the endpoint hold can call it later, once it
   * knows no continuation is coming.
   */
  private resolveQuestion(text: string): void {
    if (this.scheduler) {
      const commands = this.scheduler.onFinal(text, this.speakerOfIncomingSpeech(), Date.now())
      if (commands.length > 0) {
        this.applyFinalCommands(commands, text)
        return
      }
      // Empty means the scheduler declined the turn entirely (self speech). It
      // cannot happen while the scheduler is companion-only, but falling through
      // to the plain path is the safe reading if that ever changes: a question
      // answered late beats a question dropped.
    }

    this.messages.push({ role: 'user', content: text })
    this.lastSpokenQuestion = text
    const routing = assessmentRouting(this.settings, text)
    this.currentAssessment = routing.assessment
    // ANDed, never replaced: `speak` from routing is a permission to speak, and
    // `speakResponses` is whether this session speaks at all. Companion mode
    // stays silent on both kinds of answer.
    this.startResponse({
      speak: this.speakResponses && routing.speak,
      maxTokens: routing.maxTokens
    })
  }

  // ── Speculation ─────────────────────────────────────────────────────────

  /**
   * Whose voice the VAD is picking up, in the scheduler's vocabulary.
   *
   * The single most important mapping in this wiring. In companion mode the
   * incoming audio is the *interviewer* (either the call's loopback or the room
   * mic pointed at them) and Hue's job is to answer it. In interviewer mode Hue
   * is the one asking, so the incoming voice is the user answering — `self`,
   * which the scheduler refuses to draft against. Getting this backwards makes
   * Hue transcribe the user mid-answer and draft a reply to itself.
   */
  private speakerOfIncomingSpeech(): Speaker {
    return this.settings.hueMode === 'companion' ? 'interviewer' : 'self'
  }

  /** A speech segment opened: start accumulating audio and ticking the scheduler. */
  private beginSegment(): void {
    if (!this.scheduler) return
    this.speechActive = true
    this.speechFrames = []
    this.speechSamples = 0
    this.bufferedSamples = 0
    this.samplesAtLastInterim = 0
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => {
        if (!this.scheduler) return
        this.applyInterimCommands(this.scheduler.onTick(Date.now()))
      }, SPECULATION_TICK_MS)
    }
  }

  /** The segment closed (end of speech, misfire, or shutdown). Stops all interim work. */
  private endSegment(): void {
    this.speechActive = false
    this.speechFrames = []
    this.speechSamples = 0
    this.bufferedSamples = 0
    this.samplesAtLastInterim = 0
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  /**
   * One VAD frame. Accumulates it and, on cadence, transcribes what has been
   * said so far.
   *
   * The accumulated buffer starts at speech onset rather than at the VAD's
   * pre-speech pad, so it can clip a few hundred ms off the front compared with
   * the segment onSpeechEnd delivers. That is fine here and deliberate: an
   * interim is a hint used to decide *when* to start drafting, and the final —
   * which is what the answer actually ships against — is unaffected.
   */
  private onFrame(frame: Float32Array): void {
    if (!this.scheduler || !this.speechActive) return
    // The VAD reuses its frame buffer between callbacks, so this must be a copy.
    this.speechFrames.push(new Float32Array(frame))
    this.speechSamples += frame.length
    this.bufferedSamples += frame.length

    // Drop audio older than Whisper's own context window. A VAD segment is
    // normally a sentence, but an interviewer who talks continuously (or line
    // noise that holds the gate open) keeps one open indefinitely — and this
    // buffer was copied *in full* into a fresh allocation every 800 ms and
    // transferred to the worker. Minutes in, that is a tens-of-megabytes
    // allocation per interim and a decode whose cost grows without bound, which
    // is what pushed the *final* transcript — the one the answer ships from —
    // behind a giant interim, and the likeliest source of a worker OOM.
    // Nothing is lost by trimming: the interim only has to answer "is this a
    // question yet", and the model cannot attend past 30 s anyway.
    while (this.bufferedSamples > INTERIM_MAX_SAMPLES && this.speechFrames.length > 1) {
      const dropped = this.speechFrames.shift()
      this.bufferedSamples -= dropped?.length ?? 0
    }

    if (this.interimInFlight) return
    if (this.speechSamples < (INTERIM_MIN_SPEECH_MS * SAMPLE_RATE) / 1000) return
    const sinceLast = this.speechSamples - this.samplesAtLastInterim
    if (sinceLast < (INTERIM_INTERVAL_MS * SAMPLE_RATE) / 1000) return

    this.samplesAtLastInterim = this.speechSamples
    this.interimInFlight = true
    void this.runInterim(flatten(this.speechFrames, this.bufferedSamples))
  }

  private async runInterim(audio: Float32Array): Promise<void> {
    try {
      const text = await transcribeInterim(audio)
      // null = the worker was busy and dropped it; empty = silence or a fragment
      // Whisper made nothing of. Either way there is no new interim this tick.
      if (!text) return
      // The segment ended while this was decoding. The final is already on its
      // way, and feeding a late interim now would re-open a question the
      // scheduler has just closed.
      if (!this.speechActive || !this.scheduler) return
      this.applyInterimCommands(
        this.scheduler.onInterim(text, this.speakerOfIncomingSpeech(), Date.now())
      )
    } catch (e) {
      // An interim is best-effort scaffolding. Surfacing its failure would put an
      // error on screen for work the user never asked for and cannot see; the
      // final transcript takes the same path and will report a real fault.
      console.warn('[speculation] interim transcription failed:', e)
    } finally {
      this.interimInFlight = false
    }
  }

  /** Commands produced while the interviewer is still speaking. */
  private applyInterimCommands(commands: SpeculationCommand[]): void {
    for (const command of commands) {
      switch (command.kind) {
        case 'fire':
          // A coding question is not worth drafting speculatively. Speculation
          // fires several drafts from a half-finished transcript and discards
          // the wrong ones, which is a good trade for short prose on the cheap
          // drafting model and a bad one for the longest answers in the app on
          // the most expensive. Declining the fire leaves the ordinary path to
          // answer it, which is exactly what happens when no draft is ready.
          if (this.settings.assessmentEnabled && looksLikeCodingQuestion(command.text)) {
            break
          }
          this.startSpeculation(command.specId, command.text)
          break
        case 'abort':
          this.abortSpeculation()
          break
        case 'reset':
          // The question was withdrawn. Nothing of the draft is on screen (see
          // startSpeculation), so there is nothing to clear beyond the buffer
          // the preceding abort already dropped.
          this.discardSpeculation()
          break
        case 'commit':
        case 'regenerate':
          // Only ever produced by onFinal.
          break
      }
    }
  }

  /** Commands produced by the final transcript, which knows what was really asked. */
  private applyFinalCommands(commands: SpeculationCommand[], finalText: string): void {
    for (const command of commands) {
      switch (command.kind) {
        case 'commit':
          this.commitSpeculation(finalText)
          break
        case 'regenerate':
        case 'fire':
          // Either the draft answered a different question (regenerate) or
          // nothing was ever speculated (fire). Both mean: generate now, on the
          // real text, down the ordinary path. `regenerate` carries no abort of
          // its own — the scheduler hands the caller a replacement and expects
          // the superseded stream to be cancelled here, or it runs to completion
          // on the user's money.
          this.abortSpeculation()
          this.scheduler?.reset()
          this.messages.push({ role: 'user', content: finalText })
          this.startResponse({ speak: this.speakResponses, maxTokens: 700 })
          break
        case 'abort':
          this.abortSpeculation()
          break
        case 'reset':
          this.discardSpeculation()
          break
      }
    }
  }

  /**
   * Begin drafting an answer to a question that is still being asked.
   *
   * The speculated text is *not* appended to `messages`: until a final agrees
   * with it, it is a guess, and a guess in the history would be re-sent as a
   * real turn on every request afterwards. The request is built from history
   * plus the guess, and only a commit writes the real question back.
   */
  private startSpeculation(specId: number, text: string): void {
    this.abortSpeculation()
    const streamId = crypto.randomUUID()
    this.specStreamId = streamId
    this.specId = specId
    this.specText = ''
    this.specFinished = false
    void window.hue.llm.start(streamId, {
      messages: [...this.messages, { role: 'user', content: text }],
      // Never an assessment draft: the fire is declined for coding questions
      // upstream, so a draft that exists is by construction an ordinary answer.
      system: buildSystemPrompt(this.settings, false),
      maxTokens: 700
    })
  }

  /**
   * Cancel the in-flight draft for real.
   *
   * `hue:llm:abort` aborts the provider's HTTP stream, not just our listener: a
   * generation left running bills the user for tokens nobody reads, and can
   * still win a race and land under a question it never answered.
   */
  private abortSpeculation(): void {
    if (this.specStreamId) window.hue.llm.abort(this.specStreamId)
    this.discardSpeculation()
  }

  /** Forget the draft locally. Deltas already in flight stop matching and are dropped. */
  private discardSpeculation(): void {
    this.specStreamId = null
    this.specId = null
    this.specText = ''
    this.specFinished = false
  }

  /**
   * The final agreed with what the draft was fired on: adopt the draft as this
   * turn's answer.
   *
   * Everything the ordinary path does still happens, and happens exactly once —
   * the real question is written to history, the accumulated text is shown, and
   * the stream (if still running) becomes `currentStreamId` so it finishes
   * through onLlmDone, which is where the grounding receipt is resolved. A draft
   * that had already finished on its own completes right here instead, through
   * the same method onLlmDone calls, for the same reason: one receipt per turn,
   * never zero and never two.
   */
  private commitSpeculation(finalText: string): void {
    const streamId = this.specStreamId
    const text = this.specText
    const finished = this.specFinished
    this.discardSpeculation()

    if (streamId === null) {
      // The scheduler wants to commit a draft this side no longer has — the
      // stream was cancelled out from under it (barge-in, a cleared session).
      // Generate for real rather than adopting an empty answer, which would
      // leave the turn with nothing on screen and no completion to come.
      this.messages.push({ role: 'user', content: finalText })
      // Routed here too. This path regenerates from the real question, so it is
      // an ordinary turn in every respect and must reach the same provider and
      // shape a question of this kind would have reached down the normal path.
      this.lastSpokenQuestion = finalText
      const routing = assessmentRouting(this.settings, finalText)
      this.currentAssessment = routing.assessment
      this.startResponse({
        speak: this.speakResponses && routing.speak,
        maxTokens: routing.maxTokens
      })
      return
    }

    this.messages.push({ role: 'user', content: finalText })
    this.lastSpokenQuestion = finalText
    this.assistantText = text
    // An adopted draft is never an assessment answer: speculation does not fire
    // for a coding question (see applyInterimCommands), so this text was drafted
    // against the ordinary shape. Cleared rather than left alone, because a flag
    // still set from the previous turn would label it a code answer and hand it
    // the wrong grounding receipt.
    this.currentAssessment = false
    // Companion mode never speaks its answers aloud; speculation is companion-only.
    this.currentSpeak = false
    this.currentStreamId = finished ? null : streamId
    // Never 'speaking' here: currentSpeak was just set false two lines up, and
    // speculation is companion-only, which never speaks aloud.
    this.setState('thinking')
    if (text) this.callbacks.onAssistantText?.(stripStreamingCitation(text))
    if (finished) this.completeTurn()
  }

  /**
   * Capture the primary screen and ask the assistant about it (e.g. a coding
   * prompt the interviewer is screen-sharing). The answer is shown as text only,
   * never spoken, and gets a larger token budget for code/long explanations.
   * Behaves like a normal turn otherwise: any in-flight reply is aborted first.
   */
  async captureScreen(): Promise<void> {
    if (!this.vad) {
      this.callbacks.onError?.('Start a session before capturing the screen.')
      return
    }
    this.abortResponse()
    this.setState('thinking')

    let shot: ScreenCapture
    try {
      shot = await window.hue.capture.screen()
    } catch (e) {
      this.callbacks.onError?.(e instanceof Error ? e.message : String(e))
      this.setState('listening')
      return
    }

    // Asked of main rather than resolved here: `assessmentProvider` falls back to
    // `llmProvider`, and only `providerFor` owns that precedence. A failure to
    // answer is treated as no vision, which routes the capture down the path
    // that has always worked rather than to a provider that may reject the image.
    let hasVision = false
    try {
      hasVision = await window.hue.llm.assessmentVision()
    } catch {
      hasVision = false
    }
    const routing = captureRouting(this.settings, hasVision)
    this.currentAssessment = routing.assessment
    // The override cannot re-run a capture: the image is stripped from history
    // once answered, so a re-run would ask about a screenshot that is no longer
    // there. See `lastSpokenQuestion`.
    this.lastSpokenQuestion = null
    if (routing.fellBack) {
      // Said out loud rather than swallowed. The reason assessment has its own
      // provider is that a plausible-looking wrong answer about code costs more
      // than a slow one, so a user who thinks they are reading the accurate
      // model when they are not is the worst state this feature can be in.
      this.callbacks.onError?.(
        'Your assessment provider cannot read images, so this screenshot went to the drafting model instead.'
      )
    }

    const content: LlmContentBlock[] = [
      { type: 'image', mediaType: shot.mediaType, dataBase64: shot.dataBase64 },
      { type: 'text', text: captureInstruction(this.settings, routing.assessment) }
    ]
    this.messages.push({ role: 'user', content })
    this.pendingCaptureIndex = this.messages.length - 1
    this.callbacks.onScreenCapture?.(shot)
    // Never spoken, as before. The budget follows the routing: a capture that
    // reached the assessment path is answered with steps plus code, which does
    // not fit in the 1024 the prose path used.
    this.startResponse({ speak: false, maxTokens: routing.assessment ? 1500 : 1024 })
  }

  /**
   * Re-answer the last spoken question down the other path.
   *
   * This is the escape hatch the classifier's accuracy rests on. `assessment.ts`
   * says outright that `looksLikeCodingQuestion` will be wrong sometimes and
   * that this control is what makes being wrong survivable: without it, one
   * misclassification mid-interview leaves the user reading a STAR answer to a
   * question about a binary search with no way out.
   *
   * The trailing assistant turn is dropped rather than appended to. The user is
   * replacing an answer, not asking a follow-up, and leaving the rejected one in
   * history would teach the model that both shapes are wanted for one question.
   *
   * Returns false when there is nothing to re-answer, so the caller can say so
   * rather than appear to do nothing.
   */
  reanswerAs(assessment: boolean): boolean {
    const question = this.lastSpokenQuestion
    if (question === null) return false
    this.abortResponse()
    while (
      this.messages.length > 0 &&
      this.messages[this.messages.length - 1].role === 'assistant'
    ) {
      this.messages.pop()
    }
    this.currentAssessment = assessment
    this.startResponse({
      speak: this.speakResponses && !assessment,
      maxTokens: assessment ? 1500 : 700
    })
    return true
  }

  /** Interviewer mode: seed the conversation so Hue asks the opening question. */
  private kickoffInterview(): void {
    this.messages.push({
      role: 'user',
      content: 'Please begin the interview with your first question.'
    })
    this.startResponse({ speak: this.speakResponses, maxTokens: 700 })
  }

  private startResponse(opts: { speak: boolean; maxTokens: number }): void {
    this.setState('thinking')
    this.assistantText = ''
    this.currentSpeak = opts.speak
    const streamId = crypto.randomUUID()
    this.currentStreamId = streamId
    void window.hue.llm.start(streamId, {
      messages: this.messages,
      system: buildSystemPrompt(this.settings, this.currentAssessment),
      maxTokens: opts.maxTokens,
      // Absent means drafting. Main resolves what the role means right now; this
      // side only knows which kind of question just arrived.
      role: this.currentAssessment ? 'assessment' : undefined
    })
  }

  /** Abort the in-flight LLM stream and stop any audio currently playing. */
  private abortResponse(): void {
    if (this.currentStreamId) {
      window.hue.llm.abort(this.currentStreamId)
      this.currentStreamId = null
    }
    // A draft is a generation too, and one nobody is waiting on. Whatever
    // cancels the visible answer cancels the invisible one. The scheduler is
    // reset with it: every caller of this (barge-in, screen capture, clear,
    // stop) is starting something new, and leaving the scheduler believing a
    // draft is still in flight would have it commit a stream that no longer
    // exists.
    this.abortSpeculation()
    this.scheduler?.reset()
    this.tts.interrupt()
  }

  private onLlmDelta(e: LlmDeltaEvent): void {
    if (e.streamId === this.specStreamId) {
      // A draft in progress. It is buffered, never rendered: the question it
      // answers is still being asked, and showing an answer to half a question —
      // one that may yet be withdrawn — is worse than showing nothing. The
      // latency win is in having generated it, not in having displayed it early.
      // The specId guard still applies: a delta from a superseded draft must
      // never reach the buffer that a commit will put on screen.
      if (this.specId === null || !this.scheduler?.accepts(this.specId)) return
      this.specText += e.text
      return
    }
    if (e.streamId !== this.currentStreamId) return
    // 'speaking' means audio is actually playing, not merely that a response is
    // streaming. Companion mode never speaks (see speakResponses), so entering
    // it there put SPEAKING on the badge of an app whose whole promise is that
    // it stays silent during a live call. A silent turn stays 'thinking' until
    // it completes.
    this.setState(this.currentSpeak ? 'speaking' : 'thinking')
    this.assistantText += e.text
    if (this.currentSpeak) this.tts.appendText(e.text)
    // Display text only: the citation line is scaffolding the user must never be
    // shown, and half of it must never appear either. The grounding decision is
    // NOT made here — see onLlmDone.
    this.callbacks.onAssistantText?.(stripStreamingCitation(this.assistantText))
  }

  private onLlmDone(e: LlmDoneEvent): void {
    if (e.streamId === this.specStreamId) {
      // The draft finished before the interviewer did — the best case, and the
      // whole point. Hold it: a commit will adopt it and complete the turn.
      if (e.aborted) this.discardSpeculation()
      else this.specFinished = true
      return
    }
    if (e.streamId !== this.currentStreamId) return
    this.currentStreamId = null
    if (e.aborted) {
      // Partial reply discarded on barge-in; don't pollute history.
      this.setState('listening')
      return
    }
    this.completeTurn()
  }

  /**
   * Finish a turn: flush audio, resolve the grounding receipt, record history.
   *
   * Shared by the ordinary path and by a committed speculative draft that had
   * already finished streaming, so both settle a turn identically. Grounding is
   * resolved here and nowhere else — exactly once per turn that produces an
   * answer, whether or not the answer was drafted early.
   */
  private completeTurn(): void {
    if (this.currentSpeak) this.tts.flush()
    // The response is whole for the first time here, which is the only point a
    // trailing `story_id` can be read. Everything before this was a prefix.
    const { answer, grounding } = this.resolveTurnGrounding(this.assistantText)
    if (answer) {
      // The stripped answer, not the raw text, goes into history: re-feeding the
      // model its own citation line teaches it that the line is part of an answer.
      this.messages.push({ role: 'assistant', content: answer })
      this.callbacks.onAssistantComplete?.(answer, grounding)
    }
    // Hue has now answered the capture once; drop the screenshot from history so
    // the full PNG isn't re-sent to the provider on every subsequent turn. The
    // paired text instruction is kept so the turn still reads coherently.
    if (this.pendingCaptureIndex !== null) {
      this.messages[this.pendingCaptureIndex] = stripCaptureImage(
        this.messages[this.pendingCaptureIndex]
      )
      this.pendingCaptureIndex = null
    }
    this.trimHistory()
    this.setState('listening')
  }

  /**
   * Keep the conversation history bounded.
   *
   * The whole array is sent on every turn, and a 45-minute interview is dozens of
   * question/answer pairs — each answer a few hundred tokens, plus whatever
   * survived of a screen capture. Left to grow, the session ends the way an
   * unbounded context always does: a provider context-length error, mid-answer,
   * on a question late in the interview, which is precisely when it costs most.
   *
   * The oldest turns are the ones to lose. What Hue needs is the thread of the
   * last few exchanges; the substance an answer is built from comes from the
   * profile bundle and the job posting, which are re-sent in the system prompt on
   * every turn and are unaffected by this.
   */
  private trimHistory(): void {
    if (this.messages.length <= MAX_HISTORY_MESSAGES) return
    const dropped = this.messages.length - MAX_HISTORY_MESSAGES
    this.messages = this.messages.slice(dropped)
    // The capture index points into the array we just re-based. Anything that
    // slid off the front is gone; anything left has moved down by `dropped`.
    if (this.pendingCaptureIndex !== null) {
      const moved = this.pendingCaptureIndex - dropped
      this.pendingCaptureIndex = moved >= 0 ? moved : null
    }
  }

  /**
   * Splits a finished response into what the user reads and its grounding receipt.
   *
   * Returns a null receipt — no marker at all, rather than an ungrounded one —
   * for the two turns where a receipt would be noise rather than a warning:
   *
   *  - **Interviewer mode.** Hue is asking the questions, not drafting answers
   *    off the user's history. Flagging a question as "not anchored" is true and
   *    useless, and a warning shown when nothing is wrong is a warning the user
   *    learns to skip past — including on the companion answers where it counts.
   *  - **No profile bundle.** The legacy `resumeSummary` path never names story
   *    ids, so the model has nothing to cite and every answer would be flagged.
   *    That is alarm fatigue by construction, and it would fire hardest on the
   *    users who have not finished setting the app up.
   */
  private resolveTurnGrounding(raw: string): { answer: string; grounding: Grounding | null } {
    // Checked before the bundle, because it is true whether or not one exists.
    // A code answer was never a candidate for a story, so asking which story it
    // came from is the wrong question rather than a question with a bad answer.
    // Returning `null` here instead would be indistinguishable from a turn that
    // produced no receipt at all, and the review would silently stop counting
    // the technical half of the interview.
    if (this.currentAssessment) {
      return {
        answer: stripStreamingCitation(raw).trim(),
        grounding: { kind: 'general-knowledge' }
      }
    }
    const bundle = parseProfileBundle(this.settings.profileBundleJson)
    if (this.settings.hueMode !== 'companion' || !bundle) {
      // The citation line is still stripped: if a model volunteers one here, it
      // is scaffolding on screen either way.
      return { answer: stripStreamingCitation(raw).trim(), grounding: null }
    }
    const resolved = groundResponse(raw, bundle)
    // Why the "not anchored" chip fired on an answer drawn from real history.
    //
    // Reaching here at all means a bundle is installed, so the two remaining
    // causes are distinguishable and want different fixes: `claimedId: null` is
    // the model omitting the citation line, which is an output-contract problem,
    // while a non-null id that did not resolve is the model inventing or
    // mangling one, which is a prompt-vocabulary problem.
    if (resolved.grounding.kind === 'ungrounded') {
      console.info(
        `[grounding] ungrounded: stories=${bundle.stories.length} ` +
          `claimedId=${resolved.grounding.claimedId ?? 'none (no citation line written)'}`
      )
    }
    return resolved
  }

  private onLlmError(e: LlmErrorEvent): void {
    if (e.streamId === this.specStreamId) {
      // A draft the user never saw failed. Reported to the console, not to the
      // UI: the same request is about to be made for real down the ordinary path
      // and will surface the fault there, where it is about something the user
      // actually asked for. Clearing the scheduler's draft is what routes the
      // final that way.
      console.warn('[speculation] draft failed:', e.message)
      this.discardSpeculation()
      this.scheduler?.reset()
      return
    }
    if (e.streamId !== this.currentStreamId) return
    this.currentStreamId = null
    this.callbacks.onError?.(e.message)
    this.setState('listening')
  }
}

/**
 * Make Hue's spoken output sound like a real person rather than an AI. Adapted
 * from the "humanizer" skill by Siqi Chen (MIT-licensed,
 * https://github.com/blader/humanizer), trimmed to the rules that matter for
 * short, spoken answers. The same guidance ships in the reference hue extension.
 */

/**
 * Concatenate accumulated VAD frames into the single contiguous buffer the ASR
 * worker expects. A fresh allocation each time, because the caller keeps
 * appending to its frame list while this copy is being transcribed (and the copy
 * is transferred to the worker).
 */
function flatten(frames: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let offset = 0
  for (const frame of frames) {
    if (offset + frame.length > total) break
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}
