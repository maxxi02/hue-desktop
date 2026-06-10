# Performance Audit — 2026-06-10

Parts check of the whole app (main process, renderer, workers, LLM layer, packaging). Overall verdict: the hot paths are already deliberately optimized (single-threaded WASM rationale, per-mode GPU/VRAM management, screenshot stripping from LLM history, transferable buffers, gapless TTS scheduling). The remaining wins, in priority order:

## 1. ✅ DONE 2026-06-10 — No prompt caching on the Anthropic path (highest value)
`src/main/anthropic.ts` sends the full system prompt (~1.5–2K tokens of companion/humanizer guidance) plus the entire growing conversation history on every turn, with no `cache_control` breakpoints. Adding ephemeral caching on the system prompt and the conversation prefix would cut input cost ~90% on cached tokens and reduce time-to-first-token every turn — which directly improves the "suggested answer appears fast enough to use mid-call" experience. The system prompt is deterministic per session (built from settings), so it's an ideal cache target. Verify with `usage.cache_read_input_tokens`.

## 2. ✅ DONE 2026-06-10 — Default model is stale
`DEFAULT_SETTINGS.model` is `claude-opus-4-7` (`src/shared/types.ts:100`); current latest is `claude-opus-4-8` (same request surface, no breaking changes from 4.7).

## 3. ✅ DONE 2026-06-10 — Models warm up at session start, not app launch
`useVoiceMode.start()` triggers Whisper/Kokoro preload, so the first session eats the whole download + init in the "Connecting" state. Saved settings are known at launch — preloading then (respecting the companion-mode `preferWasm` rule) would make the first session start near-instantly. Whisper/Kokoro also re-download from the HF hub per machine (`env.allowLocalModels = false`); they're cached by the browser cache afterwards, so this is first-run only.

**Done:** `reloadConfig` in `useVoiceMode` now warms the models whenever saved settings are read — at launch and after the settings drawer closes — following the same companion rules as `start()` (Whisper pinned to wasm, Kokoro skipped). Guarded by `!pipelineRef.current` so a mid-session settings save can't move models across devices under a live call. Bonus: switching modes while idle now migrates Whisper on/off the GPU immediately (the worker disposes and rebuilds on preference change) instead of at the next session start. Note Kokoro is wasm-pinned anyway (whispering-voice bug, ADR in [[Decisions]]), so launch-preloading it costs CPU memory only, no VRAM.

## 4. Renderer transcript grows unbounded; screenshots live in state forever
`App.tsx` keeps full-resolution base64 PNG captures (1–3 MB strings) in the `messages` array and re-creates the array on every streamed token, re-rendering every bubble. Fine for one interview; degrades over a long session with several captures. Cheap fixes: memo the bubble component, keep the streaming assistant text in its own state slot, store a downscaled thumbnail for display.

## 5. LLM history is never trimmed
`VoicePipeline.messages` grows for the whole session. Caching (#1) mostly neutralizes the cost, but a sliding window (keep system prompt + last N turns) would bound it for marathon sessions.

## 6. Packaging trims
- `silero_vad_legacy.onnx` (1.8 MB) is copied/shipped but the pipeline pins `model: 'v5'` — drop it from `scripts/copy-vad-assets.mjs`.
- Dev server sets COOP/COEP headers (`electron.vite.config.ts`) while production deliberately runs without cross-origin isolation (`src/main/index.ts`). The two comments contradict each other and dev/prod run different SharedArrayBuffer environments — align them so the threaded-WASM freeze class of bug can't hide in one environment only.

## Smaller notes (not perf)
- `setPermissionRequestHandler` grants **all** permissions, not just microphone — tighten to the ones actually needed.
- Phone mirror streams interview answers over plain HTTP on the LAN (token-gated, but plaintext) — acceptable tradeoff per [[Phone Mirror]] (ADR-005), noting it here for completeness.

Related: [[Decisions]], [[Phone Mirror]]
