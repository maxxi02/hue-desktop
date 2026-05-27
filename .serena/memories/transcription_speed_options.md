# Transcription speed: options & recommendation

Question raised: how to make on-device transcribing faster, and is 8 GB RAM enough.

## RAM is not the bottleneck
`Xenova/whisper-base.en` at q8 needs only a few hundred MB at runtime — 8 GB RAM is plenty. The real constraint is **CPU**: the Whisper worker is pinned to single-threaded WASM (`numThreads = 1`) because the app is deliberately NOT cross-origin isolated (no SharedArrayBuffer). See `onnxruntime_web_gotchas.md`. So speed gains must come from the compute path, not more memory.

## Current setup
- `src/renderer/src/workers/whisper.worker.ts`: `MODEL_ID = 'Xenova/whisper-base.en'`, `dtype: 'q8'`, `device: 'wasm'`, single-threaded.
- Cloud tier already exists (`transcribeCloud` in `src/renderer/src/lib/transcription.ts`): Deepgram / AssemblyAI / Groq, proxied through main. Tier resolution prefers cloud when a key is present (`resolveTier`).

## Options (by effort)
1. **`whisper-tiny.en`** — 1-line `MODEL_ID` change. ~2x faster, lower accuracy. Safe guaranteed local win.
2. **WebGPU** — `device: 'wasm'` -> `'webgpu'` (with wasm fallback). Likely the biggest *local* speedup; WebGPU does NOT need cross-origin isolation, so it bypasses the single-thread block. Hardware-dependent; dtype path differs from q8 (often fp32/fp16), and this repo has documented Whisper-decoder quantization landmines — needs testing.
3. **Cloud (Groq)** — fastest overall; `whisper-large-v3-turbo` is faster AND more accurate than local base.en. Needs an API key + connection.

## Recommendation (for this live-interview use case, accuracy + latency both matter)
- **Cloud (Groq) is best overall** when online is acceptable — a misheard question yields a wrong suggested answer, so accuracy matters, and Groq wins on both axes during a remote interview.
- **WebGPU + base.en is the best local/offline path** — keeps accuracy, big speedup, no cross-origin isolation required.
- **tiny.en** only as a fallback if the GPU path is flaky.

Nothing implemented yet — this is a decision record pending the user's chosen direction.
