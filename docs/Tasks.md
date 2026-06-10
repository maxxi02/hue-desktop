---
tags: [tasks]
created: 2026-06-02
---

# Tasks

## 🔜 Backlog
- [ ] Security: validate & sanitize third-party API responses (LLM/ASR) — [[LLM & ASR Providers]]
- [ ] macOS: implement system/loopback audio capture (ScreenCaptureKit) — currently Windows-only (see [[Architecture]])
- [ ] Fill in product vision / target users in [[Project Overview]]
- [ ] Configure `electron-builder` metadata, icons, and code signing
- [ ] Document the resume-ingestion flow (mammoth / unpdf → `resume.ts`)

## 🚧 In Progress
- [ ] _nothing tracked yet_

## ✅ Done
- [x] Fix: "Hue reopens and the session is cleared" — added a single-instance lock (relaunching the EXE now summons the running window, session intact) and auto-reload on renderer crash ([[Settings & Security]])
- [x] Security: renderer `sandbox: true` with the typed `window.hue` bridge as the only IPC surface; dropped generic `electronAPI` + `@electron-toolkit/preload` ([[Decisions|ADR-007]])
- [x] Security: permission handlers scoped to an allowlist (`media`, `display-capture`) — was grant-all
- [x] Security: CSP confirmed strict and extended (`object-src 'none'`, `base-uri 'self'`, `form-action 'none'`, `frame-src 'none'`)
- [x] Perf: warm Whisper/Kokoro at app launch (and on settings close) instead of session start, so the first session connects near-instantly ([[Performance Audit 2026-06-10]] #3)
- [x] Fix: companion-mode live-call crash — keep Whisper on wasm/CPU (and skip Kokoro) so on-device models don't contend with the call's GPU and freeze the machine ([[Decisions|ADR-004]], [[Voice Pipeline]])
- [x] Scaffold Electron + React 19 + Vite project
- [x] Voice pipeline: VAD → ASR → LLM → TTS ([[Voice Pipeline]])
- [x] Run Whisper & Kokoro on WebGPU with wasm fallback
- [x] Add Groq and AssemblyAI cloud ASR providers
- [x] OpenAI-compatible client for Google/Groq/Mistral/Cohere
- [x] Encrypted settings via Electron `safeStorage` ([[Settings & Security]])
- [x] Global keyboard + mouse hotkeys (uiohook-napi)
- [x] Set up Obsidian docs vault (this `docs/` folder)
