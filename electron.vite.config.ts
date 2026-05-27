import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // uiohook-napi is a native (.node) addon — it can't be bundled by Vite.
        // Keep it external so the main process require()s it from node_modules,
        // where node-gyp-build resolves the platform's prebuilt binary.
        external: ['uiohook-napi']
      }
    }
  },
  preload: {},
  renderer: {
    // onnxruntime-web (via @ricky0123/vad-web) ships only the multi-threaded
    // WASM build, whose shared memory needs SharedArrayBuffer — which the
    // browser only exposes in a cross-origin-isolated context. Without these
    // headers, InferenceSession.create() hangs and freezes the renderer.
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless'
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    // onnxruntime-web (required by @ricky0123/vad-web) locates its .mjs/.wasm
    // loaders via import.meta.url. The dep optimizer rewrites that to .vite/deps,
    // where the loaders don't exist → 404 → VAD model load fails. Excluding it
    // serves the native ESM as-is so import.meta.url resolves to the real dist
    // dir. vad-web itself stays optimized — it's CommonJS, and the optimizer is
    // what synthesizes its `MicVAD` named export for ESM import.
    optimizeDeps: {
      exclude: ['onnxruntime-web', 'onnxruntime-web/wasm']
    },
    worker: {
      format: 'es'
    },
    plugins: [react()]
  }
})
