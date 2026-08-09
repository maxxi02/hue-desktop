import type { RelayPairing } from '../shared/types'

/**
 * Codec for the pairing URI carried in the Settings QR code. The Android app
 * parses the identical format (hue-mobile: pairing/PairingUri.kt) — if you change
 * the shape here, change it there in the same commit or pairing silently breaks.
 *
 *   hue://pair?u=<uriComponent(relayBaseUrl)>&r=<roomId>&t=<subscribeToken>
 *
 * A custom scheme rather than an https link so scanning it can only ever open
 * the app, never a browser that would leak the token into history.
 */

const ROOM_ID_RE = /^[0-9a-f]{16}$/
const TOKEN_RE = /^[0-9a-f]{32}$/

export function encodePairingUri(p: RelayPairing): string {
  const params = new URLSearchParams({
    u: p.relayBaseUrl,
    r: p.roomId,
    t: p.subscribeToken
  })
  return `hue://pair?${params.toString()}`
}

export function decodePairingUri(uri: string): RelayPairing | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  if (parsed.protocol !== 'hue:') return null

  const relayBaseUrl = parsed.searchParams.get('u')
  const roomId = parsed.searchParams.get('r')
  const subscribeToken = parsed.searchParams.get('t')
  if (!relayBaseUrl || !roomId || !subscribeToken) return null
  if (!ROOM_ID_RE.test(roomId) || !TOKEN_RE.test(subscribeToken)) return null

  // Only http(s) — a scanned QR must never be able to point the client at a
  // file:// or custom-scheme target.
  let relay: URL
  try {
    relay = new URL(relayBaseUrl)
  } catch {
    return null
  }
  if (relay.protocol !== 'http:' && relay.protocol !== 'https:') return null

  return { relayBaseUrl, roomId, subscribeToken }
}
