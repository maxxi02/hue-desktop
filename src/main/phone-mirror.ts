import { createServer, type Server, type ServerResponse } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { networkInterfaces } from 'os'
import type { PhoneMirrorEvent, PhoneMirrorStatus } from '../shared/types'
import phonePage from './phone-page.html?raw'

/**
 * Phone mirror: a small LAN HTTP server that streams the companion session to a
 * phone browser. Two token-authenticated routes:
 *   GET /?t=TOKEN        -> the static mobile page (phone-page.html)
 *   GET /events?t=TOKEN  -> Server-Sent Events stream of PhoneMirrorEvents
 *
 * SSE (not WebSocket) because the phone only receives — plain Node http needs no
 * extra dependency and the browser reconnects on its own. The token is random
 * per server start and rides in the QR-code URL; requests without it get a 404
 * so port scanners learn nothing. See docs/Phone Mirror.md (ADR-005).
 */

const PREFERRED_PORT = 4717
// Keep-alive comment cadence: under typical 30-60s proxy/router idle timeouts.
const HEARTBEAT_MS = 25_000

let server: Server | null = null
let token = ''
let baseUrl = ''
let heartbeat: NodeJS.Timeout | null = null
const clients = new Set<ServerResponse>()

// Snapshot of the conversation so a phone that connects (or reconnects)
// mid-session immediately shows the current question/answer/state.
let lastQuestion: string | null = null
let lastAnswer: string | null = null
let lastState: string | null = null

function tokenMatches(provided: string | null): boolean {
  if (!provided || !token) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** First non-internal IPv4 address — the URL the phone can actually reach. */
function lanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

function writeEvent(res: ServerResponse, ev: PhoneMirrorEvent): void {
  res.write(`data: ${JSON.stringify(ev)}\n\n`)
}

function handleRequest(req: import('http').IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost')
  // Unauthenticated requests get a bare 404 — indistinguishable from no service.
  if (!tokenMatches(url.searchParams.get('t'))) {
    res.writeHead(404).end()
    return
  }

  if (url.pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(phonePage)
    return
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    res.write(':connected\n\n')
    // Replay the current session so a mid-session join isn't a blank page.
    if (lastState) writeEvent(res, { type: 'state', text: lastState })
    if (lastQuestion) writeEvent(res, { type: 'question', text: lastQuestion })
    if (lastAnswer) writeEvent(res, { type: 'answer', text: lastAnswer })
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  res.writeHead(404).end()
}

export function getPhoneMirrorStatus(): PhoneMirrorStatus {
  return server ? { running: true, url: `${baseUrl}/?t=${token}` } : { running: false, url: '' }
}

export async function startPhoneMirror(): Promise<PhoneMirrorStatus> {
  if (server) return getPhoneMirrorStatus()

  token = randomBytes(16).toString('hex')
  const srv = createServer(handleRequest)

  // Try the well-known port first (a stable QR across restarts); if something
  // else owns it, fall back to an OS-assigned free port.
  await new Promise<void>((resolvePort, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        srv.listen(0, '0.0.0.0', resolvePort)
      } else {
        reject(err)
      }
    }
    srv.once('error', onError)
    srv.listen(PREFERRED_PORT, '0.0.0.0', () => {
      srv.removeListener('error', onError)
      resolvePort()
    })
  })

  const address = srv.address()
  const port = typeof address === 'object' && address ? address.port : PREFERRED_PORT
  baseUrl = `http://${lanAddress()}:${port}`
  server = srv

  heartbeat = setInterval(() => {
    for (const res of clients) res.write(':hb\n\n')
  }, HEARTBEAT_MS)

  return getPhoneMirrorStatus()
}

export function stopPhoneMirror(): void {
  if (!server) return
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  for (const res of clients) res.end()
  clients.clear()
  server.close()
  server = null
  token = ''
  baseUrl = ''
  lastQuestion = null
  lastAnswer = null
  lastState = null
}

export function broadcastPhoneEvent(ev: PhoneMirrorEvent): void {
  if (!server) return
  if (ev.type === 'question') {
    lastQuestion = ev.text ?? null
    lastAnswer = null // a new question obsoletes the previous answer
  } else if (ev.type === 'answer') {
    lastAnswer = ev.text ?? null
  } else if (ev.type === 'state') {
    lastState = ev.text ?? null
  } else if (ev.type === 'clear') {
    lastQuestion = null
    lastAnswer = null
  }
  for (const res of clients) writeEvent(res, ev)
}
