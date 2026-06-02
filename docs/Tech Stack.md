---
tags: [reference, stack]
created: 2026-06-02
---

# Tech Stack

Versions reflect `package.json` (v1.0.0).

## Runtime & Framework
- **Electron** ^39 — desktop shell
- **React** ^19.2 + **react-dom** ^19.2 — UI
- **TypeScript** ^5.9

## Build & Tooling
- **electron-vite** ^5 — dev server + build orchestration
- **vite** ^7 + **@vitejs/plugin-react** ^5
- **electron-builder** ^26 — packaging/installers (`electron-builder.yml`)
- **@electron-toolkit/utils**, **/preload**, **/eslint-config-ts**, **/eslint-config-prettier**, **/tsconfig**
- **ESLint** ^9 + **Prettier** ^3
- Package manager: **pnpm** (lockfile `pnpm-lock.yaml`)

## AI / ML
- **@anthropic-ai/sdk** ^0.98 — Claude
- **@huggingface/transformers** ^4 — runs Whisper (ASR) and Kokoro (TTS) on **WebGPU** with wasm fallback
- **kokoro-js** ^1.2 — TTS voices
- **@ricky0123/vad-web** ^0.0.30 — voice activity detection

## Native / Input
- **uiohook-napi** ^1.5 — global mouse-button hotkeys (Electron can't bind these)

## Document parsing (resume ingestion)
- **mammoth** ^1.12 — .docx → text
- **unpdf** ^1.6 — PDF text extraction

## Fonts
- **@fontsource/dm-sans**, **@fontsource/space-grotesk**

## Scripts
| Command | Purpose |
|---|---|
| `pnpm dev` | Launch dev with HMR (runs `copy-vad-assets` first) |
| `pnpm build` | Typecheck + build all processes |
| `pnpm start` | Preview a production build |
| `pnpm typecheck` | `typecheck:node` + `typecheck:web` |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm build:win` / `:mac` / `:linux` | Build + package installer |
| `pnpm copy-vad-assets` | Copy VAD wasm/onnx assets (pre/dev/build hook) |

## TypeScript Config
Split configs: `tsconfig.json` (root), `tsconfig.node.json` (main/preload), `tsconfig.web.json` (renderer). The `@shared/*` alias maps to `src/shared`.

Related: [[Architecture]] · [[Voice Pipeline]]
