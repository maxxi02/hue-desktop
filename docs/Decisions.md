---
tags: [adr, decisions]
created: 2026-06-02
---

# Decisions (ADR Log)

Lightweight log of architecture decisions. Newest first.

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
- Enable the renderer `sandbox` with a typed preload bridge? Currently `false`. See [[Settings & Security]].
- Scope down the auto-grant permission handlers?
