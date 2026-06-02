---
tags: [overview]
created: 2026-06-02
---

# Project Overview

**Hue** is a cross-platform desktop application (Electron + React + TypeScript) that acts as a real-time, voice-driven **interview assistant**. It runs as a frameless, always-on-top, translucent overlay that lives in the system tray and can be summoned over any other app (e.g. a video call) via global shortcuts.

| | |
|---|---|
| **Name** | hue-desktop |
| **Version** | 1.0.0 |
| **Author** | maxxi02 |
| **App User Model ID** | `com.hue.app` |
| **Window** | 900 × 670, frameless, transparent, always-on-top, skip-taskbar |

## What it does
Hue listens to speech, transcribes it, asks an LLM for a response, and (optionally) speaks the answer back — a full voice turn loop. See [[Voice Pipeline]].

## Two roles ([[Architecture|HueMode]])
- **Interviewer** — Hue conducts a mock interview: it asks questions aloud and you practice answering.
- **Companion** — Hue assists during a *real* interview: incoming speech is treated as the interviewer's question and Hue drafts an answer for you as **text only**, so it never talks over you or is heard by the interviewer.

## Audio sources
- **Microphone** — your mic (echo-cancelled).
- **System / loopback** — the call audio coming out of your speakers (e.g. the interviewer on Zoom/Meet). Windows-supported via Electron loopback; macOS would need ScreenCaptureKit.

## Personalization
- Resume summary + job title feed the LLM prompt (`src/renderer/src/lib/resume.ts`).
- Interview modes: `practice`, `star`, `live`.

## Build Targets
Packaged via `electron-builder`:
- Windows — `pnpm build:win`
- macOS — `pnpm build:mac`
- Linux — `pnpm build:linux`

See [[Architecture]], [[Voice Pipeline]], and [[Tech Stack]] for details.
