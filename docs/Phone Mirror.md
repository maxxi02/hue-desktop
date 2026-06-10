---
tags: [feature, phone-mirror, companion]
created: 2026-06-10
status: in-progress
---

# Phone Mirror

Stream the live companion session — the interviewer's question and Hue's suggested answer — to your **phone**, over the local network. You scan a QR code in Settings; the phone opens a mobile web page served directly by Hue's main process. No app install, nothing leaves your Wi-Fi.

Chosen over a cloud relay (Supabase Realtime) and push notifications (Telegram/ntfy) — see [[Decisions#ADR-005 — Phone mirror via LAN server + SSE, not a cloud relay|ADR-005]].

## How it works

```
Interviewer speaks (call audio)
        │  loopback capture → VAD → ASR        (existing [[Voice Pipeline]])
        ▼
renderer (useVoiceMode callbacks)
        │  ipcRenderer.send('hue:phone:event', { type, text })
        ▼
main process — phone-mirror.ts
   HTTP server on LAN (port 4717, falls back to a random port)
   ├── GET /?t=TOKEN        → mobile HTML page
   └── GET /events?t=TOKEN  → Server-Sent Events stream
        ▼
phone browser — EventSource renders question + streaming answer
```

- **SSE, not WebSocket** — the phone only *receives*, so Server-Sent Events over plain Node `http` does the job with **zero new runtime dependencies** and free auto-reconnect in the browser.
- **Events:** `question` (interviewer transcript), `answer` (cumulative streamed answer text), `state` (pipeline state for the status pill), `clear` (conversation reset). A snapshot of the latest question/answer is replayed to a phone that connects mid-session.
- The only new dependency is **`qrcode`** (renderer-side, generates the QR as a data URL in Settings).

## Security model

Per the global security baseline:

- **Token auth on every route** — a random 128-bit token is generated each time the server starts and embedded in the QR URL. Requests without it get `404` (no hint the service exists). Compared with `crypto.timingSafeEqual`.
- **Payload validation** — events arriving over IPC are shape-checked (allowed `type`, bounded `text` length) before broadcast.
- **XSS-safe page** — the mobile page renders all text via `textContent`, never `innerHTML`.
- **Plain HTTP on the LAN** is the accepted trade-off (self-signed TLS would throw scary warnings on the phone for no real gain on a home network). Documented in ADR-005. The server only runs while the user has explicitly enabled it.

## Implementation steps

1. **Shared types** (`src/shared/types.ts`)
   - `phoneMirrorEnabled: boolean` on `HueSettings` (default `false`).
   - `PhoneMirrorEvent` (`type: 'question' | 'answer' | 'state' | 'clear'`, optional `text`).
   - `PhoneMirrorStatus` (`running`, `url`).
2. **Server** (`src/main/phone-mirror.ts`, new)
   - `startPhoneMirror()` / `stopPhoneMirror()` / `getPhoneMirrorStatus()` / `broadcastPhoneEvent(ev)`.
   - Node `http` server bound to `0.0.0.0:4717` (random port fallback), LAN IP discovered via `os.networkInterfaces()`.
   - SSE client set + heartbeat comment every 25 s; latest question/answer snapshot replayed on connect.
3. **Mobile page** (`src/main/phone-page.html`, new)
   - Single static HTML file, inline CSS/JS, imported into the server with Vite's `?raw`.
   - Dark, glanceable layout: state pill, "Interviewer" question block, large-type "Suggested answer" block that streams in. Auto-reconnect via `EventSource`.
4. **IPC + lifecycle** (`src/main/ipc.ts`, `src/main/index.ts`)
   - `hue:phone:status` (invoke), `hue:phone:set-enabled` (invoke — persists the setting and starts/stops the server immediately so the QR appears without saving), `hue:phone:event` (send, fire-and-forget).
   - On app ready: start the server if `phoneMirrorEnabled` is saved. On quit: stop it.
5. **Preload bridge** (`src/preload/index.ts` + `index.d.ts`)
   - `window.hue.phone.{status, setEnabled, event}`.
6. **Renderer wiring** (`src/renderer/src/hooks/useVoiceMode.ts`)
   - Push `question` / `answer` / `state` / `clear` events from the existing pipeline callbacks. Screen captures mirror as a `question` event ("Shared a screen capture").
7. **Settings UI** (`src/renderer/src/components/Settings.tsx`)
   - New **Phone mirror** section: toggle → when running, show the URL and a QR code (`qrcode.toDataURL`), plus a same-Wi-Fi note.
8. **Verify**
   - `npm run typecheck` + `lint`; curl the page and `/events` with a bad/missing token (expect 404) and with the real token (expect HTML / SSE stream).

## Using it

1. Settings → **Phone mirror** → enable.
2. Scan the QR with your phone (same Wi-Fi as the PC). Keep the page open.
3. Start a companion session — questions and answers mirror to the phone live.
4. If the phone shows "reconnecting…", check both devices are on the same network and Windows Firewall allowed Hue (Electron) on private networks.

## Future ideas
- Phone-formatted answers: 3–4 short bullet cues in large type instead of full prose (system-prompt variant).
- Cloud relay option (Supabase Realtime) for when the phone is on mobile data.
- Wake-lock / keep-screen-on toggle on the phone page.

Related: [[Architecture]] · [[Voice Pipeline]] · [[Settings & Security]] · [[Decisions]]
