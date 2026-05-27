# Implementation status & key interfaces

(See `mem:project_overview_and_plan` for goal, decisions, architecture.)

Core 7 build steps code-complete + several follow-ups landed (cloud LLM providers, Parakeet removal, gapless TTS, system-audio/companion mode, **background system-tray app + global hotkeys**). Typecheck (node+web) and eslint pass clean (eslint shows only pre-existing CRLF `Delete ␍` prettier warnings on Windows — 0 errors). Runtime-verified in parts; full mic/model/key + tray/hotkey smoke test still owner-run via `pnpm dev`.

## Foundation
- Deps: `@huggingface/transformers@4.2.0`, `@anthropic-ai/sdk`, `kokoro-js`, `@ricky0123/vad-web@0.0.30`. Package manager: **pnpm** (`pnpm-lock.yaml`). Use pnpm for EVERYTHING — never npm/npx. Commands: `pnpm install`, `pnpm run typecheck`, `pnpm dev`, `pnpm run <script>`.
- `src/shared/types.ts`:
  - `LlmProvider = 'anthropic' | 'ollama' | 'google' | 'groq' | 'mistral' | 'cohere'`.
  - `OpenAiCompatProvider = 'google' | 'groq' | 'mistral' | 'cohere'` (speak OpenAI Chat Completions wire format).
  - `AsrTier = 'auto' | 'on-device' | 'cloud'`; `ResolvedTier = 'on-device' | 'cloud'` (Parakeet tier REMOVED).
  - `CloudAsrProvider = 'deepgram' | 'assemblyai' | 'groq'`.
  - `HueMode = 'interviewer' | 'companion'`; `AudioSource = 'microphone' | 'system'`.
  - `InterviewMode = 'practice' | 'star' | 'live'`.
  - `HueSettings`, `DEFAULT_SETTINGS` (model `claude-opus-4-7`, llmProvider `anthropic`, ttsVoice `af_heart`, ttsSpeed 1.05, asrTier `auto`, cloudAsrProvider `deepgram`, hueMode `companion`, audioSource `microphone`, **`startSessionHotkey: 'CommandOrControl+Shift+Enter'`**). NO `parakeetServerUrl`.
  - `LlmMessage/LlmStreamRequest/LlmDelta|Done|ErrorEvent`, `CloudAsrResult`, `SECRET_SETTING_KEYS`.
- `src/main/settings.ts`: JSON in userData; secrets encrypted via `safeStorage` (prefix `enc:v1:`). `getSettings()` returns DECRYPTED secrets to renderer. `updateSettings(partial)`.
- `src/main/anthropic.ts`: `startLlmStream` + `abortLlmStream`. Anthropic key never leaves main.
- `src/main/openai-compat.ts`: `startOpenAiCompatStream`/`abortOpenAiCompatStream`/`fetchOpenAiModels(provider, apiKey)`/`isOpenAiCompatProvider`. Handles google/groq/mistral/cohere via OpenAI-compatible endpoints. Keys stay in main.
- `src/main/ollama.ts`: `startOllamaStream`/`abortOllamaStream`/`fetchOllamaModels(baseUrl)`.
- `src/main/index.ts`: `registerIpc()`; permission handlers; **`setDisplayMediaRequestHandler` grants `audio:'loopback'` for system-audio capture** (see Audio capture below). COOP/COEP deliberately OFF (see `mem:onnxruntime_web_gotchas`). **Background app:** window `skipTaskbar:true` (tray-only, no taskbar/alt-tab); window `icon` + tray use `resources/letter-h.png` (the Hue "H" logo, swapped from `icon.png`); `close` event is intercepted (`e.preventDefault()` + `win.hide()`) unless `isQuitting`, so closing hides to tray instead of quitting; `createTray()` builds the Tray + context menu (Show Hue / Start-stop session / Quit). `window-all-closed` only quits when `isQuitting`; `before-quit` sets `isQuitting`; `will-quit` calls `unregisterAllHotkeys()`.
- `src/main/hotkeys.ts`: owns the two global shortcuts (see "Global shortcuts" below).
- `src/preload/index.ts` exposes `window.hue`. Aliases `@renderer`, `@shared`. Renderer `worker.format:'es'`.

## IPC channels (src/main/ipc.ts)
- invoke `hue:settings:get` -> HueSettings; `hue:settings:set`(partial) -> HueSettings
- invoke `hue:llm:start`(streamId, LlmStreamRequest) — routes by provider: ollama / openai-compat / anthropic; send `hue:llm:abort`(streamId) aborts all three (only owner acts)
- main->renderer: `hue:llm:delta`{streamId,text}, `hue:llm:done`{streamId,aborted}, `hue:llm:error`{streamId,message}
- invoke `hue:ollama:models`(baseUrl); invoke `hue:llm:models`(provider, apiKey)
- invoke `hue:asr:cloud`(pcm16: ArrayBuffer) -> CloudAsrResult
- `hue:settings:set` handler diffs `summonHotkey`/`startSessionHotkey` vs previous and calls `applyHotkeys()` to re-bind the global triggers live.
- main->renderer: `hue:hotkey:toggle-session` (fired by the start-session shortcut or the tray's "Start / stop session"; renderer toggles the voice session).
- (Parakeet IPC `hue:asr:parakeet` / `hue:parakeet:health` REMOVED.)

## window.hue (preload) shape
`{ settings:{get,set}, llm:{start,abort,onDelta,onDone,onError,models}, ollama:{models}, asr:{cloud}, hotkey:{onToggleSession} }`

## System tray + global shortcuts (background app)
- Hue runs as a **background / tray app** ("like an extension"): closing the window hides it to the tray; only the tray's "Quit Hue" truly exits. Not shown in the taskbar (`skipTaskbar:true`).
- `src/main/hotkeys.ts`: `initHotkeys(windowGetter)`, `applyHotkeys()`, `summon()`, `toggleVisibility()`, `toggleSession()`, `unregisterAllHotkeys()`.
  - **Triggers are now CONFIGURABLE for both summon and start-session.** A trigger string is either an Electron accelerator (incl. single keys like `F9`) OR a mouse button encoded `Mouse:<Name>` (`Back`/`Forward`/`Middle`/`Right`). `registerTrigger()` routes keyboard → `globalShortcut`, mouse → a `uIOhook` `mousedown` matcher.
  - **uiohook-napi** native module (N-API, prebuilt, externalized in `electron.vite.config.ts` main.rollupOptions; in pnpm `onlyBuiltDependencies`) provides the global mouse hook so mouse buttons fire even when another app is focused. Hook is passive (never consumes the event — the button still works in the focused app). Started in `initHotkeys`, stopped in `unregisterAllHotkeys` (on `will-quit`). uIOhook mouse button numbers: 1=L,2=R,3=Mid,4=Back(X1),5=Forward(X2); DOM capture numbers differ (3=Back,4=Forward) — see `domButtonName` in Settings.
  - **Summon** (default `CommandOrControl+Shift+Space`, setting `summonHotkey`) -> `toggleVisibility()`: if window visible AND focused -> `win.hide()`; else bring to front. Tray uses show-only `summon()`.
  - **Start-session** (default `CommandOrControl+Shift+Enter`, setting `startSessionHotkey`) -> `toggleSession()`: brings window forward + sends `hue:hotkey:toggle-session`.

## ASR
- `workers/whisper.worker.ts`: transformers.js `Xenova/whisper-base.en`, `dtype:'q8'`, `device:'wasm'` (q4 is broken on this ORT — see `mem:onnxruntime_web_gotchas` §2). mono Float32 @16kHz.
- `lib/transcription.ts`: worker mgr + unified `transcribe(audio)->{text,tier,latencyMs}`. Exports `transcribeOnDevice`, `transcribeCloud`, `preloadOnDeviceModel`, `onModelLoadStateChange`. `resolveTier(s)` is now **SYNC** (no health probe): on-device -> on-device; cloud/auto -> cloud if `cloudKeyPresent` else on-device.
- `src/main/asr-cloud.ts`: `transcribeCloud(pcm16)`. **Only `deepgram` implemented** (nova-3, linear16 16k mono); assemblyai/groq still `throw "...not supported yet"`. NOTE latent gap: Settings lets the user pick assemblyai/groq for ASR but they fail at runtime.
- `lib/micRecorder.ts`: push-to-talk dev recorder; real loop uses VAD.

## Streaming TTS (gapless)
- `workers/kokoro.worker.ts`: `KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {dtype:'q8', device:'wasm'})`. Outputs 24000 Hz.
- `lib/streamingTTS.ts`: `StreamingTTSQueue`. **Rewritten for gapless playback** — a synthesis *pump* converts queued text to audio AHEAD of playback, scheduling each clip back-to-back on the AudioContext timeline via `src.start(when)` using a `nextStartTime` cursor (NOT waiting on `onended` before synthesizing the next). Fixes the old "slow / not continuous" stutter (synthesis-length silence between clips). `interrupt()` bumps `generation`, clears textQueue/buffer, stops+clears all `sources`, resets `nextStartTime`. Generation-aware flag ownership prevents two concurrent pumps after interrupt+re-enqueue. Public API unchanged: `appendText`, `flush`, `interrupt`, ctor opts `{voice,speed,onSpeakingChange}`. USE `buf.getChannelData(0).set(samples)` NOT `copyToChannel`.

## Pipeline + hook
- `lib/pipeline.ts`: `VoicePipeline`. States `idle|listening|transcribing|thinking|speaking`. VAD (`MicVAD.new`, v5, local asset paths, numThreads=1). Flow: speech end -> transcribe -> push user msg -> llm.start -> onDelta feeds tts.appendText -> onDone tts.flush + push assistant msg. Barge-in: onSpeechStart while thinking/speaking -> abort llm + tts.interrupt.
  - **Audio source** (`getStream()`): `audioSource==='system'` -> `getDisplayMedia({video:true,audio:true})`, drops video track, keeps loopback audio (throws on non-Windows). Else mic via `getUserMedia` with echoCancellation/noiseSuppression/autoGainControl.
  - **Hue modes**: `interviewer` (Hue leads, kicks off first question, speaks aloud) vs `companion` (waits for the other party, suggests answers). `buildSystemPrompt` branches on hueMode/interviewMode/jobTitle/resumeSummary.
- `hooks/useVoiceMode.ts`: preloads models, builds pipeline, exposes `{state,active,connecting,userTranscript,assistantText,greetingText,error,mode,audioSource,reloadConfig,start,stop}`. `start()` reads saved settings (no per-session overrides anymore — `SessionOverrides` removed). Subscribes to `window.hue.hotkey.onToggleSession`: toggles via `pipelineRef.current` (synchronous "is a session running" check) — start if none, stop if running.

## Audio capture (system / loopback)
- Main: `ses.setDisplayMediaRequestHandler((_req, cb) => desktopCapturer.getSources({types:['screen']}).then(s => cb({video:s[0], audio:'loopback'})), {useSystemPicker:false})` in `src/main/index.ts`.
- `audio:'loopback'` = **whole system output mix** (Windows WASAPI loopback) — captures ALL playback (YouTube, Spotify, Zoom, calls, notifications), NOT per-app. Chromium/Electron has no per-process audio filter through this API; true per-app isolation would need a native WASAPI process-loopback addon. Windows-only; macOS would need ScreenCaptureKit (not wired).
- Renderer requests a video track only because Chromium requires one for loopback; it's dropped immediately.

## Settings UI
- `components/Settings.tsx`: controlled form over HueSettings. LLM provider + model (+ model fetch for ollama/openai-compat), interview context (jobTitle/resumeSummary/interviewMode), Hue mode, audio source, TTS voice+speed. **Shortcuts section**: read-only "Summon Hue" (fixed Ctrl+Shift+Space) + a click-to-record `HotkeyRecorder` for `startSessionHotkey`. Helpers: `formatAccelerator` (display), `eventToAccelerator` (DOM KeyboardEvent -> Electron accel; REQUIRES a modifier so a bare global key can't swallow input app-wide), `ACCEL_KEY_MAP`.
- Transcription (ASR) section is decluttered: tier selector (Auto / On-device / Cloud) + hint; cloud provider dropdown + a SINGLE API-key field for the selected provider, shown only when `asrTier !== 'on-device'` (driven by `CLOUD_ASR` map; groq reuses `groqApiKey`). NO Parakeet URL/tier.
- `App.tsx`: dev harness (voice-mode panel, latency badge, record->transcribe, streaming-TTS test) + `<Settings/>`.

## REMOVED — Parakeet (Tier 2), fully
- Deleted `src/main/parakeet.ts` and `scripts/start-parakeet-server.py`. Removed IPC handlers, preload methods, `parakeetServerUrl` setting, `'parakeet'` from AsrTier/ResolvedTier, and all transcription auto-tier health-probe logic. `scripts/` now only has `copy-vad-assets.mjs`. User chose full removal (not just hide URL).

## CAVEATS / next work
- First run downloads models from HF hub (Whisper ~145MB, Kokoro ~80MB, VAD Silero); needs internet.
- VAD/ORT assets bundled in `src/renderer/public/` (md5-matched to onnxruntime-web dist) — keep in sync on ORT upgrade.
- Implement assemblyai/groq cloud ASR (currently throw), OR restrict the Settings ASR dropdown to deepgram.
- Per-app audio capture (vs whole-system loopback) would need a native module — open feature request.
- **Owner runtime verification pending (tray/hotkeys):** tray shows the H logo + click/Show Hue surfaces window; closing hides to tray, Quit exits; Ctrl+Shift+Space shows then (pressed again while focused) hides; default Ctrl+Shift+Enter toggles a session globally; changing the start-session shortcut in Settings re-binds live; Hue absent from taskbar.
- **Packaging icon NOT swapped:** only the runtime window/tray logo uses `letter-h.png`. The electron-builder installer/app icon still comes from `build/` (`buildResources: build` in `electron-builder.yml`). If the user wants the installed-app icon to be the H too, replace `build/icon.*`.
- Possible polish: tray-icon left-click could toggle visibility (currently always shows); App.tsx empty-state hint still says "summon" (accurate enough).
