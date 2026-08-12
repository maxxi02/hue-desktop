import { useCallback, useEffect, useRef, useState } from 'react'
import { VoicePipeline, type PipelineState } from '../lib/pipeline'
import { preloadOnDeviceModel } from '../lib/transcription'
import { preloadTtsModel } from '../lib/streamingTTS'
import { isLlmConfigured, playGreeting } from '../lib/greeting'
import type { AudioSource, HueMode, ResolvedTier, ScreenCapture } from '@shared/types'
import type { Grounding } from '@shared/grounding'
import type { CueCard, CueSheet } from '@shared/cuesheet'

export interface VoiceTurn {
  text: string
  tier: ResolvedTier
  latencyMs: number
}

/**
 * A finished assistant turn: the text as it should be read, plus its grounding
 * receipt (null when a receipt does not apply to the turn).
 *
 * Delivered as one object rather than as a separate `grounding` field so the
 * transcript can never pair a receipt with a different turn's text. `id` makes a
 * repeated identical answer still register as a new turn.
 */
export interface AssistantResult {
  text: string
  grounding: Grounding | null
  id: number
}

/** A screen capture, tagged with a unique id so repeats still register as new. */
export interface CaptureTurn {
  shot: ScreenCapture
  id: number
}

export interface UseVoiceMode {
  state: PipelineState
  active: boolean
  /** True while the session is starting up (downloading models / initializing the VAD). */
  connecting: boolean
  userTranscript: VoiceTurn | null
  /** Most recent screen capture taken during the session (for the transcript thumbnail). */
  capture: CaptureTurn | null
  assistantText: string
  /** The last completed assistant turn, carrying its grounding receipt. */
  assistantResult: AssistantResult | null
  /**
   * The prepared cue card latched onto the current question, or null when
   * nothing is latched. Mirrors `onCueCard` exactly — the pipeline is the
   * source of truth for when a card appears and when it clears (a new
   * question, a barge-in, or the session tearing down).
   */
  cueCard: CueCard | null
  /**
   * The whole armed cue sheet for the running session, or null when none is
   * armed. Set once at session start and held for the session, so the document
   * panel can be read between questions rather than only at the moment a card
   * latches — `cueCard` says *where you are* in this sheet, this says *what the
   * sheet is*.
   */
  cueSheet: CueSheet | null
  /** LLM-generated launch greeting from Hue (streamed). Empty until Hue has greeted. */
  greetingText: string
  error: string | null
  /** Current configured mode/source (for UI labeling). Reflects saved settings. */
  mode: HueMode
  audioSource: AudioSource
  /** Re-read mode/source from settings (call after the settings drawer closes). */
  reloadConfig: () => void
  start: () => Promise<void>
  stop: () => Promise<void>
  /** Capture the screen and ask the assistant about it (no-op if no session). */
  captureScreen: () => Promise<void>
  /** Wipe the conversation: LLM history, last transcript, and the launch greeting. */
  clear: () => void
}

export function useVoiceMode(): UseVoiceMode {
  const [state, setState] = useState<PipelineState>('idle')
  const [userTranscript, setUserTranscript] = useState<VoiceTurn | null>(null)
  const [capture, setCapture] = useState<CaptureTurn | null>(null)
  const [assistantText, setAssistantText] = useState('')
  const [assistantResult, setAssistantResult] = useState<AssistantResult | null>(null)
  const [cueCard, setCueCard] = useState<CueCard | null>(null)
  const [cueSheet, setCueSheet] = useState<CueSheet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<HueMode>('companion')
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone')
  const pipelineRef = useRef<VoicePipeline | null>(null)
  const [greetingText, setGreetingText] = useState('')
  const greetedRef = useRef(false)
  const cancelGreetingRef = useRef<(() => void) | null>(null)

  const reloadConfig = useCallback((): void => {
    void window.hue.settings.get().then((s) => {
      setMode(s.hueMode)
      setAudioSource(s.audioSource)
      // Warm the on-device models as soon as the saved settings are known (app
      // launch, and again when the settings drawer closes) so the first session
      // doesn't pay the model download/init cost while "Connecting". Follows the
      // same companion rules as start() below; skipped while a session is
      // running so a mid-session settings save can't move Whisper across
      // devices under a live call (start() already loaded the right config).
      if (!pipelineRef.current) {
        const companion = s.hueMode === 'companion'
        preloadOnDeviceModel({ preferWasm: companion })
        if (!companion) preloadTtsModel()
      }
      // Greet once, the first time a usable LLM config is seen (on launch or
      // right after the user saves a key). A successful streamed reply confirms
      // the LLM is reachable. Skipped while a session is running.
      if (!greetedRef.current && !pipelineRef.current && isLlmConfigured(s)) {
        greetedRef.current = true
        cancelGreetingRef.current = playGreeting(s, {
          onText: setGreetingText,
          onError: (m) => setError(m)
        })
      }
    })
  }, [])

  useEffect(() => reloadConfig(), [reloadConfig])
  useEffect(() => () => cancelGreetingRef.current?.(), [])

  const start = useCallback(async (): Promise<void> => {
    if (pipelineRef.current) return
    setError(null)
    // A greeting may still be streaming/speaking; stop it so it doesn't overlap.
    cancelGreetingRef.current?.()
    cancelGreetingRef.current = null

    const settings = await window.hue.settings.get()
    setMode(settings.hueMode)
    setAudioSource(settings.audioSource)

    // Warm up the models so the first turn isn't slow. In companion mode (a live
    // call) we deliberately keep both models off the GPU: the call's WebRTC stack
    // already saturates it, and piling fp32 models on top has exhausted VRAM and
    // frozen underpowered machines mid-interview.
    //   - TTS (Kokoro) is SKIPPED entirely: companion replies are text-only
    //     (VoicePipeline.speakResponses is false), so loading it is pure waste.
    //   - ASR (Whisper) still runs, but is pinned to the wasm/CPU path so it
    //     never competes with the call for the GPU.
    const companion = settings.hueMode === 'companion'
    preloadOnDeviceModel({ preferWasm: companion })
    if (!companion) preloadTtsModel()
    // Each UI update is also mirrored to the phone page (no-op while the
    // phone-mirror server is off — the main process just drops the event).
    const pipeline = new VoicePipeline(settings, {
      onStateChange: (st) => {
        setState(st)
        window.hue.phone.event({ type: 'state', text: st })
      },
      onUserTranscript: (text, tier, latencyMs) => {
        setUserTranscript({ text, tier, latencyMs })
        setAssistantText('')
        setAssistantResult(null)
        window.hue.phone.event({ type: 'question', text })
      },
      onScreenCapture: (shot) => {
        setCapture({ shot, id: Date.now() })
        setAssistantText('')
        setAssistantResult(null)
        window.hue.phone.event({ type: 'question', text: 'Shared a screen capture' })
      },
      onAssistantText: (text) => {
        setAssistantText(text)
        window.hue.phone.event({ type: 'answer', text })
      },
      onAssistantComplete: (text, grounding) => {
        setAssistantResult({ text, grounding, id: Date.now() })
        // The phone mirror gets the final text too, so a stripped citation or a
        // last delta that never made it there cannot leave the two out of sync.
        window.hue.phone.event({ type: 'answer', text })
      },
      onError: setError,
      onCueCard: setCueCard,
      onCueSheet: setCueSheet
    })
    pipelineRef.current = pipeline
    try {
      await pipeline.start()
    } catch (e) {
      pipelineRef.current = null
      setError(e instanceof Error ? e.message : String(e))
      setState('idle')
    }
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    const pipeline = pipelineRef.current
    if (!pipeline) return
    pipelineRef.current = null
    await pipeline.stop()
  }, [])

  const captureScreen = useCallback(async (): Promise<void> => {
    await pipelineRef.current?.captureScreen()
  }, [])

  const clear = useCallback((): void => {
    pipelineRef.current?.clearHistory()
    setUserTranscript(null)
    setCapture(null)
    setAssistantText('')
    setAssistantResult(null)
    setGreetingText('')
    window.hue.phone.event({ type: 'clear' })
  }, [])

  // Configurable global start-session hotkey (and the tray's "Start / stop"):
  // toggles a session using the saved settings, exactly like the Start button.
  // pipelineRef is set synchronously on start, so it's a reliable "is a session
  // running" check even before state updates.
  useEffect(() => {
    return window.hue.hotkey.onToggleSession(() => {
      if (pipelineRef.current) {
        void stop()
      } else {
        void start()
      }
    })
  }, [start, stop])

  // Global capture-screen hotkey: snapshot the screen and ask about it. Only acts
  // while a session is running (the pipeline owns the LLM wiring and history).
  useEffect(() => {
    return window.hue.hotkey.onCaptureScreen(() => {
      if (pipelineRef.current) void captureScreen()
    })
  }, [captureScreen])

  return {
    state,
    active: state !== 'idle',
    connecting: state === 'connecting',
    userTranscript,
    capture,
    assistantText,
    assistantResult,
    cueCard,
    cueSheet,
    greetingText,
    error,
    mode,
    audioSource,
    reloadConfig,
    start,
    stop,
    captureScreen,
    clear
  }
}
