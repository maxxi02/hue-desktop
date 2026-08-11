/**
 * Session history — the thin persistence layer under the post-session review.
 *
 * `reviewSession()` turns a finished session into a scorecard, but a scorecard
 * that dies with the window teaches nothing: the whole premise of the review is
 * that practice compounds, and it cannot compound across a restart unless
 * something outlives the process. This module is that something.
 *
 * ## Why localStorage, and why renderer-only
 *
 * The obvious alternative — a JSON file in the main process behind an IPC
 * channel — buys durability guarantees this data does not need and costs a new
 * trust surface it should not have. The review is a convenience record of the
 * user's own rehearsals: losing it is a shrug, and nothing else in the app reads
 * it. Keeping it in the renderer means the transcript-derived data never crosses
 * a process boundary at all, which is the smaller blast radius.
 *
 * ## What is stored, and what is deliberately thrown away
 *
 * A `StoredSession` holds **only** `{ role, grounding? }` per turn — exactly the
 * `ReviewTurn` shape the review model reads, and not one field more. The
 * transcript itself is dropped on the floor: it contains the interviewer's
 * questions and the user's own answers about their real employer, which is the
 * most sensitive material this app ever holds and which the review has no use
 * for. Anything not needed to recompute the scorecard is not written.
 *
 * The grounded branch of a receipt does carry the cited `ProfileStory`, which is
 * résumé content — but it is the user's *own* résumé, already persisted verbatim
 * in settings as `profileBundleJson`, so retaining it here adds no new exposure,
 * and it is what lets a review of an old session still name its stories after
 * the bank has been re-ingested.
 *
 * Everything else — competencies, counts, open gaps — is recomputed at render
 * time against the *current* bundle rather than frozen at save time. That is
 * deliberate: "gaps still outstanding" should mean outstanding *now*, so a gap
 * filled since the session stops nagging, which is the whole point of the list.
 *
 * ## Failure is expected, and must be quiet
 *
 * Every read is defensive. localStorage is a string keyed by an origin that a
 * devtools console, a half-finished write during a crash, or a future schema
 * change can all corrupt — and this module is called during first paint, so an
 * exception here bricks the app on boot with no way for the user to recover
 * short of clearing site data they cannot see. A record that does not parse or
 * does not typecheck is discarded, not repaired: a scorecard built from a
 * half-valid record would report counts that never happened.
 *
 * Pure except for the storage handle, which is injectable — that is what makes
 * the pruning and corruption behaviour testable under `node --test`, where there
 * is no localStorage at all.
 */

import type { ReviewTurn } from '../../../shared/session-review.ts'
import type { Grounding } from '../../../shared/grounding.ts'

/**
 * Versioned key. A schema change ships under a new key rather than migrating:
 * the data is disposable rehearsal history, and a migration is code that runs
 * on boot and can fail on boot for a payoff nobody would notice.
 */
export const SESSION_HISTORY_KEY = 'hue.session-history.v1'

/**
 * How many finished sessions are kept.
 *
 * localStorage is a hard ~5 MB per origin shared with everything else the
 * renderer might ever store, and a session that cited ten stories carries ten
 * full STAR records — so an uncapped list grows without bound and eventually
 * starts throwing QuotaExceededError on the one write that matters. Twenty is
 * comfortably more history than anyone steps back through, and bounds the worst
 * case at a size localStorage does not notice.
 */
export const MAX_STORED_SESSIONS = 20

/** A finished session, reduced to what the review can be recomputed from. */
export interface StoredSession {
  /** Stable identity for React keys and for the stepper. */
  id: string
  /** ISO timestamp of when the session ended, for the panel's dateline. */
  endedAt: string
  turns: ReviewTurn[]
}

/**
 * The two localStorage methods this module uses.
 *
 * Narrowed to an interface so tests can pass a plain in-memory double, and so a
 * caller in a context without `window` cannot accidentally depend on more of the
 * Storage API than is actually used here.
 */
export interface SessionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The real localStorage, or null where there isn't one.
 *
 * Accessing `localStorage` can *throw* rather than return undefined when storage
 * is disabled by policy, so the access itself is guarded.
 */
function defaultStorage(): SessionStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Shape-checks a receipt read back from storage.
 *
 * Only the fields the review and the panel actually read are checked. The story
 * is validated down to `situation`, because `describeStory()` builds its label
 * from that field and would throw on a story that lost it.
 */
function isGrounding(value: unknown): value is Grounding {
  if (!isRecord(value)) return false
  if (value.kind === 'grounded') {
    const story = value.story
    return (
      isRecord(story) &&
      typeof story.id === 'string' &&
      typeof story.situation === 'string' &&
      Array.isArray(story.competencies)
    )
  }
  if (value.kind === 'ungrounded') {
    return value.claimedId === null || typeof value.claimedId === 'string'
  }
  return false
}

function isReviewTurn(value: unknown): value is ReviewTurn {
  if (!isRecord(value)) return false
  if (value.role !== 'user' && value.role !== 'assistant') return false
  // Absent is legal — a user turn has no receipt. Present but malformed is not:
  // see below for why that condemns the whole record rather than the turn.
  if (value.grounding === undefined) return true
  return isGrounding(value.grounding)
}

/**
 * Validates one stored session.
 *
 * A single bad turn rejects the *whole* session rather than being skipped. The
 * scorecard's headline is "9 of 12 answers came from your bank", and silently
 * dropping an unreadable turn would quietly turn that into "9 of 11" — a number
 * the user has no way to know is wrong. A missing session is honest; a session
 * with invented arithmetic is not.
 */
function isStoredSession(value: unknown): value is StoredSession {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.endedAt !== 'string' || value.endedAt === '') return false
  if (!Array.isArray(value.turns)) return false
  return value.turns.every(isReviewTurn)
}

/**
 * Parses the stored blob, discarding anything unreadable.
 *
 * Two layers of tolerance, and they fail differently on purpose: a blob that is
 * not a JSON array is a total loss and yields an empty history, while a single
 * corrupt record inside a valid array costs only that record. One bad session
 * must never take the other nineteen with it.
 *
 * Exported for the tests, which is the only reason it is not private — the
 * corruption paths are exactly what needs pinning down.
 */
export function parseSessionHistory(raw: string | null): StoredSession[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isStoredSession)
}

/**
 * Keeps the newest [MAX_STORED_SESSIONS] entries.
 *
 * The list is stored newest-first, so pruning is a head slice — oldest records
 * fall off the end, which is the right direction: the session you just finished
 * is the one you are about to read.
 */
export function pruneSessions(sessions: readonly StoredSession[]): StoredSession[] {
  return sessions.slice(0, MAX_STORED_SESSIONS)
}

/** Reads the history, newest first. Never throws. */
export function loadSessions(storage: SessionStorage | null = defaultStorage()): StoredSession[] {
  if (!storage) return []
  try {
    return pruneSessions(parseSessionHistory(storage.getItem(SESSION_HISTORY_KEY)))
  } catch {
    return []
  }
}

/**
 * Prepends a session and writes the pruned list back.
 *
 * Returns the new list so the caller can put it straight into React state
 * without a re-read — and so the UI still shows the review even in the case
 * where the write itself failed (a full quota, private-mode storage). The
 * session is lost on restart there, but refusing to *show* the scorecard the
 * user just earned because it could not be filed would be the worse failure.
 */
export function saveSession(
  session: StoredSession,
  storage: SessionStorage | null = defaultStorage()
): StoredSession[] {
  const next = pruneSessions([session, ...loadSessions(storage)])
  if (storage) {
    try {
      storage.setItem(SESSION_HISTORY_KEY, JSON.stringify(next))
    } catch {
      // Quota exceeded, or storage disabled mid-flight. Nothing to say to the
      // user: they did not ask for this write, and a session that ends with an
      // error toast about localStorage is worse than one that quietly forgets.
    }
  }
  return next
}

/**
 * Strips a live transcript down to what may be persisted.
 *
 * The single point where transcript text is dropped, so that "we do not store
 * the user's answers" is enforced by construction rather than by everyone
 * remembering. Anything gained by a future `Message` field is excluded here by
 * default, which is the correct default for this data.
 */
export function toReviewTurns(
  messages: readonly { role: 'user' | 'assistant'; grounding?: Grounding }[]
): ReviewTurn[] {
  return messages.map((m) => ({ role: m.role, ...(m.grounding ? { grounding: m.grounding } : {}) }))
}

/**
 * Is there anything to review?
 *
 * A receipt-free session — the user pressed start and stopped again, or every
 * turn was cut off mid-stream — produces a scorecard reading "No answers in this
 * session", which is not a record of practice. Storing it would push a real
 * session out of the capped list and put an empty card in front of someone who
 * just finished talking.
 */
export function isReviewable(turns: readonly ReviewTurn[]): boolean {
  return turns.some((t) => t.role === 'assistant' && t.grounding !== undefined)
}

/**
 * Builds a storable session. The clock and the id source are injectable for the
 * same reason the storage is: so the tests are not at the mercy of either.
 */
export function createSession(
  turns: ReviewTurn[],
  endedAt: string = new Date().toISOString(),
  id: string = newId()
): StoredSession {
  return { id, endedAt, turns }
}

/**
 * `crypto.randomUUID` is present in Electron's renderer, but this module is also
 * loaded by `node --test` where the global surface is not guaranteed, so the
 * timestamp-plus-noise fallback keeps ids unique enough for a React key.
 */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
