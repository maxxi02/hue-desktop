---
tags: [moc, home]
created: 2026-06-02
---

# 🎨 Hue — Vault Home

Knowledge base for **Hue**, a desktop interview assistant / companion overlay. This note is the map of content (MOC) — start here.

## 📌 Core Notes
- [[Project Overview]] — what Hue is, its two modes, and goals
- [[Architecture]] — Electron process model, IPC, and file layout
- [[Voice Pipeline]] — VAD → ASR → LLM → TTS turn loop
- [[LLM & ASR Providers]] — Claude, Ollama, OpenAI-compatible, cloud ASR
- [[Tech Stack]] — frameworks, on-device ML, and tooling
- [[Settings & Security]] — encrypted settings, key handling, hardening notes

## 🗂️ Tracking
- [[Tasks]] — backlog and in-progress work
- [[Decisions]] — architecture decision log (ADRs)
- [[Daily Notes]] — day-to-day dev log (`Daily Notes/` folder)

## 🔗 Quick Links
- Repo root: `C:\dev-proj\hue-extension-claude\hue-desktop`
- Main entry: `src/main/index.ts`
- Renderer entry: `src/renderer/src/main.tsx`
- Shared types: `src/shared/types.ts`
- Voice pipeline: `src/renderer/src/lib/pipeline.ts`

> [!tip]
> Use `[[wikilinks]]` to connect notes and open the **Graph view** (left sidebar) to see the web. This vault lives in `docs/` inside the repo, so it is version-controlled alongside the code.
