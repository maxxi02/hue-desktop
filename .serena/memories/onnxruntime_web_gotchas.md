# onnxruntime-web gotchas in this Electron renderer

This app is **NOT cross-origin isolated** (COOP/COEP deliberately off in `src/main/index.ts`), so there's no SharedArrayBuffer. Every onnxruntime-web (ORT) consumer must run **single-threaded** (`numThreads = 1`); any `numThreads > 1` makes `pthread_create` fail and hangs/freezes. ORT is `1.26.0-dev`, pulled in transitively via `@ricky0123/vad-web`. `@huggingface/transformers` is `4.2.0`.

## 1. VAD "Start session" hangs forever on "Connecting" + frozen UI

**Symptom:** clicking Start session sticks on `connecting` and the whole renderer wedges.

**Cause:** `MicVAD.new()` in `src/renderer/src/lib/pipeline.ts` was called without `baseAssetPath` / `onnxWASMBasePath`. vad-web then resolves its Silero model + ORT wasm against a CDN / the host page, which never resolves in the Electron renderer, so `MicVAD.new()` never settles.

**Fix (in place):** point both at the locally bundled, version-matched assets in `src/renderer/public/` (served at the renderer root in dev http and packaged file://):
```ts
const assetBase = new URL('./', window.location.href).href
this.vad = await MicVAD.new({
  model: 'v5',
  baseAssetPath: assetBase,
  onnxWASMBasePath: assetBase,
  ortConfig: (ort) => { ort.env.wasm.numThreads = 1; ort.env.logLevel = 'error' },
  ...
})
```
- Bundled assets in `public/` (`ort-wasm-simd-threaded.{wasm,mjs}`, `silero_vad_v5.onnx`, `vad.worklet.bundle.min.js`) are md5-identical to `node_modules/onnxruntime-web/dist` — keep them in sync if ORT is upgraded.
- Do **NOT** set `ort.env.wasm.proxy = true`: causes DataCloneError on the stateful Silero v5 state buffer.
- Confirmed working at runtime (logs: `started micVAD` / `Detected real speech start`).

## 2. Quantized Whisper session fails: "Missing required scale ... embed_tokens.weight_merged_0_scale"

**Full error:** `qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale ...`

**Cause:** a **4-bit (q4 / q4f16)** decoder file of `Xenova/whisper-base.en` is being loaded. The decoder's `embed_tokens` is weight-tied to the output projection in the merged decoder; ORT's `MatMulNBits` fusion (only runs for 4-bit block quant) can't find the scale for that merged tied weight, so `InferenceSession` creation aborts. q8/int8/fp32 use plain `DequantizeLinear` and never enter that fusion path.

**Ground truth (verified in installed `node_modules/@huggingface/transformers/src/utils/dtypes.js`, v4.2.0):** wasm device default dtype is **q8** (`DEFAULT_DEVICE_DTYPE_MAPPING = { [wasm]: q8 }`); `selectDtype`'s object-key-miss also falls back to q8. So **no current code path requests q4.** If you still see the q4 error, the running code/model is **stale**, not buggy.

**Fix (in place)** in `src/renderer/src/workers/whisper.worker.ts` — use the unambiguous single-string form so no module can fall back to q4, and pin the device:
```ts
pipeline('automatic-speech-recognition', MODEL_ID, {
  dtype: 'q8',
  device: 'wasm',
  progress_callback: ...
})
```

**CRITICAL — the code edit alone is NOT enough; the q4 error recurred 3x because of stale state.** A `dtype` change to a worker has two stale-state vectors that survive an ordinary save/HMR:
1. **Stale worker bundle.** Vite Web Workers (`new Worker(new URL(...), {type:'module'})`) do **not** reliably hot-reload — and electron-vite's `out/` build output can serve a pre-edit bundle. A plain save or even a window reload keeps running old code. **Must do a full `pnpm dev` restart**, and delete `out/` + `node_modules/.vite` first.
2. **Cached q4 model file.** transformers.js caches downloaded `.onnx` files via the Cache API (`transformers-cache`) in the Electron userData dir at `%APPDATA%\hue-desktop\Service Worker\CacheStorage` (was ~266MB). A q4 file fetched by an earlier code version lingers there across restarts. Delete that `CacheStorage` dir to force a clean q8 re-download (do NOT delete `hue-settings.json` — it holds settings). App must be closed (files lock otherwise).

**Full resolution procedure (do all, in order):**
1. Set `dtype: 'q8'` in `whisper.worker.ts` (done).
2. Close the app / stop `pnpm dev`.
3. `rm -rf out node_modules/.vite`
4. `rm -rf "$APPDATA/hue-desktop/Service Worker/CacheStorage"` (keeps `hue-settings.json`).
5. `pnpm dev` (full restart). Worker re-downloads the q8 decoder fresh.

- Alternatives if q4 must be kept: pass `session_options: { graphOptimizationLevel: 'basic' }` to skip the fusion, or use a known-good q4 export / matched stable ORT. Bulletproof but heavy: `dtype: 'fp32'` (no quantization at all, ~290MB download).
- Rule of thumb: avoid q4/q4f16/bnb4 for weight-tied seq2seq decoders on this ORT build; prefer q8/fp32.

Reference implementation for proven VAD/ORT config: sibling browser extension at `c:\dev-proj\hue-extension-claude\hue` (`src/hooks/useVAD.ts`, `src/workers/*.worker.ts`).
