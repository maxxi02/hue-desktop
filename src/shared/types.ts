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

/**
 * Where the floating window parks itself.
 *
 * The nine grid values dock Hue to a corner, an edge midpoint, or the centre of
 * whichever display it is on, inset by `windowAnchorMargin`. `'free'` means the
 * user places it themselves — dragging the header switches the setting back to
 * `'free'` rather than snapping the window home, because an overlay that fights
 * the mouse reads as broken.
 */
export type WindowAnchor =
  | 'free'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

/** A screen-space window rectangle, in the same shape as Electron's `Rectangle`. */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

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
  /**
   * Where the window docks: one of the nine anchor points, or `'free'`.
   *
   * Defaults to `'free'` so an existing install is never surprised by its window
   * jumping to a corner on upgrade — and `'free'` is not a no-op, it restores
   * `windowFreeBounds`, which is what stops the position resetting every launch.
   * Anchoring is computed against the *work area* of the display the window is
   * on, so a bottom anchor sits above the taskbar and a second monitor is
   * anchored to itself rather than to the primary.
   */
  windowAnchor: WindowAnchor
  /**
   * Inset in pixels between the window and the work-area edge when anchored.
   *
   * Non-zero by default: flush against the edge the card's shadow is clipped and
   * it reads as a torn-off panel rather than as a floating companion.
   */
  windowAnchorMargin: number
  /**
   * The last position the window was dragged to, restored when `windowAnchor`
   * is `'free'`. `null` until the window has been moved once, in which case the
   * OS picks the initial placement as before.
   *
   * Stored as a full rectangle rather than a point so a resized window comes
   * back the size it was left. It is validated against the displays present at
   * restore time — a position saved on a monitor that has since been unplugged
   * is clamped back into view, not restored into the void.
   */
  windowFreeBounds: WindowBounds | null
  /**
   * The old freeform resume text: the whole document pasted into the prompt.
   *
   * Superseded by `profileBundleJson`, and kept only so an existing install
   * does not lose its background on upgrade. When a bundle is present it wins;
   * this is the fallback, and nothing writes to it any more.
   */
  resumeSummary: string
  /**
   * The structured `ProfileBundle` from hue-ingest, stored as JSON.
   *
   * Serialised rather than nested because settings are a flat, user-editable
   * document and a malformed bundle must be recoverable by clearing one field
   * rather than by hand-repairing a nested object.
   */
  profileBundleJson: string
  /** hue-ingest account credentials. Never leaves the main process. */
  ingestAccountId: string
  ingestAccountToken: string
  /** Overridable so a self-hosted ingest deployment is a setting, not a fork. */
  ingestBaseUrl: string
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
  /**
   * Global trigger that grabs the primary screen and asks the assistant about it
   * (e.g. a coding prompt the interviewer is screen-sharing). Same encoding as
   * the other hotkeys. Only fires while a session is active.
   */
  captureScreenHotkey: string
  /**
   * Whether the phone-mirror server runs: a token-authenticated LAN HTTP server
   * that streams the session (question + suggested answer) to a phone browser.
   */
  phoneMirrorEnabled: boolean
  /**
   * Whether the session is mirrored to the Hue phone app through the cloud relay
   * (works on cellular), as opposed to the LAN-only phone mirror above.
   */
  relayEnabled: boolean
  /** Base URL of the hue-relay deployment, e.g. https://relay.hue.app */
  relayBaseUrl: string
  /**
   * Stealth mode: keeps Hue's window off screen captures and screen shares.
   *
   * Electron's `setContentProtection` maps to `SetWindowDisplayAffinity` with
   * `WDA_EXCLUDEFROMCAPTURE` on Windows 10 2004+ and to
   * `NSWindowSharingNone` on macOS, so the card stays visible on the physical
   * display while capture APIs — the ones Zoom, Teams, Meet and OBS use — read
   * it as empty.
   *
   * It is a window-level flag and nothing more: it does not hide the process,
   * the tray icon, or the audio devices Hue opens, and it cannot survive a
   * camera pointed at the screen. On Linux, and on Windows builds older than
   * 10 2004, the platform offers no equivalent and the flag is inert.
   */
  stealthMode: boolean
  /**
   * Speculative answer drafting: start generating an answer from the *interim*
   * transcript, while the interviewer is still speaking, and commit that draft
   * when the final transcript agrees with what it was drafted from.
   *
   * Off by default. It removes most of the LLM's generation time from the
   * critical path, but it pays for that with extra output tokens on every draft
   * that turns out to be wrong — so it stays opt-in until its hit rate has been
   * measured on real sessions. Companion mode only: in interviewer mode the
   * incoming voice is the *user's*, and drafting an answer to it is precisely
   * the failure the scheduler's `self` speaker guard exists to prevent.
   */
  speculativeDrafting: boolean
  /** Which cue sheet is armed for the next session. Empty means none. */
  selectedCueSheetId: string
}

export const DEFAULT_SETTINGS: HueSettings = {
  llmProvider: 'anthropic',
  anthropicApiKey: '',
  model: 'claude-opus-4-8',
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
  windowAnchor: 'free',
  windowAnchorMargin: 16,
  windowFreeBounds: null,
  resumeSummary: '',
  profileBundleJson: '',
  ingestAccountId: '',
  ingestAccountToken: '',
  ingestBaseUrl: 'http://localhost:8788',
  jobTitle: '',
  interviewMode: 'practice',
  hueMode: 'companion',
  audioSource: 'microphone',
  startSessionHotkey: 'CommandOrControl+Shift+Enter',
  summonHotkey: 'CommandOrControl+Shift+Space',
  captureScreenHotkey: 'CommandOrControl+Shift+S',
  phoneMirrorEnabled: false,
  relayEnabled: false,
  relayBaseUrl: 'http://localhost:8787',
  stealthMode: false,
  speculativeDrafting: false,
  selectedCueSheetId: ''
}

/** Keys that are sensitive and stored encrypted at rest via Electron safeStorage. */
export const SECRET_SETTING_KEYS = [
  // Reads the user's entire career history from hue-ingest, so it is a secret
  // in exactly the sense the others are.
  'ingestAccountToken',
  'anthropicApiKey',
  'deepgramApiKey',
  'assemblyAiApiKey',
  'groqApiKey',
  'googleApiKey',
  'mistralApiKey',
  'cohereApiKey'
] as const

/** A plain-text part of a message. */
export interface LlmTextBlock {
  type: 'text'
  text: string
}

/** An image part of a message (e.g. a screen capture), base64-encoded. */
export interface LlmImageBlock {
  type: 'image'
  /** A base64-supported image type, e.g. 'image/png'. */
  mediaType: ImageMediaType
  /** Raw base64 (no data: URI prefix). */
  dataBase64: string
}

export type LlmContentBlock = LlmTextBlock | LlmImageBlock

/** Image formats every vision-capable provider here accepts. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface LlmMessage {
  role: 'user' | 'assistant'
  /**
   * Either a plain string (text-only turn, the common case) or an ordered list of
   * content blocks for multimodal turns (text + image). Kept as a union so every
   * existing text turn stays a bare string and only screen-capture turns carry blocks.
   */
  content: string | LlmContentBlock[]
}

/** A screenshot captured in the main process, ready to attach to a message. */
export interface ScreenCapture {
  /** Raw base64 PNG (no data: URI prefix). */
  dataBase64: string
  mediaType: ImageMediaType
  /** Pixel dimensions of the (possibly downscaled) capture. */
  width: number
  height: number
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

/**
 * An event mirrored to the phone page over SSE:
 * - 'question': the interviewer's transcribed question (text).
 * - 'answer': Hue's suggested answer so far — cumulative, the page replaces it.
 * - 'state': the pipeline state name, for the phone's status pill.
 * - 'clear': the conversation was reset; the page empties both blocks.
 */
export interface PhoneMirrorEvent {
  type: 'question' | 'answer' | 'state' | 'clear'
  text?: string
}

export interface PhoneMirrorStatus {
  running: boolean
  /** Full URL to open on the phone (includes the auth token); '' when stopped. */
  url: string
}

/**
 * Everything a phone needs to subscribe to a relay room. Encoded into the QR
 * code the desktop shows in Settings. The subscribe token grants read-only
 * access to one session and dies with it.
 */
export interface RelayPairing {
  relayBaseUrl: string
  roomId: string
  subscribeToken: string
}

export interface RelayStatus {
  running: boolean
  /** `hue://pair?...` URI for the QR code; '' when not running. */
  pairingUri: string
  /** Last registration/publish failure, surfaced in Settings; null when healthy. */
  error: string | null
}

/**
 * Stealth reported back to the renderer. `enabled` and `effective` are kept
 * apart on purpose: the user can switch stealth on anywhere, but only a
 * platform with a real "exclude from capture" primitive makes it effective, and
 * the UI must show the second rather than the first — a badge that lights up on
 * Linux would be a lie the user acts on during an interview.
 */
export interface StealthStatus {
  /** The persisted `stealthMode` setting. */
  enabled: boolean
  /** Whether the window is genuinely excluded from capture right now. */
  effective: boolean
  /** Whether this platform can suppress capture at all. */
  supported: boolean
}
