# hue-desktop

A real-time interview companion. Hue runs as a frameless, always-on-top overlay
that sits over a video call, listens to the interviewer, and drafts an answer the
user can say out loud before the pause gets awkward.

Two modes, and they are different jobs rather than settings on one:

- **Companion** — a real interview. Incoming speech is treated as the
  interviewer's question and Hue drafts an answer as **text only**, so it is
  never heard on the call.
- **Interviewer** — practice. Hue asks the questions aloud and you answer.

The design constraint behind most of the code is latency. A second of dead air
mid-interview costs more than a shade of answer quality, so the hot path
consistently prefers the faster option: cheapest-and-fastest model defaults,
speculative drafting, streamed tokens, and provider quirks handled as data rather
than as branches.

## Grounding

Hue will not invent your history. A résumé is read once into a **profile
bundle** — a structured set of roles, metrics and mined STAR stories, each with
an id and a verbatim quote from the document. That bundle goes into the system
prompt as the exact set of stories the model may draw on, and the model must name
the one it used on a final `story_id:` line. `shared/grounding.ts` reads that id
back and marks the answer anchored or not. Where no story fits, the honest answer
is the required one.

Gaps the résumé cannot cover become questions you answer once, in Settings.

## Providers

Anthropic and Ollama have their own clients. Everything else speaks the OpenAI
Chat Completions wire format and shares one: **OpenAI, Google Gemini, Groq,
Mistral, Cohere, DeepSeek**. Keys are stored through Electron `safeStorage`,
never in plain text.

Three workloads route independently, because the right model differs by job:

| Role | Wants | Notes |
|---|---|---|
| **Drafting** | Fastest, cheapest | You reshape the prose as you speak it. |
| **Ingest** | Headroom per request | A résumé is one ~11k-token call. Groq's free tier caps at 8k and cannot do it. |
| **Assessment** | Strongest | A plausible wrong answer to a coding question costs more than a slow one. |

Adding a provider means seven sites; `src/main/provider-tables.test.ts` fails if
you miss one, and four of the seven are `Record<OpenAiCompatProvider, …>` tables
so the compiler catches those.

## Voice pipeline

`VAD → ASR → LLM → TTS`. Whisper and Kokoro run on-device (WebGPU with a wasm
fallback) or against a cloud ASR provider — Deepgram, AssemblyAI or Groq. In a
live call Whisper is pinned to wasm on purpose: contending with the call for the
GPU froze the machine (ADR-004).

## Requirements

- pnpm, and Node 22.18+ or 23.6+ — `pnpm test` runs `.ts` files directly and
  needs the version of Node whose test runner strips types without a flag
  (developed on 24.x)
- **System audio capture is Windows only.** Companion mode hears the interviewer
  through Electron's loopback capture; macOS needs ScreenCaptureKit and it is not
  implemented yet. Mic capture works everywhere.

## Setup

```bash
pnpm install
pnpm dev
```

Then open Settings and work down the setup checklist: a drafting provider and its
key, an ingest provider that is not Groq, your résumé, and the gap questions.

## Scripts

```bash
pnpm test         # node --test over src/**/*.test.ts
pnpm typecheck    # node + web projects
pnpm lint
pnpm build        # typecheck, then electron-vite build
pnpm build:win    # or :mac, :linux
```

## Layout

```
src/
  main/       Electron main: providers, résumé ingest, IPC, settings, hotkeys
  preload/    The typed `window.hue` bridge, the renderer's only IPC surface
  renderer/   React UI; `lib/pipeline.ts` drives the voice turn loop
  shared/     Pure logic used by both sides. Every module here has a test beside it.
```

`shared/` is where testable logic belongs. If something is a pure function of
settings or of a model response, it goes there and gets a test — `prompt.ts`,
which builds every word Hue sends an LLM, is the clearest case.

## Docs

`docs/` is an Obsidian vault. Start at `Project Overview.md`; `Decisions.md`
holds the ADRs, and `docs/specs` and `docs/plans` hold the design history.
