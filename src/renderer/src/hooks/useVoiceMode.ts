import { useCallback, useEffect, useRef, useState } from 'react'
import { VoicePipeline, type PipelineState } from '../lib/pipeline'
import { preloadOnDeviceModel, unloadOnDeviceModel } from '../lib/transcription'
import { preloadTtsModel, unloadTtsModel } from '../lib/streamingTTS'
import { isLlmConfigured, playGreeting } from '../lib/greeting'
import type { AudioSource, HueMode, ResolvedTier, ScreenCapture } from '@shared/types'
import type { Grounding } from '@shared/grounding'

export interface VoiceTurn {
  text: string
  tier: ResolvedTier
  latencyMs: number
  /**
   * Identifies this utterance, the way `capture` and `assistantResult` already
   * do. Without it the transcript deduped on text alone, so an interviewer who
   * repeated a phrase — "Right.", "Sorry, say that again?", or genuinely
   * re-asking the same question — produced no new user bubble, and the answer
   * that followed replaced the previous answer's slot instead of appending. The
   * earlier answer simply vanished from the transcript.
   */
  id: number
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
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<HueMode>('companion')
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone')
  const pipelineRef = useRef<VoicePipeline | null>(null)
  /**
   * A session is "running" from the first line of start(), not from the moment
   * the pipeline object exists — model loading and VAD init sit in between, and
   * every double-start and orphaned-microphone bug lived in that gap.
   */
  const startingRef = useRef(false)
  /** A stop that arrived mid-start, to be honoured once start() finishes. */
  const stopRequestedRef = useRef(false)
  const [greetingText, setGreetingText] = useState('')
  /**
   * Whether to hand the models back when this session ends, captured at start()
   * from the memory policy. A ref rather than state because `stop()` reads it
   * and must not be rebuilt (and re-registered on the toggle hotkey) every time
   * the policy is re-read.
   */
  const unloadOnIdleRef = useRef(false)
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
      //
      // Skipped entirely on a machine without the memory to spare. Warming here
      // means holding ~400-700 MB resident from launch for a session the user
      // may not start for an hour, and on a constrained machine that is what
      // pushes free memory to zero and starts the OS paging — which is felt as
      // the whole PC slowing down, not as Hue being slow. There the models load
      // at start() instead: a visible delay on the first turn, attributable to
      // the thing that caused it.
      if (!pipelineRef.current) {
        void window.hue.system.memory().then((policy) => {
          if (!policy.preloadModels || pipelineRef.current) return
          const companion = s.hueMode === 'companion'
          preloadOnDeviceModel({ preferWasm: companion || policy.preferWasm })
          if (!companion) preloadTtsModel()
        })
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
    // `pipelineRef` alone is not a sufficient guard: it is assigned several
    // awaits into this function, so two starts inside that window both passed it
    // and built two pipelines on the same microphone — doubled transcripts,
    // doubled LLM spend, and only the second one reachable by stop(). The first
    // kept the mic and the loopback capture open for the life of the app.
    if (pipelineRef.current || startingRef.current) return
    startingRef.current = true
    stopRequestedRef.current = false
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
    // `preferWasm` now has a second reason beyond companion mode: a constrained
    // machine or an integrated GPU, where fp32-on-WebGPU is both the larger
    // resident footprint and an allocation out of the same system RAM the
    // desktop compositor is using. `unloadOnIdle` is captured here so stop()
    // uses the policy this session was started under.
    const policy = await window.hue.system.memory()
    unloadOnIdleRef.current = policy.unloadOnIdle
    preloadOnDeviceModel({ preferWasm: companion || policy.preferWasm })
    if (!companion) preloadTtsModel()
    // Each UI update is also mirrored to the phone page (no-op while the
    // phone-mirror server is off — the main process just drops the event).
    const pipeline = new VoicePipeline(settings, {
      onStateChange: (st) => {
        setState(st)
        window.hue.phone.event({ type: 'state', text: st })
      },
      onUserTranscript: (text, tier, latencyMs) => {
        // A new question clears the last failure. Errors were only ever reset at
        // start(), so one transient fault — a single dropped ASR request, one
        // bad LLM response — left a red banner pinned under the answer, and in
        // glance mode directly under the text being read, for the rest of the
        // session. The next successful turn is the strongest possible evidence
        // that the previous failure is over.
        setError(null)
        setUserTranscript({ text, tier, latencyMs, id: Date.now() })
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
      onError: setError
    })
    pipelineRef.current = pipeline
    try {
      await pipeline.start()
      // A stop that arrived while the models were loading found nothing to tear
      // down — `stop()` ran before the VAD existed — and then start() finished
      // and brought the microphone up anyway, with no reference left to shut it
      // off. Honour the request now that there is something to honour it with.
      if (stopRequestedRef.current) {
        pipelineRef.current = null
        await pipeline.stop()
        setState('idle')
      }
    } catch (e) {
      pipelineRef.current = null
      setError(e instanceof Error ? e.message : String(e))
      setState('idle')
    } finally {
      startingRef.current = false
      stopRequestedRef.current = false
    }
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    // Mid-start there is nothing to stop yet; record the intent and let start()
    // act on it once the pipeline is real.
    if (startingRef.current) {
      stopRequestedRef.current = true
      return
    }
    const pipeline = pipelineRef.current
    if (!pipeline) return
    pipelineRef.current = null
    await pipeline.stop()
    // On a constrained machine the models come down with the session. Holding
    // them between sessions is what turns "Hue is open" into "the PC is
    // paging" — the user is not talking to it, but it is still occupying the
    // memory everything else needs. After the pipeline has stopped, so the VAD
    // and the TTS queue have already released their own handles.
    if (unloadOnIdleRef.current) {
      unloadOnDeviceModel()
      unloadTtsModel()
    }
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
      // "Starting" counts as running, or the hotkey pressed during model load
      // would start a second session instead of cancelling the first.
      if (pipelineRef.current || startingRef.current) {
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
