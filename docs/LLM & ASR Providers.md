---
tags: [reference, providers]
created: 2026-06-02
---

# LLM & ASR Providers

Hue is provider-agnostic. All network calls to providers happen in the **main process** so API keys never reach the renderer. See [[Settings & Security]].

## LLM providers (`LlmProvider`)
`anthropic` · `ollama` · `google` · `groq` · `mistral` · `cohere`

| Provider | Module | Transport |
|---|---|---|
| **Anthropic (Claude)** | `src/main/anthropic.ts` | Official `@anthropic-ai/sdk`, streamed |
| **Ollama** (local) | `src/main/ollama.ts` | Plain `fetch` to `http://localhost:11434`; lists installed models via `/api/tags` |
| **Google / Groq / Mistral / Cohere** | `src/main/openai-compat.ts` | One generic OpenAI-compatible client |

### OpenAI-compatible client
Google Gemini, Groq, Mistral and Cohere all expose an OpenAI-style surface (Bearer auth, `POST /chat/completions` with SSE streaming, `GET /models`). They differ only by base URL and which settings key holds the credential, so **one client serves all four** — no vendor SDKs, just `fetch`.

- Model selection per provider (`googleModel`, `groqModel`, …). Empty = auto-pick the first model the provider lists, so nothing is hardcoded to a version.
- Groq's API key (`groqApiKey`) is reused for both its LLM and its cloud ASR.

## ASR providers
Tiered by the `asrTier` setting:
- **On-device** — Whisper via transformers.js (WebGPU/wasm). See [[Voice Pipeline]].
- **Cloud** (`CloudAsrProvider`): `deepgram` · `assemblyai` · `groq` — proxied through `src/main/asr-cloud.ts`, fed raw 16-bit PCM mono @ 16 kHz.

## Adding a provider — checklist
1. Extend the relevant enum in `src/shared/types.ts` (`LlmProvider` / `OpenAiCompatProvider` / `CloudAsrProvider`).
2. If OpenAI-compatible, add an entry to the `PROVIDERS` map in `openai-compat.ts` (base URL + key/model fields) — usually no other code needed.
3. Add the API-key + model fields to `HueSettings` and `DEFAULT_SETTINGS`, and the key to `SECRET_SETTING_KEYS` so it's encrypted.
4. Surface the new fields in `src/renderer/src/components/Settings.tsx`.

Related: [[Voice Pipeline]] · [[Settings & Security]] · [[Architecture]]
