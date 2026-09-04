---
tags: [reference, providers]
created: 2026-06-02
---

# LLM & ASR Providers

Hue is provider-agnostic. All network calls to providers happen in the **main process** so API keys never reach the renderer. See [[Settings & Security]].

## LLM providers (`LlmProvider`)
`anthropic` · `ollama` · `openai` · `google` · `groq` · `mistral` · `cohere` · `deepseek`

| Provider | Module | Transport |
|---|---|---|
| **Anthropic (Claude)** | `src/main/anthropic.ts` | Official `@anthropic-ai/sdk`, streamed |
| **Ollama** (local) | `src/main/ollama.ts` | Plain `fetch` to `http://localhost:11434`; lists installed models via `/api/tags` |
| **OpenAI / Google / Groq / Mistral / Cohere / DeepSeek** | `src/main/openai-compat.ts` | One generic OpenAI-compatible client |

### OpenAI-compatible client
OpenAI itself, plus Google Gemini, Groq, Mistral, Cohere and DeepSeek, all speak the same surface (Bearer auth, `POST /chat/completions` with SSE streaming, `GET /models`), so **one client serves all six** — no vendor SDKs, just `fetch`.

"Compatible" is not "identical". The differences live in `PROVIDERS` as data rather than as `provider === 'x'` checks at the call sites, because a name check is another copy of the provider list and the next provider added silently misses it:

- `extraBody` — DeepSeek streams its reasoning on `delta.reasoning_content`, a field the renderer never reads, so thinking is disabled rather than plumbed through. Dead air on the hot path is the thing this product exists to remove.
- `vision` — DeepSeek takes no `image_url` parts, so `ipc.ts` asks before sending a screen capture and the user gets a sentence instead of a raw 400.
- `modelFilter` — OpenAI's `/models` is the whole account catalogue (embeddings, speech, images, legacy completions), not a chat lineup. Unfiltered, auto-pick sorts to `babbage-002` and fails the first question of the interview on a perfectly good key.

- Model selection per provider (`openaiModel`, `googleModel`, `groqModel`, …). Empty = auto-pick the first model the provider lists, so nothing is hardcoded to a version. Ordering is alphabetical, which is a product decision rather than a display detail: on DeepSeek it puts `-flash` ahead of `-pro`, and on the drafting hot path a second of latency costs more than a shade of answer quality.
- Groq's API key (`groqApiKey`) is reused for both its LLM and its cloud ASR.

## ASR providers
Tiered by the `asrTier` setting:
- **On-device** — Whisper via transformers.js (WebGPU/wasm). See [[Voice Pipeline]].
- **Cloud** (`CloudAsrProvider`): `deepgram` · `assemblyai` · `groq` — proxied through `src/main/asr-cloud.ts`, fed raw 16-bit PCM mono @ 16 kHz.

## Adding a provider — checklist
Seven sites, not one. `src/main/provider-tables.test.ts` cross-checks the tables against each other and fails if you miss one; run it after touching any of them.

1. `src/shared/types.ts` — the enums (`LlmProvider` / `OpenAiCompatProvider` / `CloudAsrProvider`), the API-key and model fields on `HueSettings`, their `DEFAULT_SETTINGS` entries, and the key in `SECRET_SETTING_KEYS` so `safeStorage` encrypts it.
2. `PROVIDERS` in `src/main/openai-compat.ts` — base URL, key/model fields, and any quirk as data.
3. `PROVIDER_BASE_URLS` in `src/main/structured-llm.ts` — **spelled as a string literal**. Do not import `GROQ_BASE_URL` / `OPENAI_BASE_URL` / `DEEPSEEK_BASE_URL` from `structured-llm-openai.ts`: those two modules are a cycle, the consts are in their temporal dead zone when this table initialises, and the whole main-process module tree fails to load with a `ReferenceError` at import time. It looks like sloppy duplication and is not.
4. The `keys` and `models` maps in `clientForSettings` (same file).
5. `COMPAT_PROVIDERS` in `src/renderer/src/components/Settings.tsx`, plus **three** `<option>` dropdowns — drafting, ingest and assessment.
6. The `isLlmConfigured` switch in `src/renderer/src/lib/greeting.ts`.
7. `DIALECTS` in `src/shared/usage.ts`, or the usage panel quietly reports no quota for the new provider.

Only the four `Record<OpenAiCompatProvider, …>` tables are compiler-checked. The switch in (6), the map in (7) and the dropdowns in (5) are not — which is what `provider-tables.test.ts` is for.

Related: [[Voice Pipeline]] · [[Settings & Security]] · [[Architecture]]
