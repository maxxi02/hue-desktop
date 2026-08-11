import { MicVAD } from '@ricky0123/vad-web'
import { transcribe, transcribeInterim } from './transcription'
import { StreamingTTSQueue } from './streamingTTS'
import { parseProfileBundle, profilePromptBlock } from '../../../shared/profile'
import { groundResponse, stripStreamingCitation, type Grounding } from '../../../shared/grounding'
import {
  SpeculationScheduler,
  type Command as SpeculationCommand,
  type Speaker
} from '../../../shared/speculation'
import {
  CueMatcher,
  gateCommands,
  newLatchState,
  type CueSheet,
  type CueCard,
  type GateDecision
} from '../../../shared/cuesheet'
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
  /**
   * Fired when a prepared cue card latches onto the current question (the
   * user's own prepared answer), or with null when the latch clears (a new
   * question began, or the session tore down). Optional so existing callers
   * keep compiling.
   */
  onCueCard?: (card: CueCard | null) => void
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

  /**
   * The cue matcher for the session's armed cue sheet, or null when none is
   * selected (or the selected id no longer resolves to a sheet) — the pipeline
   * then behaves exactly as it does without the feature. Built once per
   * session in `start()`, not per utterance.
   */
  private matcher: CueMatcher | null = null
  /** Which card (if any) is latched onto the current question. */
  private latch = newLatchState()

  /** The in-flight speculative LLM stream, if any. Never `currentStreamId`. */
  private specStreamId: string | null = null
  /** The scheduler's id for that stream — the guard that stale deltas are tested against. */
  private specId: number | null = null
  /** Draft text accumulated so far. Held back from the UI until the draft commits. */
  private specText = ''
  /** True once the speculative stream finished on its own, before the final arrived. */
  private specFinished = false

  /**
   * The most recent interim transcript text, held here because
   * `SpeculationScheduler.latestInterim` is private and unreadable from the
   * caller. `beginSegment`'s tick timer has no text of its own — `onTick` takes
   * none — so it reads this instead of the scheduler's internal copy. Updated
   * in `runInterim` immediately after a new interim is transcribed, and cleared
   * whenever a segment opens or closes.
   */
  private lastInterimText = ''

  /** Speech captured since the VAD opened this segment, for interim transcription. */
  private speechFrames: Float32Array[] = []
  private speechSamples = 0
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

    // Load the armed cue sheet, if any. An id that no longer resolves (sheet
    // deleted, settings stale) leaves the matcher null and the pipeline behaves
    // exactly as it does without the feature.
    //
    // Guarded, and the guard is the point: this runs before mic and ASR setup,
    // so an unhandled rejection here — IPC failure, an unreadable sheets
    // directory, a truncated sheet that makes `new CueMatcher` throw — would
    // propagate out of `start()` and the interview would never begin. A cue
    // sheet is an optional aid; it must never be able to stop a session.
    this.matcher = null
    const selectedId = this.settings.selectedCueSheetId
    if (selectedId) {
      try {
        const sheets = await window.hue.cueSheet.list()
        const sheet = sheets.find((s: CueSheet) => s.id === selectedId)
        this.matcher = sheet ? new CueMatcher(sheet) : null
      } catch {
        this.matcher = null
      }
    }
    this.latch = newLatchState()

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
        // The segment produced no final, so nothing will ever arrive to commit
        // or discard a draft fired from it. Tear it down here or it stays in
        // flight forever, blocking every later question (one draft, ever).
        this.endSegment()
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
    this.endSegment()
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
    this.beginSegment()
  }

  private async onSpeechEnd(audio: Float32Array): Promise<void> {
    this.endSegment()
    this.setState('transcribing')
    let text: string
    try {
      const res = await transcribe(audio)
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
    this.startResponse({ speak: this.speakResponses, maxTokens: 500 })
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
    this.samplesAtLastInterim = 0
    this.lastInterimText = ''
    if (this.tickTimer === null) {
      this.tickTimer = setInterval(() => {
        if (!this.scheduler) return
        this.applyInterimCommands(this.scheduler.onTick(Date.now()), this.lastInterimText)
      }, SPECULATION_TICK_MS)
    }
  }

  /** The segment closed (end of speech, misfire, or shutdown). Stops all interim work. */
  private endSegment(): void {
    this.speechActive = false
    this.speechFrames = []
    this.speechSamples = 0
    this.samplesAtLastInterim = 0
    this.lastInterimText = ''
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

    if (this.interimInFlight) return
    if (this.speechSamples < (INTERIM_MIN_SPEECH_MS * SAMPLE_RATE) / 1000) return
    const sinceLast = this.speechSamples - this.samplesAtLastInterim
    if (sinceLast < (INTERIM_INTERVAL_MS * SAMPLE_RATE) / 1000) return

    this.samplesAtLastInterim = this.speechSamples
    this.interimInFlight = true
    void this.runInterim(flatten(this.speechFrames, this.speechSamples))
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
      this.lastInterimText = text
      this.applyInterimCommands(
        this.scheduler.onInterim(text, this.speakerOfIncomingSpeech(), Date.now()),
        text
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

  /**
   * Ask the matcher what to do about the text so far.
   *
   * Returns null-latch on the interim path: suppression is decided live, but
   * nothing is ever put on screen until the final. A card that changed twice
   * while the interviewer was still talking is exactly the distraction the
   * glance UI exists to avoid.
   */
  private decide(text: string, isFinal: boolean): GateDecision {
    if (!this.matcher || text.trim().length === 0) {
      return { suppress: false, latch: null, isFinal }
    }
    const result = this.matcher.match(text)
    if (!isFinal) {
      return { suppress: this.matcher.suppresses(result), latch: null, isFinal }
    }
    const latch = this.matcher.renders(result) ? result.cardId : null
    return { suppress: false, latch, isFinal }
  }

  /** Commands produced while the interviewer is still speaking. */
  private applyInterimCommands(commands: SpeculationCommand[], text: string): void {
    const decision = this.decide(text, false)
    const gated = gateCommands(commands, this.latch, decision)
    if (gated.resetScheduler) this.scheduler?.reset()
    commands = gated.commands

    // A mid-question `reset` (the interviewer withdrew the question and started
    // a different one) clears the latch inside the gate. The FINAL path
    // compensates for that with its own `onCueCard(null)`; this path used not
    // to, and the card simply stayed on screen. In glance mode `App.tsx`
    // renders `voice.cueCard ? CueCardBody : latestAnswer`, so a stale card
    // does not merely linger — it HIDES the real answer to the question that
    // replaced it, for as long as the next question fails to match anything.
    if (gated.latchCleared) this.callbacks.onCueCard?.(null)

    for (const command of commands) {
      switch (command.kind) {
        case 'fire':
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
    // Captured before gateCommands mutates `this.latch` in place, so it reads
    // as "what was on screen a moment ago" for the transition check below.
    const previousLatch = this.latch.cardId
    const decision = this.decide(finalText, true)
    const gated = gateCommands(commands, this.latch, decision)
    if (gated.resetScheduler) this.scheduler?.reset()
    commands = gated.commands

    if (decision.latch !== null) {
      // The card is the answer now. Any in-flight generation is money spent on
      // something nobody will read, and it can still win a race and overwrite
      // the card.
      this.abortSpeculation()
      this.specId = null
      this.callbacks.onCueCard?.(this.matcher?.card(decision.latch) ?? null)
    } else if (previousLatch !== null) {
      // A final is a question boundary: it either latches a new card or
      // clears whatever was standing (see gateCommands). This final matched
      // nothing, but a card was on screen from a previous question — tell the
      // UI so the stale card doesn't linger through the next question. Not
      // fired when nothing was ever latched, so an ordinary unmatched
      // question doesn't spam the callback.
      this.callbacks.onCueCard?.(null)
    }

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
          this.startResponse({ speak: this.speakResponses, maxTokens: 500 })
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
      system: buildSystemPrompt(this.settings),
      maxTokens: 500
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
      this.startResponse({ speak: this.speakResponses, maxTokens: 500 })
      return
    }

    this.messages.push({ role: 'user', content: finalText })
    this.assistantText = text
    // Companion mode never speaks its answers aloud; speculation is companion-only.
    this.currentSpeak = false
    this.currentStreamId = finished ? null : streamId
    this.setState(text ? 'speaking' : 'thinking')
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

    const content: LlmContentBlock[] = [
      { type: 'image', mediaType: shot.mediaType, dataBase64: shot.dataBase64 },
      { type: 'text', text: captureInstruction(this.settings) }
    ]
    this.messages.push({ role: 'user', content })
    this.pendingCaptureIndex = this.messages.length - 1
    this.callbacks.onScreenCapture?.(shot)
    this.startResponse({ speak: false, maxTokens: 1024 })
  }

  /** Interviewer mode: seed the conversation so Hue asks the opening question. */
  private kickoffInterview(): void {
    this.messages.push({ role: 'user', content: 'Please begin the interview with your first question.' })
    this.startResponse({ speak: this.speakResponses, maxTokens: 500 })
  }

  private startResponse(opts: { speak: boolean; maxTokens: number }): void {
    this.setState('thinking')
    this.assistantText = ''
    this.currentSpeak = opts.speak
    const streamId = crypto.randomUUID()
    this.currentStreamId = streamId
    void window.hue.llm.start(streamId, {
      messages: this.messages,
      system: buildSystemPrompt(this.settings),
      maxTokens: opts.maxTokens
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
    // A latched cue card is per-question state too, and this path (barge-in,
    // screen capture, clear, stop) is starting something new. Without this, a
    // latched card survives a session stop and reappears attached to the next
    // question.
    this.latch = newLatchState()
    this.callbacks.onCueCard?.(null)
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
    if (this.state !== 'speaking') this.setState('speaking')
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
      this.messages[this.pendingCaptureIndex] = stripCaptureImage(this.messages[this.pendingCaptureIndex])
      this.pendingCaptureIndex = null
    }
    this.setState('listening')
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
    const bundle = parseProfileBundle(this.settings.profileBundleJson)
    if (this.settings.hueMode !== 'companion' || !bundle) {
      // The citation line is still stripped: if a model volunteers one here, it
      // is scaffolding on screen either way.
      return { answer: stripStreamingCitation(raw).trim(), grounding: null }
    }
    return groundResponse(raw, bundle)
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
const HUMAN_VOICE_GUIDANCE = `Sound like a real person, not an AI:
- Start with substance. Skip sycophantic openers ("Great question!", "Absolutely!", "You're so right!").
- Cut chatbot filler ("I hope this helps", "Of course!", "Would you like me to…", "Let me know if…").
- Drop signposting and fake-depth phrases ("Let's dive in", "At its core", "The real question is", "Fundamentally", "It's worth noting").
- Avoid AI-tell words: delve, crucial, tapestry, testament, underscore, leverage, landscape, realm, robust, seamless.
- Use simple, everyday words a normal person actually says out loud. Skip fancy or "deep" vocabulary: say "use" not "utilize", "help" not "facilitate", "show" not "demonstrate", "about" not "regarding", "enough" not "sufficient", "start" not "commence". If a word would make someone reach for a dictionary, pick a plainer one.
- Prefer plain verbs (is/has) over "serves as", "stands as", "boasts".
- Trim filler: "in order to" becomes "to"; "due to the fact that" becomes "because".
- Say things once; don't stack hedges like "could potentially possibly".
- Vary your rhythm; don't force every list into a group of three.
- Mix sentence lengths the way people actually talk: a short, punchy sentence next to a longer, looser one. Uniform, polished prose reads as scripted.
- Have a take. Commit to one angle instead of covering every side evenly — people answer with opinions, not surveys.
- Never close with a tidy summary ("Overall…", "In short…", "At the end of the day…"); just end on your last real point.
- One light spoken touch per answer is fine when it fits naturally ("honestly", "you know", "I mean") — at most one, never forced.
- Use commas or periods instead of em dashes; they sound awkward read aloud.
- Use contractions and talk the way a sharp, warm person actually speaks.
- Write in natural, conversational Philippine English — relaxed and friendly, the way a Filipino speaks English in a real conversation, not stiff or formal. It's fine to open casually ("So,", "Honestly,", "Yeah,") and keep an easygoing tone. Stay in clean, grammatical English — do NOT mix in Tagalog or Taglish words.`

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

/**
 * Collapse a captured-screen turn to plain text, dropping the image block(s) and
 * keeping the paired instruction. Called once Hue has answered the capture so the
 * large screenshot isn't re-sent to the provider on every later turn.
 */
function stripCaptureImage(msg: LlmMessage): LlmMessage {
  if (typeof msg.content === 'string') return msg
  const text = msg.content
    .filter((b): b is Extract<LlmContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  return { role: msg.role, content: `[Screen capture omitted to save tokens]\n${text}` }
}

/**
 * The instruction paired with a screen capture. Framed for companion mode (the
 * common case — the interviewer is sharing a prompt) and lightly adjusted when
 * Hue is the interviewer so the screenshot reads as context rather than a task.
 */
function captureInstruction(s: HueSettings): string {
  if (s.hueMode === 'interviewer') {
    return 'This is a screenshot of my screen. Use it as context for the interview if relevant.'
  }
  return (
    "This is a screenshot of the interviewer's shared screen — likely a coding problem, " +
    'system-design prompt, or question. Read it carefully and help me solve or answer it: give a ' +
    "clear approach, and if it's a coding task include concise, correct code plus a short " +
    'explanation I can talk through.'
  )
}

/**
 * The candidate's background, preferring the structured bundle.
 *
 * Falls back to the legacy freeform summary so an install that predates
 * hue-ingest keeps working — losing someone's background on upgrade would be a
 * worse failure than the weaker grounding that fallback provides.
 */
function candidateBackground(s: HueSettings): string | null {
  const bundle = parseProfileBundle(s.profileBundleJson)
  if (bundle) return profilePromptBlock(bundle)
  return s.resumeSummary || null
}

function buildSystemPrompt(s: HueSettings): string {
  return s.hueMode === 'interviewer'
    ? buildInterviewerPrompt(s)
    : buildCompanionPrompt(s)
}

/** Hue plays the interviewer, asking the user questions one at a time (spoken). */
function buildInterviewerPrompt(s: HueSettings): string {
  const parts: string[] = [
    'You are Hue, acting as a professional interviewer conducting a job interview. ' +
      'Your questions will be read aloud, so keep them clear, natural, and concise. ' +
      'Ask ONE question at a time, then wait for the candidate to answer. Based on their ' +
      'answer, ask a relevant follow-up or move to the next question. Do not answer for ' +
      'them or coach them mid-interview; stay in character as the interviewer.'
  ]
  if (s.jobTitle) parts.push(`The role being interviewed for is: ${s.jobTitle}.`)
  // The interviewer persona uses the background to ask *about* the candidate's
  // real history, so a structured bundle helps here for the same reason it helps
  // the companion: it names what exists rather than implying everything does.
  const background = candidateBackground(s)
  if (background) parts.push(`The candidate's background:\n\n${background}`)
  if (s.interviewMode === 'star') {
    parts.push('Favor behavioral questions that invite STAR-style (Situation, Task, Action, Result) answers.')
  }
  return `${parts.join(' ')}\n\n${HUMAN_VOICE_GUIDANCE}`
}

/** Hue assists the user: incoming text is the interviewer's question; Hue drafts the answer. */
function buildCompanionPrompt(s: HueSettings): string {
  const parts: string[] = [
    'You are Hue, a real-time interview companion helping the user during a live interview. ' +
      "The user message you receive is the INTERVIEWER'S question (transcribed from the call). " +
      'Draft a strong answer that the USER can say out loud, written in the first person from ' +
      "the user's perspective. No preamble, no quotation marks, no meta commentary. Make the " +
      'answer a few full sentences (roughly three to five) — enough to sound substantial and ' +
      'give the interviewer something real to work with — while still sounding natural to say out loud.',
    'Lead with the answer. Make your very first sentence a complete, standalone response to the ' +
      "question, so the user can start speaking the moment it appears and the rest just builds on it. " +
      'Never open with a wind-up, a restatement of the question, or a throat-clearing phrase.',
    'The question is transcribed by speech recognition and may be imperfect — misheard words, missing ' +
      "punctuation, or the user's own voice mixed in. Infer the interviewer's actual intent and answer that. " +
      'If the text is only a fragment or too garbled to read confidently, answer the most likely intended ' +
      "question rather than asking for clarification — the user can't relay a clarifying question mid-call.",
    'Write the answer as a single, natural paragraph the user can say start to finish — no headings, ' +
      'no labels, no "Example:" prefix, no bullet points. Weave one concrete, real-life example directly ' +
      'into the answer so it backs up the point as part of the flow, the way a person naturally drops in ' +
      'a specific moment while speaking.',
    'Make it sound like the user thinking out loud mid-conversation, not reciting a prepared statement: ' +
      'an occasional small aside ("which, honestly, was the hard part"), a real number or name where an ' +
      'adjective would go, slightly uneven rhythm. An essay-perfect paragraph reads as scripted — leave ' +
      'a human edge on it.',
    'Match the answer to the kind of question. For behavioral questions ("tell me about a time…"), give a ' +
      'short story with a clear result. For technical or system-design questions, lead with your approach ' +
      'and the key tradeoff, then a concrete detail. For quick factual or "do you know X" questions, answer ' +
      'directly in a sentence or two. Do not force a long story onto a question that wants a crisp answer.',
    'Make it a strong answer, not just a complete one. Own the work in the first person ("I decided", ' +
      '"I built") instead of hiding behind "we" when it was the user\'s own call. Pick specifics over ' +
      'adjectives — a real decision, the tradeoff behind it, and the outcome it produced say more than ' +
      '"I\'m passionate" or "I work hard" ever will. Show a flash of the reasoning, not just the ' +
      'conclusion, so the interviewer hears how the user thinks. When it fits, tie the point back to what ' +
      'this role needs. Land on a confident closing line; never trail off into hedges or "I think that\'s ' +
      'about it."',
    'Skip interview clichés and empty self-labels ("team player", "fast learner", "perfectionist", ' +
      '"I give 110%"). If a trait matters, prove it with a specific moment instead of claiming the label.',
    'When the question targets something the user may not know, do not bluff fake fluency. Give what they ' +
      'genuinely do know, then bridge honestly to the nearest real experience ("I haven\'t shipped with X, ' +
      'but I\'ve used Y for the same kind of problem, and here\'s how I\'d approach it"). Honest and ' +
      'adaptable beats confidently wrong.',
    'Never invent specific facts the user has not given you: no fabricated names, employers, ' +
      'numbers, or backstories (for example, do not claim "a friend recommended this role" or cite ' +
      "metrics that aren't in their background). Ground the answer and its example in the user's " +
      'background below when it is relevant. If you lack a real detail, use a light placeholder the user ' +
      'can fill in on the fly (e.g. "at [company], I cut load time by about [X]%") rather than inventing ' +
      'a specific claim.'
  ]
  if (s.jobTitle) parts.push(`The user is interviewing for the role: ${s.jobTitle}.`)

  const bundle = parseProfileBundle(s.profileBundleJson)
  if (bundle) {
    // With a bundle the "never invent facts" instruction above stops being a
    // hope and becomes checkable: the model is given the exact set of stories it
    // may draw on, each with an id, and told what to say when none of them fit.
    parts.push(
      "The user's verified background is below. Draw the answer from it. Every story you may " +
        'use is listed with an id; when your answer rests on one, it must be one of these. ' +
        'If no story genuinely fits the question, say so honestly in the answer and keep it ' +
        'general — do not adapt a story that does not apply, and do not invent one.'
    )
    // The citation is what makes the rule above checkable rather than hopeful,
    // and it only works if the id lands somewhere the app can read it back. A
    // final line of its own is the one place a trailing token can be found
    // reliably; the app strips it before the answer is shown, so it costs the
    // user nothing. See shared/grounding.ts.
    parts.push(
      'After the answer, on a final line of its own, write `story_id: <id>` naming the story bank ' +
        'entry the answer rests on, or `story_id: null` if none of them fit. Use the id exactly as ' +
        'written below. This line is stripped before the user sees the answer, so never refer to it ' +
        'in the answer itself.'
    )
    parts.push(profilePromptBlock(bundle))
  } else if (s.resumeSummary) {
    // Pre-bundle installs still work. This path has no story ids and no gap
    // scan, so it keeps the older, weaker guarantee.
    parts.push(`The user's background (draw on this): ${s.resumeSummary}`)
  }
  switch (s.interviewMode) {
    case 'star':
      parts.push('Structure the answer using the STAR method (Situation, Task, Action, Result).')
      break
    case 'live':
      parts.push('Give a tight, direct answer the user can say immediately. Brevity over completeness.')
      break
    default:
      parts.push('Give a strong, complete answer the user can adapt in their own words.')
  }
  return `${parts.join(' ')}\n\n${HUMAN_VOICE_GUIDANCE}`
}
