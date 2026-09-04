---
tags: [tasks]
created: 2026-06-02
---

# Tasks

## 🔜 Backlog
- [ ] Security: validate & sanitize third-party API responses (LLM/ASR) — [[LLM & ASR Providers]]
- [ ] macOS: **verify** system audio capture on a real Mac running macOS 15+. The route is implemented (`src/main/display-capture.ts`, `useSystemPicker`) and the policy is tested, but nothing has run it on Apple hardware — Electron documents the flag as experimental
- [ ] Code signing — `electron-builder.yml` and icons are configured; signing certificates are not
- [ ] Split `renderer/components/Settings.tsx` — one component, ~2,500 lines, 42 `useState` hooks, and the file every new provider and setting lands in
- [ ] Tests for the stateful renderer edges that `shared/` cannot cover: `pipeline.ts`'s `VoicePipeline` class, `App.tsx`, `transcription.ts`

## 🚧 In Progress
- [ ] _nothing tracked yet_

## ✅ Done
- [x] macOS: implement the system-audio route via ScreenCaptureKit's native picker, and make the per-platform decision a tested pure function rather than a `process.platform` check at the call site (2026-09-04) — **unverified on a Mac**, see backlog
- [x] Split the tables, leaf controls and pure logic out of `Settings.tsx` into `components/settings/`, with 25 tests for the two pure modules (2026-09-04)
- [x] Add OpenAI GPT as a seventh LLM provider, and filter its `/models` catalogue down to models that can actually serve a chat (2026-09-04)
- [x] Lift the prompt builders out of `pipeline.ts` into `shared/prompt.ts` with 21 tests — they build every word Hue sends an LLM and had no test beside them (2026-09-04)
- [x] Fix: ten em dashes inside the prompt strings themselves, including in the rule forbidding them. An exemplar outweighs an abstract rule, which is how dashes reached the answers before (2026-09-04)
- [x] Real `package.json` metadata and README — both were still electron-vite scaffold text at v1.7.0, and `electron-builder` reads them into the packaged app (2026-09-04)
- [x] Configure `electron-builder` metadata and icons ([[Versioning]])
- [x] Document the résumé-ingestion flow — see [[Project Overview]] and `src/main/resume-pipeline.ts`
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
