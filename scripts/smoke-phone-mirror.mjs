// Smoke test for the phone-mirror server (no Electron needed):
//   node scripts/smoke-phone-mirror.mjs
// Bundles src/main/phone-mirror.ts with esbuild (emulating Vite's `?raw` HTML
// import), starts the server, and checks: token auth (404 without/with bad
// token), the mobile page, and the SSE stream incl. snapshot replay.
import { build } from 'esbuild'
import { readFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

const rawPlugin = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw'
    }))
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text'
    }))
  }
}

function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

const outDir = await mkdtemp(path.join(tmpdir(), 'hue-phone-smoke-'))
const outFile = path.join(outDir, 'phone-mirror.mjs')
await build({
  entryPoints: ['src/main/phone-mirror.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  plugins: [rawPlugin]
})

const mod = await import(pathToFileURL(outFile).href)
const status = await mod.startPhoneMirror()
assert(status.running && status.url.startsWith('http://'), `server started at ${status.url}`)

const url = new URL(status.url)
const base = `http://127.0.0.1:${url.port}` // loopback works regardless of LAN IP
const token = url.searchParams.get('t')

assert((await fetch(`${base}/`)).status === 404, 'no token -> 404')
assert((await fetch(`${base}/?t=wrong`)).status === 404, 'bad token -> 404')

const page = await fetch(`${base}/?t=${token}`)
assert(page.status === 200, 'good token -> 200')
assert((await page.text()).includes('Suggested answer'), 'mobile page served')

// Seed a snapshot, then connect: the new client must get it replayed, and a
// later broadcast must stream through live.
mod.broadcastPhoneEvent({ type: 'question', text: 'Tell me about yourself' })
const sse = await fetch(`${base}/events?t=${token}`)
assert(sse.status === 200, 'SSE endpoint -> 200')
const reader = sse.body.getReader()
let received = ''
const readUntil = async (needle) => {
  const deadline = Date.now() + 5000
  while (!received.includes(needle)) {
    if (Date.now() > deadline) return false
    const { value, done } = await reader.read()
    if (done) return false
    received += new TextDecoder().decode(value)
  }
  return true
}
assert(await readUntil('Tell me about yourself'), 'snapshot replayed to new client')
mod.broadcastPhoneEvent({ type: 'answer', text: 'I am a software engineer…' })
assert(await readUntil('I am a software engineer'), 'live event streamed')

reader.cancel()
mod.stopPhoneMirror()
assert(true, 'server stopped cleanly')
await rm(outDir, { recursive: true, force: true })
console.log('PASS: phone-mirror smoke test')
