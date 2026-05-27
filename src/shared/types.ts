// Shared types used by both the Electron main process and the renderer.

export type LlmProvider = 'anthropic' | 'ollama' | 'google' | 'groq' | 'mistral' | 'cohere'

/**
 * Providers that speak the OpenAI Chat Completions wire format (SSE streaming +
 * a /models listing endpoint). They differ only by base URL and API key, so the
 * main process drives them all through one generic client.
 */
export type OpenAiCompatProvider = 'google' | 'groq' | 'mistral' | 'cohere'

export type AsrTier = 'auto' | 'on-device' | 'cloud'

export type CloudAsrProvider = 'deepgram' | 'assemblyai' | 'groq'

export type InterviewMode = 'practice' | 'star' | 'live'

/**
 * Which role Hue plays:
 * - 'interviewer': Hue conducts a mock interview — it asks you questions (spoken
 *   aloud) and you practice answering.
 * - 'companion': Hue assists you in a real interview — incoming speech is treated
 *   as the *interviewer's* question and Hue drafts an answer for you (text only,
 *   so it never talks over you or is heard by the interviewer).
 */
export type HueMode = 'interviewer' | 'companion'

/**
 * Where Hue listens:
 * - 'microphone': your mic (echo-cancelled).
 * - 'system': system/loopback audio — the call audio coming out of your speakers
 *   (e.g. the interviewer on Zoom/Meet). Windows-supported via Electron loopback.
 */
export type AudioSource = 'microphone' | 'system'

/** Which ASR tier actually handled a given utterance (for the latency indicator). */
export type ResolvedTier = 'on-device' | 'cloud'

export interface HueSettings {
  /** Which LLM backend powers the assistant: cloud Claude or local Ollama. */
  llmProvider: LlmProvider
  anthropicApiKey: string
  model: string
  ollamaBaseUrl: string
  ollamaModel: string
  asrTier: AsrTier
  cloudAsrProvider: CloudAsrProvider
  deepgramApiKey: string
  assemblyAiApiKey: string
  groqApiKey: string
  /** API keys for the OpenAI-compatible LLM providers. Groq reuses groqApiKey. */
  googleApiKey: string
  mistralApiKey: string
  cohereApiKey: string
  /** Selected model per OpenAI-compatible provider. Empty = auto-pick the first
   *  model the provider lists, so nothing is hardcoded to a version. */
  googleModel: string
  groqModel: string
  mistralModel: string
  cohereModel: string
  ttsVoice: string
  ttsSpeed: number
  /** Opacity of the floating window's background, 0.4–1. Lower = more see-through. */
  windowOpacity: number
  resumeSummary: string
  jobTitle: string
  interviewMode: InterviewMode
  /** Whether Hue acts as the interviewer or as a companion answering the interviewer. */
  hueMode: HueMode
  /** Whether Hue listens to your microphone or to system/call audio. */
  audioSource: AudioSource
  /**
   * Global (system-wide) trigger that starts/stops a session — works even while
   * another app is focused, e.g. mid-call. Either an Electron accelerator string
   * (e.g. "CommandOrControl+Shift+Enter", or a single key like "F9") or a mouse
   * button encoded as "Mouse:Back" / "Mouse:Forward" / "Mouse:Middle" / etc.
   */
  startSessionHotkey: string
  /**
   * Global trigger that shows/hides Hue's window. Same encoding as
   * startSessionHotkey (keyboard accelerator, single key, or "Mouse:<Button>").
   */
  summonHotkey: string
}

export const DEFAULT_SETTINGS: HueSettings = {
  llmProvider: 'anthropic',
  anthropicApiKey: '',
  model: 'claude-opus-4-7',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  asrTier: 'auto',
  cloudAsrProvider: 'deepgram',
  deepgramApiKey: '',
  assemblyAiApiKey: '',
  groqApiKey: '',
  googleApiKey: '',
  mistralApiKey: '',
  cohereApiKey: '',
  googleModel: '',
  groqModel: '',
  mistralModel: '',
  cohereModel: '',
  ttsVoice: 'af_heart',
  ttsSpeed: 1.05,
  windowOpacity: 0.9,
  resumeSummary: '',
  jobTitle: '',
  interviewMode: 'practice',
  hueMode: 'companion',
  audioSource: 'microphone',
  startSessionHotkey: 'CommandOrControl+Shift+Enter',
  summonHotkey: 'CommandOrControl+Shift+Space'
}

/** Keys that are sensitive and stored encrypted at rest via Electron safeStorage. */
export const SECRET_SETTING_KEYS = [
  'anthropicApiKey',
  'deepgramApiKey',
  'assemblyAiApiKey',
  'groqApiKey',
  'googleApiKey',
  'mistralApiKey',
  'cohereApiKey'
] as const

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LlmStreamRequest {
  /** Conversation history (user/assistant turns). */
  messages: LlmMessage[]
  /** Fully-rendered system prompt (built in the renderer from interview context). */
  system: string
  maxTokens?: number
}

export interface LlmDeltaEvent {
  streamId: string
  text: string
}

export interface LlmDoneEvent {
  streamId: string
  /** True when the stream ended because it was aborted (e.g. user interruption). */
  aborted: boolean
}

export interface LlmErrorEvent {
  streamId: string
  message: string
}

/** Result returned by the cloud ASR proxy (Tier 3) in the main process. */
export interface CloudAsrResult {
  text: string
  provider: CloudAsrProvider
}
