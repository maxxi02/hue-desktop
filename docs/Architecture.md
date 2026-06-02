---
tags: [architecture]
created: 2026-06-02
---

# Architecture

Hue follows the standard Electron multi-process model, wired together by **electron-vite**. The unusual parts are the floating-overlay window behavior, global hotkeys, and the renderer-side ML voice pipeline.

## Processes
- **Main** (`src/main/index.ts`) — Node-side entry. Creates the `BrowserWindow`, runs the system tray, registers global hotkeys, grants media permissions, and routes external links through `shell.openExternal`.
- **Preload** (`src/preload/index.ts`, types in `index.d.ts`) — bridges main ↔ renderer via a typed `window` API.
- **Renderer** (`src/renderer/src/main.tsx` → `App.tsx`) — React 19 UI plus the entire voice pipeline (VAD, ASR, TTS run here in Web Workers). See [[Voice Pipeline]].
- **Shared** (`src/shared/types.ts`) — types used by both sides (`HueSettings`, provider enums, stream events).

## Window behavior (the overlay)
Defined in `createWindow()` (`src/main/index.ts`):
- `frame: false`, `transparent: true`, `backgroundColor: '#00000000'` — chromeless translucent card; the renderer paints its own background (opacity is configurable via `windowOpacity`).
- `alwaysOnTop` at the `'screen-saver'` level + `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true })` — stays above full-screen calls and across virtual desktops.
- `skipTaskbar: true` — behaves like a background extension, not a taskbar app.
- Closing the window **hides to tray** (does not quit) unless `isQuitting` is set by the tray's Quit item.
- Dragged by its header (`-webkit-app-region: drag`).

## Media permissions
- `setPermissionRequestHandler` / `setPermissionCheckHandler` auto-grant — needed for `getUserMedia` (mic).
- `setDisplayMediaRequestHandler` grants **loopback audio** + a dummy screen video source for Companion system-audio capture (Chromium requires a video track to be offered; the renderer drops it and keeps only audio).

> [!warning] Cross-origin isolation is deliberately OFF
> Enabling COOP/COEP exposes `SharedArrayBuffer`, which makes onnxruntime-web's threaded WASM spawn a busy-waiting thread per core for every model (VAD + Whisper + Kokoro), pegging the CPU and freezing the window on startup. With isolation off and `numThreads=1`, onnxruntime runs single-threaded — fast enough for these small models and never freezes. See [[Decisions]].

## IPC surface (`src/main/ipc.ts`)
Channels are namespaced `hue:*`:
- `hue:settings:get` / `hue:settings:set` — read/update [[Settings & Security|settings]].
- LLM streaming — Anthropic, Ollama, and OpenAI-compatible providers (`startLlmStream` / `abortLlmStream` and equivalents).
- `transcribeCloud` — cloud ASR proxy (keys stay in main).
- Hotkey application (`applyHotkeys`).

## Global hotkeys (`src/main/hotkeys.ts`)
- Electron `globalShortcut` for keyboard accelerators.
- **`uiohook-napi`** captures global mouse buttons (Back/Forward/Middle) since Electron can't bind those.
- `summon()` shows/focuses the window; `toggleSession()` starts/stops a voice session — both work while another app is focused.

## File Layout
```
hue-desktop/
├─ src/
│  ├─ main/            # Electron main process
│  │  ├─ index.ts        # window, tray, lifecycle, permissions
│  │  ├─ ipc.ts          # IPC router
│  │  ├─ anthropic.ts    # Claude streaming
│  │  ├─ ollama.ts       # local Ollama streaming
│  │  ├─ openai-compat.ts# Google/Groq/Mistral/Cohere
│  │  ├─ asr-cloud.ts    # cloud ASR proxy (Deepgram/Groq/AssemblyAI)
│  │  ├─ hotkeys.ts      # global keyboard + mouse hotkeys
│  │  └─ settings.ts     # encrypted settings persistence
│  ├─ preload/         # typed bridge
│  ├─ renderer/src/    # React UI + voice pipeline
│  │  ├─ App.tsx, components/
│  │  ├─ hooks/useVoiceMode.ts
│  │  ├─ lib/          # pipeline, transcription, streamingTTS, resume…
│  │  └─ workers/      # whisper.worker.ts, kokoro.worker.ts
│  └─ shared/types.ts  # cross-process types
├─ electron.vite.config.ts
├─ electron-builder.yml
└─ docs/               # this Obsidian vault
```

Related: [[Voice Pipeline]] · [[LLM & ASR Providers]] · [[Settings & Security]]
