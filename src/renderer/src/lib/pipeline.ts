import { MicVAD } from '@ricky0123/vad-web'
import { transcribe } from './transcription'
import { StreamingTTSQueue } from './streamingTTS'
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
  onError?: (message: string) => void
}

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

  constructor(settings: HueSettings, callbacks: PipelineCallbacks = {}) {
    this.settings = settings
    this.callbacks = callbacks
    this.speakResponses = settings.hueMode === 'interviewer'
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
      onVADMisfire: () => {
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
  }

  private async onSpeechEnd(audio: Float32Array): Promise<void> {
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

    this.messages.push({ role: 'user', content: text })
    this.startResponse({ speak: this.speakResponses, maxTokens: 500 })
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
    this.tts.interrupt()
  }

  private onLlmDelta(e: LlmDeltaEvent): void {
    if (e.streamId !== this.currentStreamId) return
    if (this.state !== 'speaking') this.setState('speaking')
    this.assistantText += e.text
    if (this.currentSpeak) this.tts.appendText(e.text)
    this.callbacks.onAssistantText?.(this.assistantText)
  }

  private onLlmDone(e: LlmDoneEvent): void {
    if (e.streamId !== this.currentStreamId) return
    this.currentStreamId = null
    if (e.aborted) {
      // Partial reply discarded on barge-in; don't pollute history.
      this.setState('listening')
      return
    }
    if (this.currentSpeak) this.tts.flush()
    if (this.assistantText) {
      this.messages.push({ role: 'assistant', content: this.assistantText })
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

  private onLlmError(e: LlmErrorEvent): void {
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
  if (s.resumeSummary) parts.push(`The candidate's background: ${s.resumeSummary}`)
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
  if (s.resumeSummary) parts.push(`The user's background (draw on this): ${s.resumeSummary}`)
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
