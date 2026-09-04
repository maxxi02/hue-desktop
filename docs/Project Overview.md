---
tags: [overview]
created: 2026-06-02
---

# Project Overview

**Hue** is a cross-platform desktop application (Electron + React + TypeScript) that acts as a real-time, voice-driven **interview assistant**. It runs as a frameless, always-on-top, translucent overlay that lives in the system tray and can be summoned over any other app (e.g. a video call) via global shortcuts.

| | |
|---|---|
| **Name** | hue-desktop |
| **Version** | 1.7.0 |
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
Hue does not take a freeform summary any more. A résumé is ingested once into a
**profile bundle**: structured roles, metrics and mined STAR stories, each with an
id and a verbatim quote from the document (`src/main/resume-pipeline.ts`). Claims
that are not in the document are dropped at ingest (`src/main/resume-grounding.ts`).

That bundle reaches the model through `src/shared/prompt.ts`, which builds every
word Hue sends an LLM, as the exact set of stories it may draw on. The model names
the story it used on a `story_id:` line; `src/shared/grounding.ts` reads it back
and marks the answer anchored or not. Gaps the résumé cannot cover become
questions the user answers once in Settings.

The old `resumeSummary` field still loads, so an install predating the bundle keeps
working on the weaker guarantee. It is a fallback, not the path.

- A job posting can be analysed into a `JobSpec` and a `JobBrief` that weight
  answers toward what the role actually asks for (`src/shared/job-spec.ts`).
- Interview modes: `practice`, `star`, `live`.

## Build Targets
Packaged via `electron-builder`:
- Windows — `pnpm build:win`
- macOS — `pnpm build:mac`
- Linux — `pnpm build:linux`

See [[Architecture]], [[Voice Pipeline]], and [[Tech Stack]] for details.
