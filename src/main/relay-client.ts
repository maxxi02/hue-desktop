import { networkInterfaces } from 'os'
import type { PhoneMirrorEvent, RelayStatus } from '../shared/types'
import { encodePairingUri } from './pairing'

/**
 * Publishes the companion session to a hue-relay room so the Hue phone app can
 * follow it over cellular. Runs alongside the LAN phone mirror (phone-mirror.ts),
 * which stays the offline path — see docs ADR-007.
 *
 * Publishing is fire-and-forget with a short bounded retry: a dropped event is a
 * missed frame on a screen that gets a fresh cumulative answer moments later, so
 * blocking the pipeline to guarantee delivery would trade real latency for
 * nothing. Persistent failures surface as `status.error` in Settings.
 *
 * Events are published strictly one at a time. `answer` carries the whole answer
 * so far and the relay keeps only the last write, so an event that overtakes its
 * predecessor leaves the phone showing older, shorter text until something else
 * arrives. A retry is exactly what makes that overtaking possible, so ordering is
 * enforced on our side rather than hoped for.
 */

const REGISTER_TIMEOUT_MS = 10_000
const PUBLISH_TIMEOUT_MS = 5000
const MAX_ATTEMPTS = 3
const MAX_TEXT_CHARS = 8000
/**
 * Ceiling on how long one event may hold the queue. Comfortably above the worst
 * honest case (3 attempts plus backoff) so it never truncates a real retry — it
 * exists only so a request that neither resolves nor times out cannot wedge every
 * later event behind it forever.
 */
const QUEUE_HOLD_LIMIT_MS = 20_000
/** One dropped frame is noise; a run of them is a real outage worth showing. */
const FAILURES_BEFORE_ERROR = 3

let baseUrl = ''
let roomId = ''
let publishToken = ''
let pairingUri = ''
let lastError: string | null = null
let consecutiveFailures = 0
/** Tail of the publish queue: each event chains onto whatever is still in flight. */
let publishChain: Promise<void> = Promise.resolve()
/**
 * Bumped whenever the room goes away. Queued events carry the generation they
 * were produced under, so work waiting behind a stalled publish is dropped rather
 * than delivered to a room nobody is watching any more.
 */
let publishGeneration = 0
/**
 * Per-type sequence numbers, and the newest sequence queued for each type.
 *
 * `publishRelayEvent` is called once per LLM delta — hundreds of times per
 * answer — and each event carries the *whole* cumulative answer. Chaining one
 * serial POST per delta meant a 500-token answer became 500 round trips: on
 * cellular at 100 ms RTT the queue could not drain within a turn, so the backlog
 * (and the retained bodies behind it) grew monotonically for the whole session
 * and the phone fell minutes behind.
 *
 * Because the relay keeps only the last write, a superseded event of the same
 * type has no reader — sending it is pure cost. So a job that is no longer the
 * newest of its type is dropped at the head of the queue instead of being sent,
 * which collapses those 500 round trips into however many the network can
 * actually carry, always ending on the final, complete text.
 */
const typeSeq = new Map<string, number>()
const latestSeq = new Map<string, number>()

export function getRelayStatus(): RelayStatus {
  return { running: Boolean(roomId), pairingUri, error: lastError }
}

/** First non-internal IPv4 address — an address the phone can actually reach. */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return null
}

/**
 * The pairing URI is consumed *only by the phone*, so a loopback host in it is
 * always wrong — it tells the phone to connect to itself. The desktop can still
 * publish over loopback perfectly well, so rather than rejecting the setting we
 * rewrite just the address that goes into the QR.
 *
 * Returns null when there is no usable LAN address, so the caller can say so
 * plainly instead of minting a QR that silently never delivers anything.
 */
function phoneReachableBase(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '0.0.0.0']
  if (!loopback.includes(parsed.hostname)) return url

  const lan = lanAddress()
  if (!lan) return null
  parsed.hostname = lan
  return parsed.toString().replace(/\/+$/, '')
}

/** Registers a fresh room. Any previously paired phone is orphaned by design. */
export async function startRelay(rawBaseUrl: string): Promise<RelayStatus> {
  stopRelay()

  const trimmed = rawBaseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(trimmed)) {
    lastError = 'Relay URL must start with http:// or https://'
    return getRelayStatus()
  }

  try {
    const res = await fetch(`${trimmed}/v1/rooms`, {
      method: 'POST',
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS)
    })
    if (!res.ok) {
      lastError = `Relay refused the room request (HTTP ${res.status})`
      return getRelayStatus()
    }
    const room = (await res.json()) as {
      roomId?: unknown
      publishToken?: unknown
      subscribeToken?: unknown
    }
    if (
      typeof room.roomId !== 'string' ||
      typeof room.publishToken !== 'string' ||
      typeof room.subscribeToken !== 'string'
    ) {
      lastError = 'Relay returned a malformed room'
      return getRelayStatus()
    }

    const phoneBase = phoneReachableBase(trimmed)
    if (!phoneBase) {
      lastError =
        'This computer has no network address your phone could reach. ' +
        'Connect it to the same Wi-Fi as your phone, or point the relay URL at a public host.'
      return getRelayStatus()
    }

    baseUrl = trimmed
    roomId = room.roomId
    publishToken = room.publishToken
    // Publishing uses `trimmed` (loopback is fine from here); the QR carries
    // `phoneBase`, which is the address the phone can actually resolve.
    pairingUri = encodePairingUri({
      relayBaseUrl: phoneBase,
      roomId: room.roomId,
      subscribeToken: room.subscribeToken
    })
    lastError = null
    consecutiveFailures = 0
  } catch (err) {
    lastError = `Could not reach the relay: ${(err as Error).message}`
  }

  return getRelayStatus()
}

export function stopRelay(): void {
  baseUrl = ''
  roomId = ''
  publishToken = ''
  pairingUri = ''
  lastError = null
  consecutiveFailures = 0
  publishGeneration++
  // A new room starts a new stream; carrying old sequence numbers over would let
  // the first event of each type be judged stale against the previous session.
  typeSeq.clear()
  latestSeq.clear()
}

export function publishRelayEvent(ev: PhoneMirrorEvent): void {
  if (!roomId) return

  const text = typeof ev.text === 'string' ? ev.text.slice(0, MAX_TEXT_CHARS) : undefined
  const body = JSON.stringify(text === undefined ? { type: ev.type } : { type: ev.type, text })
  const url = `${baseUrl}/v1/rooms/${roomId}/events`
  // Snapshot the room this event belongs to: a re-register mid-flight must not
  // retarget an in-flight retry at the new room.
  const token = publishToken
  const forRoom = roomId
  const generation = publishGeneration

  const seq = (typeSeq.get(ev.type) ?? 0) + 1
  typeSeq.set(ev.type, seq)
  latestSeq.set(ev.type, seq)

  // Queue rather than launch: the caller still gets an immediate return, but the
  // request itself only leaves once everything published before it is done with.
  publishChain = publishChain.then(() =>
    deliver({ url, body, token, forRoom, generation, type: ev.type, seq }).catch(() => {})
  )
}

interface QueuedPublish {
  url: string
  body: string
  token: string
  forRoom: string
  generation: number
  type: string
  seq: number
}

async function deliver(job: QueuedPublish): Promise<void> {
  // Whatever was in front of us may have taken seconds; if the room died in the
  // meantime this event has nowhere useful to go.
  if (job.generation !== publishGeneration) return

  // A newer event of this same type was queued while we waited. Since the relay
  // keeps only the last write, this one would be overwritten on arrival by text
  // that already exists — so it is dropped rather than sent. Ordering is
  // unaffected: the survivor is by definition the newest.
  if (job.seq !== latestSeq.get(job.type)) return

  // One controller for the whole job, so the hold limit cuts off the outstanding
  // request too — abandoning a request without aborting it would let it land later
  // and reintroduce exactly the reordering the queue exists to prevent.
  const jobAbort = new AbortController()
  const holdTimer = setTimeout(() => jobAbort.abort(), QUEUE_HOLD_LIMIT_MS)
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (jobAbort.signal.aborted) break
      try {
        const res = await fetch(job.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${job.token}`, 'Content-Type': 'application/json' },
          body: job.body,
          signal: AbortSignal.any([jobAbort.signal, AbortSignal.timeout(PUBLISH_TIMEOUT_MS)])
        })
        // A 404 means the room is gone (relay restarted — rooms are in-memory —
        // or it was swept). Retrying this event cannot help, but doing nothing
        // else left the desktop publishing into a cleared roomId for the rest of
        // the session: `publishRelayEvent` returns early on an empty room, so
        // every later event was silently dropped and the only sign was an error
        // string buried in Settings. Registering a fresh room at least leaves a
        // scannable QR there instead of a dead session.
        if (res.status === 404) {
          if (roomId === job.forRoom) {
            stopRoomOnly()
            lastError = 'The relay room expired — re-pair your phone'
            scheduleReRegister()
          }
          return
        }
        if (res.ok) {
          if (roomId === job.forRoom) {
            consecutiveFailures = 0
            lastError = null
          }
          return
        }
      } catch {
        // Network error or timeout — fall through to the backoff below.
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)))
      }
    }
    if (roomId !== job.forRoom) return
    consecutiveFailures++
    if (consecutiveFailures >= FAILURES_BEFORE_ERROR) lastError = 'Losing connection to the relay'
  } finally {
    clearTimeout(holdTimer)
  }
}

/**
 * Register a replacement room after the old one vanished.
 *
 * Guarded against re-entry, because the failure that triggers it is one of many
 * queued events failing at once — without the latch, a single relay restart
 * would fire a room-registration per queued event.
 *
 * The new room means a new pairing URI, so the phone cannot silently follow: the
 * error says so, and Settings shows a QR that works.
 */
let reRegisterInFlight = false

function scheduleReRegister(): void {
  if (reRegisterInFlight || !baseUrl) return
  const url = baseUrl
  reRegisterInFlight = true
  void startRelay(url)
    .then((status) => {
      if (status.running) {
        lastError = 'The relay restarted — re-scan the QR in Settings to reconnect your phone'
      }
    })
    .catch((e) => console.error('could not re-register the relay room:', e))
    .finally(() => {
      reRegisterInFlight = false
    })
}

/** Clears the room but keeps the configured base URL, so a retry can re-register. */
function stopRoomOnly(): void {
  roomId = ''
  publishToken = ''
  pairingUri = ''
  publishGeneration++
}
