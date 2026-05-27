# Hue Desktop — Parakeet-AI-style voice coaching pipeline

## What this project is
- **Location:** `C:\dev-proj\hue-extension-claude\hue-desktop` (NOT `hue-extension-2`; user explicitly redirected here).
- **Stack:** Electron 39 + electron-vite 5 + React 19 + TypeScript 5.9. Package manager: **pnpm** (10.33) — use pnpm for ALL commands (install, typecheck, dev, scripts); never npm/npx.
- **Starting state:** bare electron-vite scaffold (App.tsx/Versions.tsx/ping IPC). No Hue/voice/AI code existed.
- **Structure:** `src/main` (Node), `src/preload` (contextBridge IPC), `src/renderer/src` (React UI). Alias `@renderer` -> `src/renderer/src`.

## Goal
Replicate Parakeet AI's smooth, near-instant transcription + coaching loop inside this Electron app. Three pillars of smoothness: (1) ultra-fast ASR, (2) streaming LLM, (3) streaming TTS, plus fast interruption.

## Key decisions (from user)
- **LLM model: Opus 4.7 = `claude-opus-4-7`** (user chose smartest over fastest; original spec's `claude-opus-4-20250514` is older/likely retired — do NOT use it).
- **Audio source: mic + system loopback (now IMPLEMENTED).** `audioSource` setting toggles mic vs whole-system loopback capture (Windows-only). Originally deferred; since shipped. Note: loopback is the full system mix, not per-app.
- **Hue modes: interviewer vs companion** (now implemented) — Hue either leads the interview or silently suggests answers to what the other party says.
- Build incrementally per the 7-step order; test the voice loop after each step.
- **Parakeet (Tier 2) fully REMOVED** (user decision) — self-hosted NeMo server, its IPC, settings key, and Python script all gone. ASR tiers are now just on-device Whisper + cloud.
- **Cloud LLM providers added:** google/groq/mistral/cohere via OpenAI-compatible wire format (`src/main/openai-compat.ts`), plus ollama and anthropic.
- **Background / tray app + global hotkeys (now IMPLEMENTED, user request).** Hue runs in the system tray "like an extension"; closing the window hides to tray (only tray Quit exits); hidden from the taskbar (`skipTaskbar`). Logo = `resources/letter-h.png` (window + tray). Two global shortcuts: **Ctrl+Shift+Space** (fixed) toggles the window show/hide; a **configurable start-session shortcut** (default `CommandOrControl+Shift+Enter`, set in Settings) starts/stops a session and works while any app is focused. (Design changed from the earlier model where Ctrl+Shift+Space toggled a companion session.) See `mem:implementation_status` "System tray + global shortcuts".

## Electron-adapted architecture (differs from the Chrome-extension spec in the prompt)
- **Main process (Node):** Anthropic streaming calls (API key lives here, never in renderer; stream tokens to renderer via IPC); spawn/manage Parakeet Python server child process (Tier 2 one-click); proxy Tier 3 cloud ASR; settings persistence.
- **Renderer (React):** UI, settings, latency indicator; `getUserMedia` mic capture; VAD (`@ricky0123/vad-web`); Tier 1 Whisper via `@huggingface/transformers` in a Web Worker; Kokoro TTS in a Web Worker; pipeline state machine.
- **Preload:** typed contextBridge IPC bridge.

## ASR tiers (auto-select best available, default on-device)
- on-device: Whisper-base.en (transformers.js worker, q8). Privacy-first default, always-works fallback.
- cloud: Deepgram Nova-3 via main-process proxy (assemblyai/groq are in the type but NOT implemented — they throw).
- (Parakeet Tier 2 REMOVED — see Key decisions.)

## Planned files
- renderer/src/lib/transcription.ts (tier selector, `transcribe(Float32Array)->string`)
- renderer/src/lib/pipeline.ts (VAD->ASR->LLM->TTS orchestrator + interruptions)
- renderer/src/lib/streamingTTS.ts (StreamingTTSQueue, sentence detection, Kokoro)
- renderer/src/workers/whisper.worker.ts, kokoro.worker.ts
- renderer/src/hooks/useVoiceMode.ts
- main/anthropic.ts (streaming + context prefill), main/parakeet.ts, main/asr-cloud.ts, main/settings.ts
- preload/index.ts (IPC + d.ts)
- scripts/start-parakeet-server.py

## Build order / status
1. transcription.ts Tier 1 (Whisper) — IN PROGRESS / first
2. Tier 3 (Deepgram) in transcription.ts
3. StreamingTTSQueue (streamingTTS.ts)
4. Full pipeline.ts (VAD->ASR->Claude stream->TTS)
5. Interruption handling
6. Parakeet server script (Tier 2)
7. Transcription settings UI in renderer (tier selector, server URL, API keys, latency indicator)

## Testing caveat
Assistant cannot fully exercise the live voice loop or global hotkeys/tray (needs mic, API keys, a real desktop session). Will typecheck + (eslint) and clearly flag what needs owner runtime testing via `pnpm dev`. (Parakeet/GPU no longer relevant — removed.)
