---
tags: [architecture, voice, ml]
created: 2026-06-02
---

# Voice Pipeline

The heart of Hue. It runs **in the renderer** (`src/renderer/src/lib/pipeline.ts`, orchestrated by the `useVoiceMode` hook) and drives a continuous voice turn loop. Heavy ML runs in Web Workers so the UI stays responsive.

## Turn loop
```
Audio in → VAD → ASR (transcribe) → LLM (stream) → TTS (stream) → Audio out
```

Pipeline states (`PipelineState`): `idle → connecting → listening → transcribing → thinking → speaking`.

## Stages

### 1. Voice Activity Detection
- **`@ricky0123/vad-web`** (`MicVAD`) detects speech start/end so Hue only transcribes actual utterances.
- Audio captured via `getUserMedia` (mic) or `getDisplayMedia` loopback (system audio — see [[Architecture]]).

### 2. ASR / Transcription (`lib/transcription.ts`)
Tiered, chosen by `asrTier` setting (`auto` | `on-device` | `cloud`):
- **On-device** — **Whisper** via `@huggingface/transformers` in `workers/whisper.worker.ts`, running on **WebGPU** with a **wasm fallback**.
- **Cloud** — proxied through the main process (`asr-cloud.ts`) so API keys never reach the renderer: **Deepgram**, **Groq**, **AssemblyAI**. Receives raw 16-bit PCM mono @ 16 kHz.
- Each result reports a `ResolvedTier` (`on-device` | `cloud`) and `latencyMs` for the UI latency indicator.

### 3. LLM (streaming)
- The renderer requests a streamed completion over IPC; the main process talks to the provider and streams `LlmDeltaEvent` / `LlmDoneEvent` / `LlmErrorEvent` back.
- Provider chosen by `llmProvider`. See [[LLM & ASR Providers]].
- Prompt is personalized with the resume summary + job title (`lib/resume.ts`), and shaped by `hueMode` (interviewer vs companion) and `interviewMode`.

### 4. TTS (`lib/streamingTTS.ts`)
- **Kokoro** (`kokoro-js`) via `@huggingface/transformers` in `workers/kokoro.worker.ts`, on **WebGPU** with **wasm fallback**.
- Streams audio **chunk-by-chunk** (`StreamingTTSQueue`) so Hue starts speaking before the whole answer is generated.
- Configurable `ttsVoice` and `ttsSpeed`.
- In **Companion mode**, TTS is suppressed — answers are text only.

## Greeting
On session start Hue plays an LLM-generated launch greeting (`lib/greeting.ts`), streamed and spoken.

## Model loading
Both workers report a load state: `idle → loading(progress) → ready(device: webgpu | wasm) → error`. Models are preloaded (`preloadOnDeviceModel`, `preloadTtsModel`) so the first turn isn't slow.

## Key files
- `lib/pipeline.ts` — orchestrator & state machine
- `hooks/useVoiceMode.ts` — React integration
- `lib/transcription.ts` + `workers/whisper.worker.ts` — ASR
- `lib/streamingTTS.ts` + `workers/kokoro.worker.ts` — TTS
- `lib/micRecorder.ts` — capture/PCM conversion
- `lib/greeting.ts`, `lib/resume.ts`, `lib/resumeCleanup.ts`

Related: [[Architecture]] · [[LLM & ASR Providers]]
