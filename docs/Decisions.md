---
tags: [adr, decisions]
created: 2026-06-02
---

# Decisions (ADR Log)

Lightweight log of architecture decisions. Newest first.

## ADR-007 — Renderer sandbox ON, permissions allowlisted, single typed bridge
**Date:** 2026-06-10 · **Status:** Accepted
**Context:** The renderer processes untrusted-ish data (LLM/ASR responses, downloaded model files) but ran with `sandbox: false`, auto-granted **every** Chromium permission, and exposed the generic `@electron-toolkit/preload` `electronAPI` (raw `ipcRenderer`) alongside the typed `window.hue` bridge.
**Decision:** Enable `sandbox: true` — the preload only uses `contextBridge`/`ipcRenderer` and bundles to CJS, so it is fully sandbox-compatible. Drop the `electronAPI` exposure and the `@electron-toolkit/preload` dependency (the only consumer was the unused scaffold `Versions.tsx`, deleted); `window.hue` is now the renderer's *only* surface into the main process. Scope the permission request/check handlers to an allowlist of exactly what Hue uses: `media` (microphone) and `display-capture` (loopback audio). Harden the CSP with `object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'`.
**Consequences:** A compromised renderer can no longer reach Node, invoke arbitrary IPC channels, or escalate via permission prompts. WebGPU/WASM model inference is unaffected (sandboxing doesn't touch GPU or WASM). Verified: typecheck + build clean, app launches with no preload errors. Remaining from the baseline: validate third-party API responses ([[Tasks]]).

---


## ADR-006 — Humanizing companion answers: model size first, prompt second
**Date:** 2026-06-10 · **Status:** Accepted
**Context:** Companion answers read as obviously AI-generated. Root cause analysis: the prompt's humanizer guidance (`HUMAN_VOICE_GUIDANCE` in `src/renderer/src/lib/pipeline.ts`) bans AI-tell words but the dominant factor is model capability — an 8B model (`llama-3.1-8b-instant`) writes in a flat, generic register no prompt fully fixes.
**Decision:** Treat model choice as the primary lever (recommend ≥70B on Groq, e.g. `llama-3.3-70b-versatile`, or a frontier model). Secondarily, extend the humanizer guidance with what makes speech feel human rather than just what to avoid: uneven sentence rhythm, committing to one angle instead of survey-style coverage, no tidy summary closers, at most one light spoken touch per answer; the companion prompt now also asks for a thinking-out-loud register with a concrete number/name over adjectives.
**Consequences:** Prompt changes apply to all providers (the system prompt is built in the renderer pipeline). Model choice stays a user setting; the app never bakes in a model version (see ADR-003).

## ADR-005 — Phone mirror via LAN server + SSE, not a cloud relay
**Date:** 2026-06-10 · **Status:** Accepted
**Context:** Companion answers should be readable on a phone (glancing at a phone is more natural mid-call than reading an overlay on the shared screen). Options: (a) local HTTP/SSE server in the main process + QR code, (b) cloud relay (Supabase Realtime), (c) push notifications (Telegram/ntfy).
**Decision:** (a) — a token-authenticated HTTP server in `src/main/phone-mirror.ts` serving a static mobile page and a Server-Sent Events stream on the LAN. SSE over Node `http` because the phone only receives: zero new runtime deps, browser-native auto-reconnect. The only new dep is `qrcode` (renderer, Settings QR).
**Consequences:** Lowest latency and fully private — interview content never leaves the network; no accounts. Constraint: phone and PC must share a Wi-Fi network. Plain HTTP is accepted on the LAN (self-signed TLS = phone warnings for little gain); mitigated by a per-start 128-bit URL token and the server running only when explicitly enabled. A cloud relay can be added later for mobile-data use. See [[Phone Mirror]].

---

## ADR-004 — Keep on-device models off the GPU in companion mode
**Date:** 2026-06-02 · **Status:** Accepted
**Context:** On-device Whisper (ASR) and Kokoro (TTS) run **fp32 on WebGPU** (see [[Voice Pipeline]]). Companion mode is used during a *live call* (e.g. Google Meet), where the call's WebRTC stack already saturates the GPU with hardware video encode/decode plus compositing of Hue's transparent always-on-top overlay. Loading fp32 models onto the same GPU has exhausted VRAM and triggered a driver reset (TDR) that **froze the whole machine** mid-interview. `requestAdapter()` only proves an adapter exists — it can't tell the GPU is already under load.
**Decision:** In companion mode keep both on-device models off the GPU. TTS (Kokoro) is skipped entirely (companion replies are text-only). ASR (Whisper) is pinned to the single-threaded **wasm/CPU** path via a `preferWasm` flag passed into the worker. The worker disposes a resident GPU model and rebuilds on wasm when the preference changes, so switching from a practice interview (GPU) into a live call (CPU) actually frees the VRAM rather than leaving Whisper pinned to WebGPU.
**Consequences:** No more GPU contention with the call — the crash is prevented rather than recovered from. Companion-mode transcription is CPU-bound (a few seconds slower per turn; the proven pre-WebGPU path). Users who want call-time speed without local load can switch to the cloud ASR tier. Interviewer mode is unchanged (still WebGPU). See [[Voice Pipeline]], [[Architecture]].

---

## ADR-003 — One generic client for OpenAI-compatible LLMs
**Date:** 2026-06-02 · **Status:** Accepted
**Context:** Google Gemini, Groq, Mistral and Cohere all expose an OpenAI-style API (Bearer auth, `/chat/completions` SSE, `/models`).
**Decision:** Drive all four through a single `fetch`-based client in `src/main/openai-compat.ts`, parameterized by base URL + settings key. No vendor SDKs.
**Consequences:** Adding such a provider is usually one entry in the `PROVIDERS` map. Anthropic and Ollama keep dedicated modules. See [[LLM & ASR Providers]].

---

## ADR-002 — Cross-origin isolation (COOP/COEP) stays OFF
**Date:** 2026-06-02 · **Status:** Accepted
**Context:** Isolation exposes `SharedArrayBuffer`, which makes onnxruntime-web's threaded WASM spawn a busy-waiting thread per core for every model (VAD + Whisper + Kokoro), pegging the CPU and freezing the window on startup.
**Decision:** Keep isolation off and run onnxruntime single-threaded (`numThreads=1`).
**Consequences:** Smooth startup; small models are fast enough single-threaded. Revisit only if larger models need threads. See [[Architecture]].

---

## ADR-001 — Electron + electron-vite stack
**Date:** 2026-06-02 · **Status:** Accepted
**Context:** Need a cross-platform desktop overlay with a web UI and access to native APIs (tray, global hotkeys, loopback audio).
**Decision:** Electron with React 19 + TypeScript, built via electron-vite, packaged with electron-builder.
**Consequences:** Familiar web tooling + HMR; ships a Chromium runtime per app. Enables WebGPU for on-device ML in the renderer.

---

## Open Questions
- ~~Enable the renderer `sandbox` with a typed preload bridge?~~ → Done, ADR-007.
- ~~Scope down the auto-grant permission handlers?~~ → Done, ADR-007.
