import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useVoiceMode } from './hooks/useVoiceMode'
import type { PipelineState } from './lib/pipeline'
import { isAtBottom } from './lib/stickToBottom'
import type { VoiceTurn, CaptureTurn } from './hooks/useVoiceMode'
import type { ScreenCapture } from '@shared/types'
import { describeStory, type Grounding } from '@shared/grounding'
import { stripEmphasis, type CueCard, type CueSheet } from '@shared/cuesheet'
import { parseProfileBundle, type ProfileBundle } from '@shared/profile'
import { describeReview, reviewSession, type SessionReview } from '@shared/session-review'
import {
  createSession,
  isReviewable,
  loadSessions,
  saveSession,
  toReviewTurns,
  type StoredSession
} from './lib/sessionHistory'
import { Settings } from './components/Settings'
import { CueSheetPanel } from './components/CueSheetPanel'
import { UsagePanel } from './components/UsagePanel'

// ── Icons ──

function MicIcon(): React.JSX.Element {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10c0 3.866 3.134 7 7 7s7-3.134 7-7" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="8" y1="21" x2="16" y2="21" />
    </svg>
  )
}

function StopIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}

function ClearIcon(): React.JSX.Element {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

function CameraIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

/**
 * The glance-mode toggle, drawn as arrows pushing outward (enter) or pulling
 * back in (leave). Deliberately not an eye or a magnifier: both read as "preview
 * something else", whereas this mode enlarges the thing already on screen, and
 * the mirrored pair makes the button's current state legible without a label —
 * which matters because the whole control has to be understood in the half
 * second someone can spare mid-answer.
 */
function GlanceIcon({ on }: { on: boolean }): React.JSX.Element {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {on ? (
        <>
          <path d="M9 3v6H3" />
          <path d="M15 3v6h6" />
          <path d="M9 21v-6H3" />
          <path d="M15 21v-6h6" />
        </>
      ) : (
        <>
          <path d="M3 9V3h6" />
          <path d="M21 9V3h-6" />
          <path d="M3 15v6h6" />
          <path d="M21 15v6h-6" />
        </>
      )}
    </svg>
  )
}

/**
 * The review toggle: a checklist, not a chart or a trophy.
 *
 * The panel behind it is a list of what was covered and what is still open, and
 * a bar-chart glyph would promise analytics the review deliberately does not do
 * (there is no score, and no attempt to grade an answer's quality).
 */
function ReviewIcon(): React.JSX.Element {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="M9 12l2 2 4-4" />
      <path d="M9 17h6" />
    </svg>
  )
}

/**
 * The usage toggle: a gauge, not a coin or a chart.
 *
 * What the panel is actually about is headroom — how much of a fixed allowance
 * is left — and a gauge is the one glyph that says "remaining" without also
 * promising billing (a coin would imply we know what it cost in money, which we
 * do not) or history over time (a line chart, which the panel does not draw).
 */
function UsageIcon(): React.JSX.Element {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 17a9 9 0 1 1 17 0" />
      <path d="M12 17l4.5-4.5" />
    </svg>
  )
}

function GearIcon(): React.JSX.Element {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// ── Helpers ──

const STATE_LABELS: Record<PipelineState, string> = {
  idle: 'Ready',
  connecting: 'Connecting',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  speaking: 'Speaking'
}

interface Message {
  role: 'user' | 'assistant'
  text: string
  tier?: string
  latencyMs?: number
  /** Present on a user turn that was a screen capture; rendered as a thumbnail. */
  image?: ScreenCapture
  /**
   * The grounding receipt for a finished assistant turn. Absent while the answer
   * is still streaming (the citation arrives last) and on turns where a receipt
   * does not apply — see VoicePipeline.resolveTurnGrounding.
   */
  grounding?: Grounding
}

/**
 * The grounding receipt under an answer.
 *
 * Grounded says which of the user's own stories the answer rests on, named by
 * its situation rather than its slug, so they can recognise it as theirs at a
 * glance. Ungrounded says the answer is not anchored to their real history —
 * worded as an instruction to improvise rather than an error, because it usually
 * isn't one: the model was asked to say so honestly when no story fits, and the
 * answer can still be perfectly good to speak in their own words.
 */
function Receipt({ grounding }: { grounding: Grounding }): React.JSX.Element {
  if (grounding.kind === 'grounded') {
    return (
      <div className="receipt receipt--grounded" title={`Story bank entry: ${grounding.story.id}`}>
        <span className="receipt-mark" aria-hidden="true" />
        From your story bank · {describeStory(grounding.story)}
      </div>
    )
  }
  return (
    <div
      className="receipt receipt--ungrounded"
      title={
        grounding.claimedId
          ? `Hue cited "${grounding.claimedId}", which is not an entry in your story bank.`
          : 'Hue did not cite an entry from your story bank.'
      }
    >
      <span className="receipt-mark" aria-hidden="true" />
      Not anchored to your history — improvise from this, don’t read it off the screen.
    </div>
  )
}

/**
 * The user's own prepared answer, latched onto the current question.
 *
 * Rendered in place of a generated answer, never beside one — the pipeline
 * enforces that itself by aborting generation the instant a card latches (see
 * VoicePipeline.applyFinalCommands), so there is never a competing assistant
 * turn for this to conflict with; callers just need to stop showing whatever
 * they showed before and show this instead.
 *
 * `cues` get the exact text-block treatment the generated answer already uses
 * (passed in as `textClass` — `bubble-text` in the transcript, `glance-text`
 * in glance mode), just bolded per line, so the user is not learning a second
 * layout under pressure. `script` sits behind a disclosure that starts
 * collapsed: an open paragraph invites reading verbatim, which is the exact
 * failure mode the cue format exists to prevent. Callers must mount this
 * keyed on `card.id` — the collapsed state lives in this component's own
 * `useState`, and without a fresh key a second question would inherit the
 * first question's already-open script.
 */
function CueCardBody({ card, textClass }: { card: CueCard; textClass: string }): React.JSX.Element {
  const [scriptOpen, setScriptOpen] = useState(false)
  return (
    <>
      <div className="bubble-label">Prepared answer</div>
      <div className={textClass}>
        {card.cues.map((cue, i) => (
          <div key={i}>
            <strong>{stripEmphasis(cue)}</strong>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="review-close"
        onClick={() => setScriptOpen((v) => !v)}
        aria-expanded={scriptOpen}
        title={scriptOpen ? 'Hide the full prepared script' : 'Show the full prepared script'}
      >
        {scriptOpen ? 'Hide full script' : 'Show full script'}
      </button>
      {scriptOpen && <div className={textClass}>{card.script}</div>}
    </>
  )
}

// ── Post-session review ──

/**
 * When the session ended, in the shortest form that still disambiguates.
 *
 * Deliberately not "3 hours ago": the panel is also the way you step back
 * through last week's rehearsals, and a relative stamp stops being an anchor the
 * moment there is more than one of them on screen over time. A malformed stamp
 * (a hand-edited storage record) degrades to nothing rather than to
 * "Invalid Date", which would read as an app bug.
 */
function formatEndedAt(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * The grounded / ungrounded split, as a bar and a sentence.
 *
 * This is the top of the panel because it is the only number that says what
 * *kind* of practice the session was. Everything below it — competencies,
 * stories, gaps — describes a session that was anchored; if none of it was, the
 * rest is close to meaningless and the user needs to know that first.
 *
 * The zero-grounded case is therefore given its own sentence rather than an
 * empty bar and a row of blank lists. An empty scorecard reads as "nothing to
 * report", which is the exact opposite of the truth: it means every answer Hue
 * offered was invented rather than drawn from the user's real history, and
 * rehearsing those answers builds confidence in stories they cannot defend.
 */
function GroundingSplit({ review }: { review: SessionReview }): React.JSX.Element {
  const { total, grounded, ungrounded } = review.answers
  const pct = total === 0 ? 0 : Math.round((grounded / total) * 100)
  const none = grounded === 0 && total > 0
  return (
    <section className="review-section">
      <div className="settings-section-title">Answers anchored to your history</div>
      <div className={none ? 'review-bar review-bar--none' : 'review-bar'}>
        <div className="review-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="review-split">
        <span className="review-split-figure">
          {grounded} of {total}
        </span>
        <span className="review-split-rest">
          from your story bank
          {ungrounded > 0 ? ` · ${ungrounded} improvised` : ''}
        </span>
      </div>
      {none && (
        <div className="review-alert">
          Not one of these {total === 1 ? 'answers' : `${total} answers`} was anchored to a story in
          your bank. They may have sounded good — but you rehearsed invention, not your own history,
          and none of it is material you can defend under follow-up questions.
        </div>
      )}
    </section>
  )
}

/** How many never-used stories are named before the list summarises itself. */
const UNUSED_SHOWN = 8

/**
 * One finished session, rendered as a scorecard.
 *
 * The review is recomputed here from the stored turns and the *current* bundle
 * rather than read from storage, so a gap filled since the session shows as
 * filled. See sessionHistory.ts for why only the receipts are persisted.
 */
function SessionReviewPanel({
  sessions,
  index,
  onIndex,
  onClose,
  bundle
}: {
  sessions: StoredSession[]
  index: number
  onIndex: (next: number) => void
  onClose: () => void
  bundle: ProfileBundle | null
}): React.JSX.Element | null {
  const session = sessions[index]
  // Recomputed only when the session or the bank changes; reviewSession walks
  // every turn and every gap, and this component re-renders on each keystroke
  // elsewhere in the app.
  const review = useMemo(
    () => (session ? reviewSession(session.turns, bundle) : null),
    [session, bundle]
  )
  if (!session || !review) return null

  const dateline = formatEndedAt(session.endedAt)
  // Index 0 is the newest, so "older" walks forward through the array. Naming
  // the buttons by time rather than by direction is what keeps that legible.
  const older = index + 1
  const newer = index - 1

  return (
    <div className="review">
      <div className="review-head">
        <div className="review-head-text">
          <div className="review-title">Session review</div>
          <div className="review-dateline">
            {dateline && <span>{dateline}</span>}
            <span>{describeReview(review)}</span>
          </div>
        </div>
        <div className="review-nav">
          {sessions.length > 1 && (
            <>
              <button
                className="review-step"
                onClick={() => onIndex(older)}
                disabled={older >= sessions.length}
                title="Older session"
              >
                ‹
              </button>
              <span className="review-count">
                {index + 1} / {sessions.length}
              </span>
              <button
                className="review-step"
                onClick={() => onIndex(newer)}
                disabled={newer < 0}
                title="Newer session"
              >
                ›
              </button>
            </>
          )}
          <button className="review-close" onClick={onClose} title="Close the review">
            Done
          </button>
        </div>
      </div>

      <div className="review-body">
        <GroundingSplit review={review} />

        {!review.hasProfile ? (
          /* No bundle at all. Every list below would be empty for a reason that
             has nothing to do with how the session went, and showing them would
             read as a failed session rather than a missing résumé. */
          <div className="review-note">
            There is no résumé profile on this install, so Hue had no story bank to anchor to.
            Upload one in Settings and the next session gets a real scorecard.
          </div>
        ) : (
          <>
            <section className="review-section">
              <div className="settings-section-title">Competencies covered</div>
              {review.competencies.length > 0 ? (
                <div className="review-chips">
                  {review.competencies.map((c) => (
                    <span key={c} className="review-chip">
                      {c}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="review-empty">
                  Nothing was cited, so no competency was demonstrably covered.
                </div>
              )}
            </section>

            <section className="review-section">
              <div className="settings-section-title">Stories you used</div>
              {review.storiesUsed.length > 0 ? (
                <ul className="review-list">
                  {review.storiesUsed.map((s) => (
                    <li key={s.storyId} className="review-row">
                      <span className="review-row-text">{s.label}</span>
                      {/* The count is the point of this list: a story told four
                          times in one session is a crutch, and the user cannot
                          see that from the transcript. */}
                      <span className="review-count-pill">×{s.count}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="review-empty">No story from your bank came up.</div>
              )}
            </section>

            <section className="review-section">
              <div className="settings-section-title">Still open</div>
              {review.openGapsUntouched.length === 0 && review.openGapsTouched.length === 0 ? (
                <div className="review-empty">
                  No open gaps left — every question your profile flagged has an answer.
                </div>
              ) : (
                <>
                  {review.openGapsUntouched.map((g) => (
                    <div key={g.id} className="review-gap">
                      <span className="review-chip review-chip--quiet">{g.competency}</span>
                      <span className="review-row-text">{g.question}</span>
                    </div>
                  ))}
                  {review.openGapsTouched.length > 0 && (
                    <>
                      {/* Kept apart, and second, because "you walked adjacent
                          ground" is genuinely weaker evidence than a citation —
                          the session covered the competency, not the gap. */}
                      <div className="review-subnote">
                        Touched on — you cited a story tagged the same way, but these are still
                        unanswered:
                      </div>
                      {review.openGapsTouched.map((g) => (
                        <div key={g.id} className="review-gap review-gap--touched">
                          <span className="review-chip review-chip--quiet">{g.competency}</span>
                          <span className="review-row-text">{g.question}</span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </section>

            {review.storiesUnused.length > 0 && (
              <section className="review-section">
                <div className="settings-section-title">Never came up</div>
                {/* Not a to-do list — a session cannot use every story, and
                    framing this as work would nag. It is here so a story that
                    never surfaces across several sessions becomes visible.
                    Capped because a large bank would otherwise end the panel
                    with a wall of grey longer than everything above it, which
                    would bury the open gaps that actually are work to do. */}
                <div className="review-unused">
                  {review.storiesUnused
                    .slice(0, UNUSED_SHOWN)
                    .map((s) => s.label)
                    .join(' · ')}
                  {review.storiesUnused.length > UNUSED_SHOWN &&
                    ` · and ${review.storiesUnused.length - UNUSED_SHOWN} more`}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── The transcript / cue sheet split ──

/**
 * How narrow either side of the split may get, as a percentage of the row.
 *
 * Clamped rather than free because both panes are prose read under time
 * pressure: a transcript squeezed to a column of two-word lines is unreadable,
 * and a cue sheet squeezed the same way is worse, because the user reaches for
 * it precisely when they have no attention to spare on re-wrapping text. The
 * bounds are the same on both sides — neither pane is the "real" one.
 */
const SPLIT_MIN_PCT = 34
const SPLIT_MAX_PCT = 70
/** Slightly transcript-heavy at rest: the sheet is scanned, the transcript is read. */
const SPLIT_DEFAULT_PCT = 56
/** Keyboard resize step, in percent, for the divider's arrow keys. */
const SPLIT_KEY_STEP = 4

function clampSplit(pct: number): number {
  return Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct))
}

// ── App ──

export default function App(): React.JSX.Element {
  const voice = useVoiceMode()
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * The usage panel, which takes the main area the way the review does.
   *
   * Not a drawer and not a Settings pane: quota is something you check *because*
   * a session is behaving oddly, and burying it behind the gear would put it
   * three clicks from the moment it is wanted. It is transient state for the
   * same reason glance mode is — nobody wants to launch into a stats screen.
   */
  const [usageOpen, setUsageOpen] = useState(false)
  /**
   * Glance mode: the card becomes a teleprompter for the current suggested
   * answer (see `.glance` in main.css for the type scale and why it exists).
   *
   * Held in transient state rather than persisted in HueSettings on purpose.
   * It is a posture for the minutes you are actually on a call, not a
   * preference — landing in a giant single-answer panel on next launch, with no
   * answer to show and the transcript gone, would read as a broken app rather
   * than a remembered choice.
   */
  const [glance, setGlance] = useState(false)
  const companion = voice.mode === 'companion'
  const userLabel = companion ? 'Interviewer' : 'You'
  const assistantLabel = companion ? 'Suggested answer' : 'Hue'
  const [messages, setMessages] = useState<Message[]>([])
  const transcriptRef = useRef<HTMLDivElement>(null)
  /**
   * Whether the transcript should keep following new text. A ref, not state:
   * it is read by the scroll effect and written by the scroll handler, and
   * re-rendering on every wheel tick to store it would be pure waste. Starts
   * true so a fresh session follows from the first token.
   */
  const followTranscriptRef = useRef(true)
  /**
   * Where the transcript ends and the cue sheet begins, as a percentage of the
   * split row. Transient state like `glance`, and for the same reason: it is a
   * posture for the call you are on, not a preference worth restoring into a
   * session that may not even have a sheet armed.
   */
  const [splitPct, setSplitPct] = useState(SPLIT_DEFAULT_PCT)
  const [dividerDragging, setDividerDragging] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)
  const glanceRef = useRef<HTMLDivElement>(null)
  // The answer glance mode last painted, used to tell a growing answer from a
  // new one. See the scroll effect below.
  const prevGlanceTextRef = useRef<string | undefined>(undefined)
  const prevTranscriptIdRef = useRef<number | undefined>(undefined)
  const prevCaptureIdRef = useRef<number | undefined>(undefined)
  const prevResultIdRef = useRef<number | undefined>(undefined)
  // Whether a session was running on the previous render, so the end of one can
  // be detected as an edge rather than as a state.
  const prevActiveRef = useRef(false)

  /**
   * The story bank the review is scored against, read from the same settings
   * blob the pipeline grounds answers with.
   *
   * Held in App rather than fetched inside the panel because it is re-read when
   * the settings drawer closes: uploading a résumé, or answering a gap, must be
   * reflected in an open review immediately — the gap the user just filled is
   * exactly the line they will look at next.
   */
  const [bundle, setBundle] = useState<ProfileBundle | null>(null)

  /**
   * The armed cue sheet, read from settings rather than from the pipeline.
   *
   * The pipeline also reports it, but only from `start()` — which meant the
   * document appeared solely once a session was running. That is backwards for
   * what this panel is: prepared answers are read *before* the call, while you
   * are still deciding whether the sheet is any good, and between questions.
   * Uploading a sheet and finding nothing on screen is the bug that behaviour
   * produced.
   *
   * Loaded here and re-loaded when the drawer closes, so arming or replacing a
   * sheet in Settings shows up immediately. During a session the pipeline's
   * copy wins, since that is the one the matcher is actually scoring against.
   */
  const [armedSheet, setArmedSheet] = useState<CueSheet | null>(null)

  /**
   * The sheet the panel actually shows.
   *
   * The pipeline's copy wins during a session because that is the one the
   * matcher is scoring against, so the document on screen and the card that
   * latches can never come from different sheets. Outside a session there is no
   * pipeline, and the armed sheet read from settings is the answer.
   */
  const visibleSheet = voice.cueSheet ?? armedSheet

  // Reads the settings that affect what App renders: the card's translucency
  // (from windowOpacity) and the profile bundle. Re-run when the settings drawer
  // closes so both take effect live rather than at next launch.
  const applySettings = useCallback((): void => {
    // Shaped like refreshStealth below — the state lands in the promise
    // callback rather than in the effect body, which is both what the
    // set-state-in-effect rule wants and what actually happens: the settings
    // read is IPC, so there is no render this could have been done during.
    void window.hue.settings.get().then((s) => {
      document.documentElement.style.setProperty('--bg-alpha', String(s.windowOpacity))
      setBundle(parseProfileBundle(s.profileBundleJson))

      // Same guard the pipeline applies: an id that no longer resolves (sheet
      // deleted, settings stale) means no sheet, never an error. A cue sheet is
      // an aid, and nothing about it may break the screen it sits on.
      if (!s.selectedCueSheetId) {
        setArmedSheet(null)
        return
      }
      void window.hue.cueSheet
        .list()
        .then((sheets) => {
          setArmedSheet(sheets.find((sheet) => sheet.id === s.selectedCueSheetId) ?? null)
        })
        .catch(() => setArmedSheet(null))
    })
  }, [])

  useEffect(() => {
    applySettings()
  }, [applySettings])

  /**
   * Finished sessions, newest first, seeded from localStorage on first paint.
   *
   * The lazy initialiser runs synchronously during the first render on purpose:
   * `loadSessions` is a single localStorage read and cannot throw (see
   * sessionHistory.ts), and doing it in an effect would flash a "no history"
   * header for one frame on every launch.
   */
  const [sessions, setSessions] = useState<StoredSession[]>(() => loadSessions())
  /** Index into `sessions` of the review on screen, or null when it is closed. */
  const [reviewIndex, setReviewIndex] = useState<number | null>(null)

  // Whether the window is genuinely out of screen captures right now. Tracked
  // separately from the setting because an unsupported platform leaves the
  // setting on while the protection is absent — the badge must only appear when
  // the OS is really doing it, or it becomes a false reassurance mid-interview.
  const [stealthOn, setStealthOn] = useState(false)
  const refreshStealth = useCallback((): void => {
    void window.hue.stealth.getStealthStatus().then((status) => setStealthOn(status.effective))
  }, [])

  useEffect(() => {
    refreshStealth()
  }, [refreshStealth])

  useEffect(() => {
    const t: VoiceTurn | null = voice.userTranscript
    // Deduped by utterance, not by text: two identical questions are two
    // questions, and treating the second as a repeat of the first dropped its
    // bubble and let the new answer overwrite the old one in place.
    if (!t?.text || t.id === prevTranscriptIdRef.current) return
    prevTranscriptIdRef.current = t.id
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: t.text, tier: String(t.tier), latencyMs: t.latencyMs }
    ])
  }, [voice.userTranscript])

  useEffect(() => {
    const c: CaptureTurn | null = voice.capture
    if (!c || c.id === prevCaptureIdRef.current) return
    prevCaptureIdRef.current = c.id
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: 'Shared a screen capture', image: c.shot }
    ])
  }, [voice.capture])

  useEffect(() => {
    const text = voice.assistantText
    if (!text) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { role: 'assistant', text }]
      }
      return [...prev, { role: 'assistant', text }]
    })
  }, [voice.assistantText])

  // The finished turn replaces the streamed one: same text, minus any citation
  // line, plus the receipt. Keyed on the result's id so an identical answer given
  // twice still lands, and so re-renders don't re-apply the same turn.
  useEffect(() => {
    const r = voice.assistantResult
    if (!r || r.id === prevResultIdRef.current) return
    prevResultIdRef.current = r.id
    const finished: Message = {
      role: 'assistant',
      text: r.text,
      ...(r.grounding ? { grounding: r.grounding } : {})
    }
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant') return [...prev.slice(0, -1), finished]
      return [...prev, finished]
    })
  }, [voice.assistantResult])

  /**
   * Follow new text, but only for a reader who is already at the bottom.
   *
   * `messages` changes on every streamed token, so an unconditional jump here
   * re-pins the pane dozens of times a second and scrolling up is undone in the
   * frame it happens — the wheel reads as dead and nothing above the fold can be
   * reached while Hue is answering. `followTranscriptRef` is maintained by the
   * pane's own scroll handler, so leaving the bottom stops the chase and
   * returning to it resumes.
   */
  useEffect(() => {
    const el = transcriptRef.current
    if (el && followTranscriptRef.current) el.scrollTop = el.scrollHeight
  }, [messages, voice.greetingText, voice.cueCard])

  /**
   * Re-arm auto-follow when the reader comes back to the bottom.
   *
   * Fires for programmatic scrolls too, including the effect above — which is
   * harmless, because that one only ever lands at the bottom and so re-asserts
   * the `true` it was gated on.
   */
  const onTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current
    if (el) followTranscriptRef.current = isAtBottom(el)
  }, [])

  /**
   * File the review when the session ends.
   *
   * Fired on the active → idle edge, which covers every way a session can end:
   * the Stop button, the global hotkey, the tray, and the pipeline stopping
   * itself on a fatal error. Doing it in `stop()`'s click handler would miss the
   * last three.
   *
   * `messages` is a dependency rather than a ref because the effect must see the
   * final transcript, and the edge check makes the extra runs free: once the
   * transition has been consumed, `wasActive` is false and every later run
   * returns immediately.
   *
   * Filing is all this does — it deliberately does not open the panel. A review
   * that appeared on its own took over the screen at the one moment the user is
   * least ready for it: the call has just ended, they may still be on it saying
   * goodbye, and the thing they were reading was replaced by a scorecard they
   * did not ask for. Reading it is a decision, not a consequence of stopping, so
   * it waits behind the header's review button until they choose to open it.
   *
   * Nothing is shown or stored for a session with no receipts — see
   * `isReviewable`.
   */
  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = voice.active

    // A session starting closes the scorecard. It is checked ahead of the live
    // view, so leaving it open meant a restarted session rendered last session's
    // review over a running one: Hue listening and answering, with the answers
    // invisible until the user found the Done button. Fat-fingering the stop
    // hotkey mid-interview is all it took.
    if (voice.active) {
      if (!wasActive) setReviewIndex(null)
      return
    }
    if (!wasActive) return

    const turns = toReviewTurns(messages)
    if (!isReviewable(turns)) return
    // Synchronous by design, and guarded by the edge check above so it runs
    // exactly once per session: the review is a response to a transition, not a
    // value derived from state, so there is nothing to compute during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessions(saveSession(createSession(turns)))
  }, [voice.active, messages])

  // Reset the visible transcript and the underlying LLM history so the next turn
  // starts fresh. Also clear the dedupe ref so a repeated phrase still shows up.
  const clearConversation = (): void => {
    voice.clear()
    setMessages([])
    // The stored history deliberately survives — that is what it is for — but
    // the panel closes: "start fresh" means the screen is clear, and leaving the
    // last scorecard up would hide the empty transcript the user just asked for.
    setReviewIndex(null)
    prevTranscriptIdRef.current = undefined
    prevCaptureIdRef.current = undefined
    prevResultIdRef.current = undefined
  }

  const hasConversation = messages.length > 0 || Boolean(voice.greetingText)

  /**
   * The answer glance mode reads from: the most recent assistant turn, whatever
   * state it is in. Deriving it from `messages` rather than from
   * `voice.assistantText` is what makes streaming settle cleanly — the streamed
   * turn and the finished turn that replaces it are the same array slot, so the
   * text grows in place and then gains its receipt, with no gap where the panel
   * would blank between the last token and the resolved grounding.
   */
  const latestAnswer = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role === 'assistant') return m
    }
    return undefined
  }, [messages])

  /**
   * Scroll discipline for the reader.
   *
   * The transcript chases the newest line, and glance mode must not: an answer
   * streams in far faster than anyone speaks it, so pinning the view to the
   * last token would slide the sentence being read out from under the eye and
   * leave the user staring at an ending whose beginning they never saw. While
   * an answer is growing, the scroll position is therefore left exactly where
   * it is — a token landing off-screen costs nothing, a line that moves
   * mid-word costs the user their place in front of an interviewer.
   *
   * A *new* answer is the one case that must move, and must move to the top,
   * because that is where reading it starts. Continuation is detected by prefix
   * in either direction rather than by identity: the streamed turn grows from
   * its own prefix, and the finished turn that replaces it is the same text
   * minus the citation line — shorter, but still a prefix — so the settle at
   * the end of a stream is correctly read as the same answer and does not
   * throw the user back to the top of what they were already halfway through.
   *
   * `useLayoutEffect` so the jump is committed in the frame that paints the new
   * text; done in a passive effect it would show one frame of the new answer at
   * the old offset.
   */
  useLayoutEffect(() => {
    const el = glanceRef.current
    if (!el) {
      prevGlanceTextRef.current = undefined
      return
    }
    if (voice.cueCard) {
      // A cue card lands whole rather than streaming in, so it is never a
      // "continuation" of whatever text was on screen before — every card is
      // read from the top, the same as a genuinely new generated answer.
      prevGlanceTextRef.current = undefined
      el.scrollTop = 0
      return
    }
    const text = latestAnswer?.text ?? ''
    const prev = prevGlanceTextRef.current
    const continuation =
      prev !== undefined && prev !== '' && (text.startsWith(prev) || prev.startsWith(text))
    prevGlanceTextRef.current = text
    if (!continuation) el.scrollTop = 0
  }, [latestAnswer?.text, glance, voice.cueCard])

  /**
   * The divider drag.
   *
   * The listeners live on `window` rather than on the handle so the pointer can
   * outrun the 10px target — it always does — and so releasing the button
   * anywhere, including outside the window, ends the drag. Mounted only while a
   * drag is in progress, so the app is not carrying a mousemove listener for
   * the 99.9% of a session where nobody is resizing anything.
   */
  useEffect(() => {
    if (!dividerDragging) return
    const onMove = (e: MouseEvent): void => {
      const el = splitRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width === 0) return
      setSplitPct(clampSplit(((e.clientX - rect.left) / rect.width) * 100))
    }
    const onUp = (): void => setDividerDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dividerDragging])

  // Escape leaves glance mode. Getting back to the full transcript has to be a
  // reflex, not a hunt for the toggle — and Escape is already free here, since
  // the settings drawer owns its own close affordance.
  useEffect(() => {
    if (!glance) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setGlance(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [glance])

  // Escape closes the review too, for the same reason it leaves glance mode:
  // both are modes over the transcript, and one key that means "back" is easier
  // to remember than two. Registered separately from the glance handler so
  // neither can swallow the other's key — glance never shows the review anyway.
  useEffect(() => {
    if (glance || reviewIndex === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setReviewIndex(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [glance, reviewIndex])

  // And out of usage, so "back" means the same thing in all three modes.
  useEffect(() => {
    if (glance || !usageOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setUsageOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [glance, usageOpen])

  return (
    <div className={glance ? 'app app--glance' : 'app'}>
      <header className="app-header">
        <div className="app-brand">
          <div className={`brand-orb brand-orb--${voice.state}`} />
          <span className="brand-name">Hue</span>
        </div>
        <div className="header-pills">
          <div className={`state-pill state-pill--${voice.state}`}>{STATE_LABELS[voice.state]}</div>
          {/* The mode pill is standing information — which side of the call Hue
              is listening to — and glance mode is where standing information
              costs the most. The state pill stays because it changes, and a
              user reading an answer aloud needs to know Hue is still listening;
              the stealth badge stays because it is a safety claim. */}
          {!glance && (
            <div
              className="mode-pill"
              title={`Listening to ${voice.audioSource === 'system' ? 'system / call audio' : 'microphone'}`}
            >
              {companion ? 'Companion' : 'Interviewer'}
              {voice.audioSource === 'system' ? ' · System' : ' · Mic'}
            </div>
          )}
          {stealthOn && (
            <div
              className="mode-pill mode-pill--stealth"
              title="This window is excluded from screen shares and screen-capture APIs. It does not hide the Hue process, its tray icon, or the audio devices it uses."
            >
              Stealth
            </div>
          )}
        </div>
        {/* Reaching past sessions. Hidden with no history (it would open an
            empty panel) and in glance mode, which is a live reading surface and
            must never gain a way to bury the answer under a scorecard. */}
        {sessions.length > 0 && !glance && (
          <button
            className={reviewIndex !== null ? 'icon-btn icon-btn--on' : 'icon-btn'}
            onClick={() => {
              // Review and usage both take the whole main area, so opening one
              // has to close the other — leaving both flags set would make the
              // hidden panel's button light up for a surface nobody can see.
              setUsageOpen(false)
              setReviewIndex((v) => (v === null ? 0 : null))
            }}
            aria-pressed={reviewIndex !== null}
            title={
              reviewIndex !== null
                ? 'Close the session review'
                : 'Session review — what you covered, which stories you used, what is still open'
            }
          >
            <ReviewIcon />
          </button>
        )}
        {/* Usage. Always available, unlike the review, because there is a real
            answer even before the first session ("nothing recorded yet") — but
            hidden in glance mode, which must not gain a way to cover the answer
            being read aloud. */}
        {!glance && (
          <button
            className={usageOpen ? 'icon-btn icon-btn--on' : 'icon-btn'}
            onClick={() => {
              setReviewIndex(null)
              setUsageOpen((v) => !v)
            }}
            aria-pressed={usageOpen}
            title={
              usageOpen
                ? 'Close usage'
                : 'Usage and quota — what Hue has spent, and what each provider says is left'
            }
          >
            <UsageIcon />
          </button>
        )}
        {hasConversation && !glance && (
          <button
            className="icon-btn"
            onClick={clearConversation}
            title="Clear conversation and start fresh"
          >
            <ClearIcon />
          </button>
        )}
        <button
          className={glance ? 'icon-btn icon-btn--on' : 'icon-btn'}
          onClick={() => setGlance((v) => !v)}
          aria-pressed={glance}
          title={
            glance
              ? 'Leave glance mode (Esc) — back to the full transcript'
              : 'Glance mode — show the suggested answer in large type for reading mid-call'
          }
        >
          <GlanceIcon on={glance} />
        </button>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Open settings">
          <GearIcon />
        </button>
      </header>

      {glance ? (
        /*
         * Glance mode. One thing on screen, sized to be taken in with a look
         * rather than read — the labels, the interviewer's turn and the
         * conversation history all go, because every one of them is something
         * the eye has to skip past on the way to the sentence being spoken.
         * (The footer orb goes too; it is switched off on the `glance` flag
         * down in the footer rather than here.)
         *
         * The receipt is the one piece of chrome that survives, and it is
         * pinned rather than merely kept: an ungrounded answer is *more*
         * dangerous here than in the transcript, because glance mode is the
         * context where someone reads a suggestion aloud with confidence. If it
         * scrolled away with the top of the answer, the warning would be gone
         * at precisely the point in a long answer where the user has stopped
         * checking and started performing.
         */
        <main className="app-main app-main--glance">
          <div className="glance" ref={glanceRef}>
            {voice.cueCard ? (
              // The user's own prepared answer takes the whole surface — never
              // alongside a generated one, see CueCardBody's doc comment.
              <CueCardBody key={voice.cueCard.id} card={voice.cueCard} textClass="glance-text" />
            ) : latestAnswer ? (
              <div className="glance-text">{latestAnswer.text}</div>
            ) : (
              <div className="glance-text glance-text--waiting">
                {voice.active
                  ? 'Hue’s suggestion will appear here.'
                  : 'Start a session — Hue’s suggestion will appear here.'}
              </div>
            )}
            {voice.error && <div className="error-msg">{voice.error}</div>}
            {/* No receipt for a cue card: it is the user's own prepared answer,
                not a generated one, so there is nothing to ground. */}
            {!voice.cueCard && latestAnswer?.grounding && (
              <div className="glance-receipt">
                <Receipt grounding={latestAnswer.grounding} />
              </div>
            )}
          </div>
        </main>
      ) : usageOpen ? (
        // Same slot and same reasoning as the review below: inside the card, no
        // second window, and the way back is the button that opened it.
        <main className="app-main">
          <UsagePanel onClose={() => setUsageOpen(false)} />
        </main>
      ) : reviewIndex !== null ? (
        /*
         * The review takes the whole main area rather than sitting beside the
         * transcript. It is read after the call, when nothing is live, and the
         * card is small enough that splitting it would leave two panes too short
         * to read either.
         *
         * Deliberately inside the card and inside the existing layout: no second
         * window and no route, so Stop is still where it was and the way back to
         * the transcript is the same button that opened this.
         */
        <main className="app-main">
          <SessionReviewPanel
            sessions={sessions}
            index={Math.min(reviewIndex, sessions.length - 1)}
            onIndex={setReviewIndex}
            onClose={() => setReviewIndex(null)}
            bundle={bundle}
          />
        </main>
      ) : (
        <main className="app-main">
          {/*
           * Transcript and cue sheet, side by side.
           *
           * The row is here even with no sheet armed — one pane, flexed to the
           * full width — so that arming one does not restructure the layout the
           * transcript lives in. The transcript's own scroll position survives
           * as a result, which matters because a sheet can be armed between
           * questions of a live session.
           */}
          <div className="cuesheet-split" ref={splitRef}>
            <div
              className="cuesheet-split-pane"
              style={visibleSheet ? { flex: `0 0 ${splitPct}%` } : { flex: '1 1 auto' }}
            >
              <div className="transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
                {voice.greetingText && (
                  <div className="bubble bubble--assistant">
                    <div className="bubble-label">Hue</div>
                    <div className="bubble-text">{voice.greetingText}</div>
                  </div>
                )}
                {messages.length === 0 && !voice.greetingText ? (
                  <div className="transcript-empty">
                    <span>
                      {voice.connecting
                        ? 'Starting up…'
                        : voice.active
                          ? companion
                            ? 'Listening for the interviewer’s question…'
                            : 'Hue is starting the interview…'
                          : 'Press Start — or hit Ctrl+Shift+Space to summon Hue, and use your start-session shortcut anytime during a live call'}
                    </span>
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div key={i} className={`bubble bubble--${msg.role}`}>
                      <div className="bubble-label">
                        {msg.role === 'user' ? userLabel : assistantLabel}
                      </div>
                      {msg.image ? (
                        <img
                          className="bubble-capture"
                          src={`data:${msg.image.mediaType};base64,${msg.image.dataBase64}`}
                          alt="Captured screen sent to Hue"
                        />
                      ) : (
                        <div className="bubble-text">{msg.text}</div>
                      )}
                      {msg.grounding && <Receipt grounding={msg.grounding} />}
                      {msg.role === 'user' && msg.tier && (
                        <div className="bubble-meta">
                          {msg.tier} · {msg.latencyMs}ms
                        </div>
                      )}
                    </div>
                  ))
                )}
                {/* The prepared answer for the question just asked. There is never
                a generated bubble to sit beside — the pipeline aborts
                generation the moment a card latches — so this simply appears
                where that bubble would otherwise have gone. */}
                {voice.cueCard && (
                  <div className="bubble bubble--assistant">
                    <CueCardBody
                      key={voice.cueCard.id}
                      card={voice.cueCard}
                      textClass="bubble-text"
                    />
                  </div>
                )}
                {voice.error && <div className="error-msg">{voice.error}</div>}
              </div>
            </div>
            {visibleSheet && (
              <>
                <div
                  className={
                    dividerDragging
                      ? 'cuesheet-divider cuesheet-divider--dragging'
                      : 'cuesheet-divider'
                  }
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the cue sheet panel"
                  aria-valuenow={Math.round(splitPct)}
                  aria-valuemin={SPLIT_MIN_PCT}
                  aria-valuemax={SPLIT_MAX_PCT}
                  tabIndex={0}
                  onMouseDown={(e) => {
                    // Or the drag selects the transcript text it passes over.
                    e.preventDefault()
                    setDividerDragging(true)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') setSplitPct((v) => clampSplit(v - SPLIT_KEY_STEP))
                    else if (e.key === 'ArrowRight')
                      setSplitPct((v) => clampSplit(v + SPLIT_KEY_STEP))
                    else return
                    e.preventDefault()
                  }}
                  title="Drag to resize"
                />
                <div className="cuesheet-split-pane" style={{ flex: '1 1 0' }}>
                  <CueSheetPanel sheet={visibleSheet} activeCardId={voice.cueCard?.id ?? null} />
                </div>
              </>
            )}
          </div>
        </main>
      )}

      <footer className="app-footer">
        {/* The footer keeps its two side rails even when they are empty: they
            are what centres the start/stop button, and in glance mode that
            button is the only way out of a live session. It must not shift
            position when the mode toggles. */}
        <div className="footer-meta">
          {/* The orb lives on the rail beside the button that changes its state,
              not in the reading area. It used to sit above the transcript at
              96px, where it was the largest thing on screen and said the least:
              the header pill already names the state in words, so the orb was
              spending the top of the card to repeat it. Down here it is what it
              always was — a status light — and it is next to Start/Stop, which
              is the control it reports on.

              Hidden in glance mode for the same reason the latency badge is:
              nothing that merely reflects state competes with the sentence
              being read aloud. The header pill carries the state there. */}
          {!glance && (
            <div
              className={`footer-orb footer-orb--${voice.state}`}
              title={`Hue: ${STATE_LABELS[voice.state]}`}
              /* The header state pill announces this in text already; a second
                 announcement of the same state is noise to a screen reader. */
              aria-hidden="true"
            />
          )}
          {!glance && voice.userTranscript && (
            <span className="latency-badge">
              {voice.userTranscript.tier} · {voice.userTranscript.latencyMs}ms
            </span>
          )}
        </div>
        <button
          className={`voice-btn voice-btn--${
            voice.connecting ? 'connecting' : voice.active ? 'stop' : 'start'
          }`}
          onClick={() => (voice.active ? voice.stop() : voice.start())}
          disabled={voice.connecting}
        >
          {voice.connecting ? (
            <>
              <span className="btn-spinner" />
              Connecting…
            </>
          ) : voice.active ? (
            <>
              <StopIcon />
              Stop session
            </>
          ) : (
            <>
              <MicIcon />
              Start session
            </>
          )}
        </button>
        <div className="footer-meta footer-meta--right">
          {!glance && voice.active && !voice.connecting && (
            <button
              className="capture-btn"
              onClick={() => void voice.captureScreen()}
              disabled={voice.state === 'transcribing' || voice.state === 'thinking'}
              title="Capture the screen and ask Hue about it (e.g. a shared coding prompt)"
            >
              <CameraIcon />
              Capture screen
            </button>
          )}
        </div>
      </footer>

      {/*
        Always mounted, hidden with CSS rather than unmounted.

        Closing the drawer used to destroy this component, and with it the state
        tracking an upload in progress. The ingest itself kept running in the
        main process and the sheet was still saved — but the pane came back
        blank, so the upload looked cancelled and got started again. Keeping the
        component alive is what makes "close Settings and carry on" safe.
      */}
      <Settings
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false)
          voice.reloadConfig()
          applySettings()
          refreshStealth()
        }}
      />
    </div>
  )
}
