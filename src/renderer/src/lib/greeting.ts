import { StreamingTTSQueue } from './streamingTTS'
import type { HueSettings, LlmDeltaEvent, LlmDoneEvent, LlmErrorEvent } from '@shared/types'

export interface GreetingCallbacks {
  /** Cumulative greeting text as it streams in. */
  onText?: (text: string) => void
  onDone?: () => void
  onError?: (message: string) => void
}

/**
 * Whether the configured LLM provider has the minimum settings to attempt a
 * call. Reachability (and, for Anthropic, key validity) is only truly confirmed
 * by actually calling the LLM — which is exactly what the greeting does.
 */
export function isLlmConfigured(s: HueSettings): boolean {
  switch (s.llmProvider) {
    case 'anthropic':
      return s.anthropicApiKey.trim() !== ''
    case 'ollama':
      return s.ollamaBaseUrl.trim() !== '' && s.ollamaModel.trim() !== ''
    case 'google':
      return s.googleApiKey.trim() !== ''
    case 'groq':
      return s.groqApiKey.trim() !== ''
    case 'mistral':
      return s.mistralApiKey.trim() !== ''
    case 'cohere':
      return s.cohereApiKey.trim() !== ''
    default:
      return false
  }
}

/**
 * One-shot, spoken, LLM-generated greeting from Hue. Doubles as a connectivity
 * check: a successful streamed reply means the configured LLM key/endpoint
 * actually works. Independent of the voice session (no VAD/mic), so it can run
 * on launch or right after the user saves a valid config.
 *
 * Returns a cancel function — call it to abort the greeting (e.g. when the user
 * starts a session before it finishes) so its audio never overlaps the session.
 */
export function playGreeting(settings: HueSettings, callbacks: GreetingCallbacks = {}): () => void {
  const tts = new StreamingTTSQueue({ voice: settings.ttsVoice, speed: settings.ttsSpeed })
  const streamId = crypto.randomUUID()
  let text = ''
  const unsubscribe: Array<() => void> = []

  const cleanup = (): void => {
    unsubscribe.forEach((u) => u())
    unsubscribe.length = 0
  }

  unsubscribe.push(
    window.hue.llm.onDelta((e: LlmDeltaEvent) => {
      if (e.streamId !== streamId) return
      text += e.text
      tts.appendText(e.text)
      callbacks.onText?.(text)
    }),
    window.hue.llm.onDone((e: LlmDoneEvent) => {
      if (e.streamId !== streamId) return
      tts.flush()
      cleanup()
      callbacks.onDone?.()
    }),
    window.hue.llm.onError((e: LlmErrorEvent) => {
      if (e.streamId !== streamId) return
      tts.interrupt()
      cleanup()
      callbacks.onError?.(e.message)
    })
  )

  void window.hue.llm.start(streamId, {
    messages: [
      {
        role: 'user',
        content:
          'Greet me in one or two short, warm sentences. Introduce yourself as Hue and say you are ready ' +
          'to help me prepare for my interview. Do not ask a question yet.'
      }
    ],
    system: buildGreetingPrompt(settings),
    maxTokens: 120
  })

  return (): void => {
    window.hue.llm.abort(streamId)
    tts.interrupt()
    cleanup()
  }
}

function buildGreetingPrompt(s: HueSettings): string {
  const role = s.jobTitle ? ` The user is preparing for a ${s.jobTitle} interview.` : ''
  return (
    'You are Hue, a friendly real-time interview companion.' +
    role +
    ' Greet the user warmly and concisely, speaking in the first person as Hue. Output only the greeting.'
  )
}
