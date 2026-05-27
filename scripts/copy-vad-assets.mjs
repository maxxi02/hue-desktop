// Copies the runtime assets that @ricky0123/vad-web fetches at startup into the
// renderer's public dir, so they are served from the app origin (./) in both
// `electron-vite dev` and the packaged build. Without this the VAD fails with
// "Encountered an error while loading model file ./silero_vad_v5.onnx".
import { createRequire } from 'node:module'
import { mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const publicDir = join(root, 'src', 'renderer', 'public')

// These entry points resolve to files inside each package's dist dir.
const vadDist = dirname(require.resolve('@ricky0123/vad-web'))
const ortDist = dirname(require.resolve('onnxruntime-web/wasm'))

const assets = [
  join(vadDist, 'silero_vad_v5.onnx'),
  join(vadDist, 'silero_vad_legacy.onnx'),
  join(vadDist, 'vad.worklet.bundle.min.js'),
  // ONNX Runtime WebAssembly. vad-web imports the wasm-only backend
  // (onnxruntime-web/wasm) and sets ort.env.wasm.wasmPaths = './', so only the
  // non-jsep threaded build is fetched.
  join(ortDist, 'ort-wasm-simd-threaded.wasm'),
  join(ortDist, 'ort-wasm-simd-threaded.mjs')
]

mkdirSync(publicDir, { recursive: true })

let copied = 0
for (const src of assets) {
  if (!existsSync(src)) {
    console.warn(`[copy-vad-assets] skip (not found): ${src}`)
    continue
  }
  copyFileSync(src, join(publicDir, src.split(/[\\/]/).pop()))
  copied++
}
console.log(`[copy-vad-assets] copied ${copied} asset(s) to ${publicDir}`)
