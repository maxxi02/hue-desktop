# Task: fix recurring Whisper q4 "Missing required scale" error — STATUS

Last updated: 2026-05-26.

## Goal
Stop the ONNX session-creation error that fires during on-device transcription (after Hue receives voice):
`qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale`.
Full diagnosis + procedure live in `mem:onnxruntime_web_gotchas` (section 2).

## DONE (all completed this session)
1. Hardened `src/renderer/src/workers/whisper.worker.ts` `getTranscriber()` -> `dtype: 'q8'` + `device: 'wasm'` (single string, so no module can fall back to the broken q4 export).
2. Deleted stale build state: `out/` and `node_modules/.vite`.
3. Cleared stale model cache: `%APPDATA%\hue-desktop\Service Worker\CacheStorage` (~266MB; held a q4 file from an earlier code version). `hue-settings.json` was preserved.
4. Updated `mem:onnxruntime_web_gotchas` with the real root cause (stale worker bundle + cached q4 model, NOT a code logic bug — wasm default dtype is already q8 in transformers.js 4.2.0).

## PENDING (do this next)
1. **Full restart** `pnpm dev` (a plain save/HMR will NOT reload the worker — must be a fresh start). First transcription re-downloads the q8 decoder (~50MB, one-time).
2. **Verify**: speak to Hue, confirm transcription succeeds with NO `MatMulNBits` error.
3. If it STILL errors after the clean restart: the q8 export itself is suspect — fall back to bulletproof `dtype: 'fp32'` (no quantization, ~290MB download).
4. Once confirmed working, **commit** the two fixes (only one is outstanding now): `whisper.worker.ts` (q8 dtype). The earlier `pipeline.ts` VAD fix is already runtime-confirmed and may also be uncommitted. Check `git status`.

## Standing constraints (still in force)
- Use Serena for all code work (overview/find_symbol/replace_*; no Read/Edit for code discovery/edits).
- Security: API keys/secrets stay in the main process via safeStorage; LLM calls run in the main process; keys must never reach the renderer.
