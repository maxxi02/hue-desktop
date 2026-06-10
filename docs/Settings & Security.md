---
tags: [reference, security, settings]
created: 2026-06-02
---

# Settings & Security

## Persistence (`src/main/settings.ts`)
- Settings are stored as JSON at `app.getPath('userData')/hue-settings.json`.
- Defined by `HueSettings` with `DEFAULT_SETTINGS` (both in `src/shared/types.ts`).
- Read/written over IPC: `hue:settings:get` / `hue:settings:set` (partial updates merged).

## Secret handling
- Keys listed in `SECRET_SETTING_KEYS` (API keys for Anthropic, Deepgram, AssemblyAI, Groq, Google, Mistral, Cohere) are encrypted at rest with Electron **`safeStorage`** (OS keychain / DPAPI), prefixed `enc:v1:`.
- If `safeStorage.isEncryptionAvailable()` is false, values fall back to plaintext (degraded).
- **API keys never reach the renderer**: all provider/LLM/ASR network calls run in the main process. See [[LLM & ASR Providers]].

## Settings of note (`HueSettings`)
- **LLM**: `llmProvider`, `model`, per-provider keys + model fields, `ollamaBaseUrl` / `ollamaModel`.
- **ASR**: `asrTier` (`auto`/`on-device`/`cloud`), `cloudAsrProvider`, provider keys.
- **TTS**: `ttsVoice`, `ttsSpeed`.
- **Modes**: `hueMode` (interviewer/companion), `audioSource` (microphone/system), `interviewMode`.
- **Personalization**: `resumeSummary`, `jobTitle`.
- **UI**: `windowOpacity` (0.4–1).
- **Hotkeys**: `startSessionHotkey`, summon/show-hide hotkey — Electron accelerator strings or `Mouse:Back`/`Forward`/`Middle` encodings.

## Security review notes (against global baseline)
Hardened 2026-06-10 ([[Decisions|ADR-007]]):
- ✅ Renderer runs with **`sandbox: true`**; the strictly typed `window.hue` contextBridge API is the only main-process surface (the generic `electronAPI`/raw `ipcRenderer` exposure was removed along with `@electron-toolkit/preload`).
- ✅ Permission handlers **allowlist** exactly `media` (microphone) + `display-capture` (loopback audio); everything else is denied.
- ✅ CSP confirmed strict (no remote scripts; `wasm-unsafe-eval` + HF hub `connect-src` only) and extended with `object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'`.
- The app holds a **single-instance lock**: relaunching the EXE summons the running window instead of spawning a fresh instance (which used to silently reset the session).

> [!note] Still open — see [[Tasks]]
> - Validate/sanitize all third-party API responses (LLM/ASR providers) before use.
> - Cross-origin isolation is intentionally off for performance — documented in [[Decisions]] (ADR-002).

Related: [[Architecture]] · [[LLM & ASR Providers]]
