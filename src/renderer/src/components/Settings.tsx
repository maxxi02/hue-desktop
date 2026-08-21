import { useState, useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import type {
  HueSettings,
  AsrTier,
  AudioSource,
  CloudAsrProvider,
  HueMode,
  InterviewMode,
  LlmProvider,
  OpenAiCompatProvider,
  PhoneMirrorStatus,
  RelayStatus,
  StealthStatus,
  WindowAnchor
} from '@shared/types'
import { describeBundle, parseProfileBundle } from '../../../shared/profile'
import {
  describeJobSpec,
  parseJobSpec,
  JOB_DESCRIPTION_LIMIT,
  type JobSpec
} from '../../../shared/job-spec'
import { parseJobBrief } from '../../../shared/job-brief'
import { clampCursor, nextAfterAnswered, stepCursor } from '../lib/gapCursor'
import { isSettingsDirty } from '../lib/settingsDirty'
import { SectionIcon } from './SectionIcon'

const KOKORO_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'bf_emma', 'bm_george']

/**
 * Résumé ingest as a percentage.
 *
 * The pipeline reports which of four phases it is in, not a fraction, so these
 * are the four points the bar can honestly occupy. They are not evenly spaced
 * because the phases are not: story mining is by far the longest, so giving it
 * the widest span stops the bar sprinting to 75% and then appearing to stall.
 *
 * It deliberately never reaches 100 while running — the last step is the one
 * that writes the bundle, and a bar at 100% with work still happening is the
 * exact thing that makes people think an app has hung.
 */
const RESUME_PHASE_PCT: Record<string, number> = {
  extracting: 8,
  'mining-profile': 25,
  'mining-stories': 60,
  'gap-scan': 92
}

interface CompatProviderInfo {
  label: string
  keyField: keyof HueSettings
  modelField: keyof HueSettings
  keyPlaceholder: string
  consoleUrl: string
  /** Step-by-step instructions for obtaining an API key. */
  steps: string[]
}

// Cloud providers that share the OpenAI wire format. Each ships a short guide so
// the user can self-serve an API key. Models are detected live (never hardcoded).
const COMPAT_PROVIDERS: Record<OpenAiCompatProvider, CompatProviderInfo> = {
  google: {
    label: 'Google Gemini',
    keyField: 'googleApiKey',
    modelField: 'googleModel',
    keyPlaceholder: 'AIza…',
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    steps: [
      'Go to aistudio.google.com and sign in with your Google account.',
      'Open the "Get API key" page (link below).',
      'Click "Create API key" and choose or create a Google Cloud project.',
      'Copy the key (it starts with "AIza…") and paste it above.'
    ]
  },
  groq: {
    label: 'Groq',
    keyField: 'groqApiKey',
    modelField: 'groqModel',
    keyPlaceholder: 'gsk_…',
    consoleUrl: 'https://console.groq.com/keys',
    steps: [
      'Go to console.groq.com and create a free account.',
      'Open the "API Keys" section (link below).',
      'Click "Create API Key", give it a name, and submit.',
      'Copy the key (shown only once, starts with "gsk_…") and paste it above.'
    ]
  },
  mistral: {
    label: 'Mistral AI',
    keyField: 'mistralApiKey',
    modelField: 'mistralModel',
    keyPlaceholder: 'Your Mistral key',
    consoleUrl: 'https://console.mistral.ai/api-keys',
    steps: [
      'Go to console.mistral.ai and create an account.',
      'Open the "API Keys" page (link below).',
      'Click "Create new key" and confirm.',
      'Copy the key and paste it above.'
    ]
  },
  cohere: {
    label: 'Cohere',
    keyField: 'cohereApiKey',
    modelField: 'cohereModel',
    keyPlaceholder: 'Your Cohere key',
    consoleUrl: 'https://dashboard.cohere.com/api-keys',
    steps: [
      'Go to dashboard.cohere.com and sign up.',
      'Open the "API Keys" page (link below) — a free trial key is created for you.',
      'Copy the trial key (or create a new one) and paste it above.'
    ]
  },
  deepseek: {
    label: 'DeepSeek',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    keyPlaceholder: 'sk-…',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    steps: [
      'Go to platform.deepseek.com and create an account.',
      'Open the "API keys" page (link below).',
      'Click "Create new API key", name it, and confirm.',
      'Copy the key (shown only once, starts with "sk-…") and paste it above.',
      // The one step people skip, and the failure it causes looks nothing like
      // its cause: a correctly-created key on a zero balance returns
      // "Insufficient Balance", which reads as a broken key rather than an
      // unfunded account.
      'Add credit on the Billing page — DeepSeek has no free tier, so a new key with a zero balance returns "Insufficient Balance".'
    ]
  }
}

/**
 * Derived from `COMPAT_PROVIDERS` rather than written out.
 *
 * This used to be a hand-maintained `p === 'google' || p === 'groq' || …`
 * chain — a second copy of the list directly above it, with nothing tying the
 * two together. Adding a provider and forgetting the chain does not fail to
 * compile: the provider simply never satisfies the guard, so a correctly
 * configured account silently renders no key field at all. Reading the keys of
 * the record makes that class of bug impossible.
 */
const isCompatProvider = (p: LlmProvider): p is OpenAiCompatProvider =>
  Object.hasOwn(COMPAT_PROVIDERS, p)

// Cloud ASR providers and the settings key holding each one's credential. Only
// the selected provider's key is shown, to keep the section uncluttered. Each
// ships a short self-serve guide for obtaining an API key (mirrors COMPAT_PROVIDERS).
const CLOUD_ASR: Record<
  CloudAsrProvider,
  { label: string; keyField: keyof HueSettings; consoleUrl: string; steps: string[] }
> = {
  deepgram: {
    label: 'Deepgram Nova-3',
    keyField: 'deepgramApiKey',
    consoleUrl: 'https://console.deepgram.com',
    steps: [
      'Go to console.deepgram.com and create a free account (comes with free credit).',
      'Verify your email and sign in to the Deepgram Console.',
      'Open the "API Keys" page from the left sidebar (link below).',
      'Click "Create a New API Key", give it a name, and keep the default scopes.',
      'Copy the key (shown only once) and paste it above.'
    ]
  },
  assemblyai: {
    label: 'AssemblyAI',
    keyField: 'assemblyAiApiKey',
    consoleUrl: 'https://www.assemblyai.com/dashboard',
    steps: [
      'Go to assemblyai.com and create a free account.',
      'Verify your email and sign in to the dashboard (link below).',
      'Your API key is shown on the dashboard home under "Your API key".',
      'Copy the key and paste it above.'
    ]
  },
  groq: {
    label: 'Groq Whisper',
    keyField: 'groqApiKey',
    consoleUrl: 'https://console.groq.com/keys',
    steps: [
      'Go to console.groq.com and create a free account.',
      'Open the "API Keys" section (link below).',
      'Click "Create API Key", give it a name, and submit.',
      'Copy the key (shown only once, starts with "gsk_…") and paste it above.'
    ]
  }
}

// Friendly labels for the mouse buttons we can bind.
const MOUSE_LABELS: Record<string, string> = {
  Back: 'Mouse Back (X1)',
  Forward: 'Mouse Forward (X2)',
  Middle: 'Middle Click',
  Right: 'Right Click'
}

// Render a trigger string in a human-friendly way. Keyboard accelerators like
// "CommandOrControl+Shift+Enter" -> "Ctrl + Shift + Enter"; mouse triggers like
// "Mouse:Back" -> "Mouse Back (X1)".
function formatAccelerator(acc: string): string {
  if (!acc) return 'Not set'
  if (acc.startsWith('Mouse:')) {
    const name = acc.slice('Mouse:'.length)
    return MOUSE_LABELS[name] ?? `Mouse ${name}`
  }
  return acc
    .split('+')
    .map((p) => (p === 'CommandOrControl' ? 'Ctrl' : p === 'Return' ? 'Enter' : p))
    .join(' + ')
}

// Map a DOM MouseEvent.button to our internal trigger name. DOM numbering:
// 0=left, 1=middle, 2=right, 3=back (X1), 4=forward (X2). Left is the click that
// starts/confirms recording, so it isn't bindable.
function domButtonName(button: number): string | null {
  switch (button) {
    case 1:
      return 'Middle'
    case 2:
      return 'Right'
    case 3:
      return 'Back'
    case 4:
      return 'Forward'
    default:
      return null
  }
}

// Named keys whose accelerator token differs from the DOM KeyboardEvent.key.
const ACCEL_KEY_MAP: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Enter'
}

// Convert a keydown into an Electron accelerator, or null if it isn't usable yet
// (a lone modifier). A modifier is no longer required — single keys are allowed
// (e.g. F9), which globally captures that key from every app, so it's best kept
// to keys you don't otherwise type (function keys).
function eventToAccelerator(e: React.KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return null
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  const k = e.key
  let key: string | null = null
  if (ACCEL_KEY_MAP[k]) key = ACCEL_KEY_MAP[k]
  else if (/^[a-z]$/i.test(k)) key = k.toUpperCase()
  else if (/^[0-9]$/.test(k)) key = k
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k
  else if (k.length === 1) key = k.toUpperCase()
  if (!key) return null

  return [...mods, key].join('+')
}

// Click-to-record control for a global trigger. Captures the next key combo,
// single key, or mouse button (back/forward/middle/right) and hands back the
// trigger string ("Ctrl+Shift+Space", "F9", or "Mouse:Back").
function HotkeyRecorder({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  return (
    <button
      type="button"
      className="settings-input"
      style={{ textAlign: 'left', cursor: 'pointer' }}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onContextMenu={(e) => recording && e.preventDefault()}
      onMouseDown={(e) => {
        if (!recording) return
        // Left click (button 0) is what started recording; ignore it as a binding.
        const name = domButtonName(e.button)
        if (!name) return
        e.preventDefault()
        onChange(`Mouse:${name}`)
        setRecording(false)
      }}
      onKeyDown={(e) => {
        if (!recording) return
        e.preventDefault()
        if (e.key === 'Escape') {
          setRecording(false)
          return
        }
        const acc = eventToAccelerator(e)
        if (acc) {
          onChange(acc)
          setRecording(false)
        }
      }}
    >
      {recording ? 'Press a key or mouse button… (Esc to cancel)' : formatAccelerator(value)}
    </button>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

/**
 * "This is already added."
 *
 * A tick and a chip rather than another line of grey text. The status line
 * below these controls is transient — it says what just happened — and a user
 * returning to Settings a day later needs to know what is *loaded*, which is a
 * different question and was previously answerable only by reading prose.
 */
function AddedChip({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="added-chip">
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
      <span className="added-chip-label">{label}</span>
    </span>
  )
}

/**
 * Upload progress: a bar, a percentage, and the name of the step.
 *
 * The percentage exists because the alternative is a line of text that changes
 * every twenty seconds, which is indistinguishable from a hang for the nineteen
 * seconds in between.
 *
 * `percent` may be null when the work reports steps rather than a fraction. The
 * bar then runs indeterminate instead of inventing a number — a made-up
 * percentage that stalls at 40% is worse than no percentage, because it implies
 * a rate that is not real.
 */
function UploadProgress({
  percent,
  label
}: {
  percent: number | null
  label: string
}): React.JSX.Element {
  const known = percent !== null && Number.isFinite(percent)
  const clamped = known ? Math.max(0, Math.min(100, Math.round(percent as number))) : 0

  // A ticking count is the difference between "slow" and "hung". Without it a
  // bar sitting at 0% says nothing about whether anything is happening, which
  // is exactly the state that makes people close the app and start over.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    // Counted from mount rather than from a timestamp handed in: this component
    // exists exactly as long as the upload does, and reading the clock in the
    // caller put an impure call on a render path.
    const id = setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="upload-progress" role="status" aria-live="polite">
      <div className="upload-progress-head">
        <span className="upload-progress-label">{label}</span>
        <span className="upload-progress-pct">
          {known ? `${clamped}%` : ''}
          {elapsed > 0 && <span className="upload-progress-elapsed"> {elapsed}s</span>}
        </span>
      </div>
      <div
        className="upload-progress-track"
        role="progressbar"
        aria-valuenow={known ? clamped : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={known ? 'upload-progress-bar' : 'upload-progress-bar is-indeterminate'}
          style={known ? { width: `${clamped}%` } : undefined}
        />
      </div>
    </div>
  )
}

function EyeIcon({ off }: { off: boolean }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
      {/* The slash is the whole difference between the two states, so it has to
          read at 16px — a full-width stroke rather than a subtle mark. */}
      {off && <line x1="3" y1="21" x2="21" y2="3" />}
    </svg>
  )
}

/**
 * An API key field with a reveal toggle.
 *
 * Masked by default, because these sit in a pane a user may well have open
 * while screen-sharing — which, for this app specifically, is the normal case
 * rather than the unusual one.
 *
 * Reveal state is per-field and deliberately not persisted: it resets whenever
 * the pane is closed, so a key cannot be left visible by a decision made in a
 * previous session. Typing is what a reveal is usually for, so the toggle is
 * beside the input rather than hidden behind a menu.
 */
function SecretInput({
  value,
  onChange,
  placeholder,
  id
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  id?: string
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false)

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
      <input
        id={id}
        type={revealed ? 'text' : 'password'}
        className="settings-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        // Password managers offering to save an API key is noise, and their
        // overlay covers the reveal button.
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="icon-btn"
        onClick={() => setRevealed((r) => !r)}
        // The control is an icon, so the label is the only thing a screen
        // reader has, and the title is the only thing a mouse user gets.
        aria-label={revealed ? 'Hide API key' : 'Show API key'}
        aria-pressed={revealed}
        title={revealed ? 'Hide' : 'Show'}
        style={{
          width: 'auto',
          flex: '0 0 auto',
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)'
        }}
      >
        <EyeIcon off={revealed} />
      </button>
    </div>
  )
}

/**
 * The nine docking positions, in reading order so the array maps straight onto a
 * 3x3 CSS grid. 'free' is deliberately absent: it is not a position you aim at,
 * it is the state you fall into by dragging the window, so it gets its own
 * button rather than a tenth cell that would have nowhere sensible to sit.
 */
const ANCHOR_CELLS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
] as const satisfies readonly WindowAnchor[]

const ANCHOR_LABELS: Record<(typeof ANCHOR_CELLS)[number], string> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'center-left': 'Middle left',
  center: 'Centre',
  'center-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right'
}

export function Settings({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [s, setS] = useState<HueSettings | null>(null)
  const [saved, setSaved] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaStatus, setOllamaStatus] = useState<'idle' | 'detecting' | 'ok' | 'unreachable'>(
    'idle'
  )
  const [llmModels, setLlmModels] = useState<string[]>([])
  const [llmStatus, setLlmStatus] = useState<'idle' | 'detecting' | 'ok' | 'unreachable'>('idle')
  const [resumeStatus, setResumeStatus] = useState<string | null>(null)
  // Gap answering, previously possible only in the phone app.
  const [gapDrafts, setGapDrafts] = useState<Record<string, string>>({})
  const [gapBusy, setGapBusy] = useState<string | null>(null)
  const [gapNotes, setGapNotes] = useState<Record<string, string>>({})
  // The question on screen, as an id. See `lib/gapCursor.ts` for why an index
  // cannot work here.
  const [gapCursorId, setGapCursorId] = useState<string | null>(null)
  // Set once a file is picked; cleared once its ingest is confirmed or
  // cancelled. Holding the label here (rather than ingesting immediately on
  // pick) is what lets the user see and edit the default before it's sent.
  const [resumeProgress, setResumeProgress] = useState<number | null>(null)
  const [resumeIngesting, setResumeIngesting] = useState(false)
  // Job posting analysis, shaped exactly like the résumé trio above it:
  // a running flag, a percentage for the bar, a status line, and — separately
  // — the failure, which is rendered in red rather than in the muted style.
  const [jobAnalysing, setJobAnalysing] = useState(false)
  const [jobProgress, setJobProgress] = useState<number | null>(null)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)
  /**
   * The posting text the stored spec was built from.
   *
   * `JobSpec.sourceHash` is the authoritative answer to "is this summary still
   * about what is in the box", but it is a sha256 and the renderer has no
   * business hashing 20,000 characters on every keystroke to decide whether to
   * grey out a panel. Keeping the analysed string and comparing it is exact for
   * the case that matters — the user edited the box after analysing — and this
   * only drives a visual hint, never anything the prompt depends on.
   *
   * null means "nothing analysed in this session", which is also the state
   * after a reload: the main process writes `jobDescription` and `jobSpecJson`
   * in the same update, so a freshly loaded pair is in sync by construction and
   * must not be marked stale.
   */
  const [analysedText, setAnalysedText] = useState<string | null>(null)
  // Tracks whether unmount has already happened, so a slow ingest that finishes
  // after the pane closes can't set state on it or leave onProgress subscribed
  // into a stale closure.
  const mountedRef = useRef(true)
  // Parsed from the settings field rather than held separately, so there is one
  // source of truth and a hand-edited settings file can't put the pane and the
  // prompt builder out of step.
  // `s` is null until settings load; the pane renders a loading state then.
  const profileBundle = s ? parseProfileBundle(s.profileBundleJson) : null
  const openGaps = profileBundle ? profileBundle.gaps.filter((g) => g.status === 'open') : []
  const openGapIds = openGaps.map((g) => g.id)
  // Clamped on every render rather than in an effect: a reload or a re-ingest
  // swaps the whole bundle and the id in state can vanish with it, and doing it
  // here means the stale id is never the one that reaches the screen — no
  // second render, and no frame where the pane asks for a question that is gone.
  const currentGap = openGaps.find((g) => g.id === clampCursor(openGapIds, gapCursorId)) ?? null
  const gapPosition = currentGap ? openGaps.indexOf(currentGap) : 0
  /**
   * The counter's denominator: every gap the scan produced, not the open ones.
   *
   * Answered and skipped gaps stay in `bundle.gaps` with their status changed,
   * so this is the size of the interview and it does not move as the user works
   * through it. Counting only the open ones would turn "3 of 8" into "4 of 7"
   * and then "5 of 6" — a finish line walking towards the user, which is how a
   * short interview comes to feel endless.
   */
  const gapTotal = profileBundle ? profileBundle.gaps.length : 0
  const gapNumberShown = gapTotal - openGaps.length + gapPosition + 1
  // Same reasoning as `profileBundle`: parsed from the settings field rather
  // than mirrored into its own state, so the pane and the prompt builder read
  // the identical source.
  const jobSpec: JobSpec | null = s ? parseJobSpec(s.jobSpecJson) : null
  // The anticipated questions, and how many of them the user's own stories can
  // actually answer. The second number is the useful one: it is the difference
  // between "Hue knows what is coming" and "Hue knows what is coming and has
  // something of yours to say about it".
  const jobBrief = s ? parseJobBrief(s.jobBriefJson) : null
  const briefMatched = jobBrief?.likelyQuestions.filter((q) => q.storyId !== null).length ?? 0
  const jobSpecStale = analysedText !== null && analysedText !== (s?.jobDescription ?? '').trim()

  // Groq's free tier caps a single request at 8,000 tokens; story mining asks
  // for roughly 10,000. Resolved the same way `providerFor` does in the main
  // process — empty means "same as drafting".
  const effectiveIngestProvider = s ? s.ingestProvider || s.llmProvider : ''
  const ingestWillExceedQuota = effectiveIngestProvider === 'groq'
  const fileInputRef = useRef<HTMLInputElement>(null)
  const detectSeq = useRef(0)
  const llmDetectSeq = useRef(0)

  /**
   * The settings as last *persisted*, which is what unsaved-ness is measured
   * against. Every path that writes through main and then syncs the local copy
   * must call `markPersisted`, or the close guard reports changes that are
   * already on disk.
   */
  const pristine = useRef<HueSettings | null>(null)
  const markPersisted = (next: HueSettings): void => {
    pristine.current = next
    setS(next)
  }
  /**
   * Apply fields the main process has *already* written to disk.
   *
   * Patches the form and the pristine copy together, so the change is visible
   * without reading as unsaved. Deliberately a patch rather than a whole object:
   * assigning the whole thing would drop every unsaved edit still open in the
   * drawer, which is the trap the job-spec and cue-sheet handlers already
   * document.
   */
  const markFieldsPersisted = (patch: Partial<HueSettings>): void => {
    setS((prev) => (prev ? { ...prev, ...patch } : prev))
    if (pristine.current) pristine.current = { ...pristine.current, ...patch }
  }
  /** Set when a close was requested while there was unsaved work. */
  const [closePending, setClosePending] = useState(false)

  useEffect(() => {
    window.hue.settings.get().then(markPersisted)
    void window.hue.version().then(setAppVersion)
  }, [])

  useEffect(() => {
    // Re-arm on every mount, not just the first.
    //
    // `mountedRef` is initialised to `true` and set to `false` on cleanup, and
    // nothing used to set it back. Under StrictMode an effect runs mount →
    // cleanup → mount, so from the second run onward the ref was permanently
    // false and every `if (mountedRef.current)` guard silently dropped its
    // update — visibly, upload progress sat frozen at 0% while the ingest ran
    // to completion behind it. An upload that works but cannot report is
    // indistinguishable from one that hung.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Job posting analysis progress.
  //
  // Subscribed for the life of the pane rather than armed per click, unlike the
  // résumé ingest: that one closes over the picked filename to write its status
  // line, so it can only be subscribed once the file is known. These phases
  // describe themselves, so there is nothing to close over and one subscription
  // with one cleanup is the simpler shape. The mounted guard is the same guard
  // the cue-sheet subscription uses, for the same reason — an analysis outlives
  // a pane the user closes mid-run.
  useEffect(() => {
    const stop = window.hue.jobSpec.onProgress((p) => {
      if (!mountedRef.current) return
      setJobProgress(Number.isFinite(p.pct) ? p.pct : null)
      setJobStatus(p.phase)
    })
    return stop
  }, [])

  // Phone mirror: the toggle takes effect immediately (no Save needed) so the QR
  // code shows up the moment it's enabled.
  const [phone, setPhone] = useState<PhoneMirrorStatus | null>(null)
  const [phoneQr, setPhoneQr] = useState('')
  const [phoneBusy, setPhoneBusy] = useState(false)

  useEffect(() => {
    window.hue.phone.status().then(setPhone)
  }, [])

  // Render the connect URL as a QR data-URL whenever it changes.
  useEffect(() => {
    const url = phone?.url
    let stale = false
    const apply = (dataUrl: string): void => {
      if (!stale) setPhoneQr(dataUrl)
    }
    if (url) {
      void QRCode.toDataURL(url, { width: 320, margin: 2 }).then(apply, () => apply(''))
    } else {
      void Promise.resolve().then(() => apply(''))
    }
    return () => {
      stale = true
    }
  }, [phone?.url])

  const togglePhone = async (): Promise<void> => {
    if (!phone) return
    setPhoneBusy(true)
    try {
      const status = await window.hue.phone.setEnabled(!phone.running)
      setPhone(status)
      // Keep the form's copy of the setting in sync (it persists on Save too).
      markFieldsPersisted({ phoneMirrorEnabled: status.running })
    } finally {
      setPhoneBusy(false)
    }
  }

  // Stealth: mirrors togglePhone — the switch has an effect on the window, not
  // just on the stored form, so it must apply the moment it's clicked. Waiting
  // for Save would leave the user visible in a share they thought they'd left.
  const [stealth, setStealth] = useState<StealthStatus | null>(null)
  const [stealthBusy, setStealthBusy] = useState(false)

  useEffect(() => {
    window.hue.stealth.getStealthStatus().then(setStealth)
  }, [])

  const toggleStealth = async (): Promise<void> => {
    if (!stealth) return
    setStealthBusy(true)
    try {
      // settings.set applies the flag to this window as it persists it, so one
      // round-trip both saves and takes effect; the status re-read then reports
      // what the platform actually delivered.
      await window.hue.settings.set({ stealthMode: !stealth.enabled })
      const status = await window.hue.stealth.getStealthStatus()
      setStealth(status)
      // Keep the form's copy of the setting in sync (it persists on Save too).
      markFieldsPersisted({ stealthMode: status.enabled })
    } finally {
      setStealthBusy(false)
    }
  }

  // Relay (phone app over the internet): like the phone mirror, the button takes
  // effect immediately so the pairing QR appears without a Save round-trip.
  const [relay, setRelay] = useState<RelayStatus | null>(null)
  const [relayQr, setRelayQr] = useState('')
  const [relayBusy, setRelayBusy] = useState(false)

  useEffect(() => {
    window.hue.relay.status().then(setRelay)
  }, [])

  // Render the pairing URI as a QR data-URL whenever it changes.
  useEffect(() => {
    const uri = relay?.pairingUri
    let stale = false
    const apply = (dataUrl: string): void => {
      if (!stale) setRelayQr(dataUrl)
    }
    if (uri) {
      void QRCode.toDataURL(uri, { width: 320, margin: 2 }).then(apply, () => apply(''))
    } else {
      void Promise.resolve().then(() => apply(''))
    }
    return () => {
      stale = true
    }
  }, [relay?.pairingUri])

  const toggleRelay = async (): Promise<void> => {
    if (!relay) return
    setRelayBusy(true)
    try {
      // The main process registers the room against the *saved* relay URL, so
      // persist whatever is in the field before connecting.
      if (!relay.running && s) await window.hue.settings.set({ relayBaseUrl: s.relayBaseUrl })
      const status = await window.hue.relay.setEnabled(!relay.running)
      setRelay(status)
      // Keep the form's copy of the setting in sync (it persists on Save too).
      markFieldsPersisted({ relayEnabled: status.running })
    } finally {
      setRelayBusy(false)
    }
  }

  // Auto-detect the models installed on the local Ollama server. Re-runnable from
  // the "Detect models" button; the sequence counter stops a slow/stale request
  // from clobbering a newer one (e.g. while the server URL is being edited).
  const detectOllama = useCallback(async (baseUrl: string): Promise<void> => {
    const seq = ++detectSeq.current
    setOllamaStatus('detecting')
    const models = baseUrl ? await window.hue.ollama.models(baseUrl) : []
    if (seq !== detectSeq.current) return
    setOllamaModels(models)
    setOllamaStatus(models.length > 0 ? 'ok' : 'unreachable')
    if (models.length === 0) return
    // Snap the configured model to one that's actually installed.
    setS((prev) => {
      if (!prev || models.includes(prev.ollamaModel)) return prev
      const base = prev.ollamaModel.split(':')[0]
      return { ...prev, ollamaModel: models.find((m) => m.split(':')[0] === base) ?? models[0] }
    })
  }, [])

  // Fetch the models a cloud (OpenAI-compatible) provider exposes, given the key
  // currently typed in the form. Mirrors detectOllama's sequence-guard so a slow
  // request can't clobber a newer one.
  const detectLlmModels = useCallback(
    async (compat: OpenAiCompatProvider, apiKey: string): Promise<void> => {
      const seq = ++llmDetectSeq.current
      setLlmStatus('detecting')
      const models = apiKey ? await window.hue.llm.models(compat, apiKey) : []
      if (seq !== llmDetectSeq.current) return
      setLlmModels(models)
      setLlmStatus(models.length > 0 ? 'ok' : 'unreachable')
      if (models.length === 0) return
      const field = COMPAT_PROVIDERS[compat].modelField
      setS((prev) => {
        if (!prev || models.includes(prev[field] as string)) return prev
        return { ...prev, [field]: models[0] } as HueSettings
      })
    },
    []
  )

  const provider = s?.llmProvider
  const ollamaBaseUrl = s?.ollamaBaseUrl
  useEffect(() => {
    // Reacting to a provider/URL change by kicking off async detection. detectOllama
    // sets 'detecting' synchronously for instant feedback; that's intentional here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (provider === 'ollama') void detectOllama(ollamaBaseUrl ?? '')
  }, [provider, ollamaBaseUrl, detectOllama])

  if (!s) {
    return (
      <div
        className={open ? 'drawer-overlay' : 'drawer-overlay drawer-overlay--hidden'}
        onClick={onClose}
      >
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-header">
            <h2>Settings</h2>
            <span className="drawer-version">{appVersion ? `v${appVersion}` : ''}</span>
            <button className="icon-btn" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          <div className="drawer-body" style={{ alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</span>
          </div>
        </div>
      </div>
    )
  }

  const set = <K extends keyof HueSettings>(key: K, value: HueSettings[K]): void =>
    setS({ ...s, [key]: value })

  // Setter for the dynamically-chosen compat-provider string fields (key/model),
  // where the field name isn't known statically.
  const setStr = (key: keyof HueSettings, value: string): void =>
    setS({ ...s, [key]: value } as HueSettings)

  // Derive the active compat-provider config in render scope (not a closure), so
  // the JSX below can stay an inline ternary instead of a render-time IIFE.
  const compat: OpenAiCompatProvider | null = isCompatProvider(s.llmProvider) ? s.llmProvider : null
  const cfg = compat ? COMPAT_PROVIDERS[compat] : null
  const apiKey = cfg ? (s[cfg.keyField] as string) : ''

  /**
   * Whether a provider is usable right now — i.e. it has the credential it
   * needs. Ollama is the exception on purpose: a local server has no key, and
   * demanding a placeholder would make the offline path the only one that
   * looks unconfigured.
   */
  const providerReady = (p: LlmProvider): boolean => {
    if (p === 'ollama') return true
    if (p === 'anthropic') return s.anthropicApiKey.trim().length > 0
    return (s[COMPAT_PROVIDERS[p].keyField] as string).trim().length > 0
  }

  // Mirrors `providerFor` in the main process: empty means "same as drafting".
  const ingestResolved: LlmProvider = s.ingestProvider || s.llmProvider

  const setupSteps: { title: string; detail: string; done: boolean }[] = [
    {
      title: 'Add a key for the provider that drafts answers',
      detail:
        s.llmProvider === 'ollama'
          ? 'Ollama runs locally and needs no key — make sure it is running and the model name below matches one you have pulled.'
          : `Pick a provider under Assistant and paste its API key. There are step-by-step instructions under the key field.`,
      done: providerReady(s.llmProvider)
    },
    {
      title: 'Choose a provider that can read a whole résumé',
      detail:
        ingestResolved === 'groq'
          ? 'Ingest is currently set to Groq, which cannot finish it: reading a résumé needs about 10,000 tokens in one request and Groq’s free tier caps that at 8,000. Set Ingest provider to Google or Ollama. Drafting can stay on Groq.'
          : 'Set an Ingest provider and give it a key. Ingest sends a whole document at once, so it needs more headroom per request than drafting does.',
      done: ingestResolved !== 'groq' && providerReady(ingestResolved)
    },
    {
      title: 'Upload your résumé',
      detail:
        'Under Your background. Hue turns it into a story bank and checks every claim against the document, so it can only cite things you actually wrote.',
      done: profileBundle !== null
    },
    {
      title: 'Answer the gap questions',
      detail:
        profileBundle === null
          ? 'Appears once your résumé has been read — the questions are generated from what it does not cover.'
          : 'They cover what a résumé cannot show. Answering them — or saying you have no story — is what stops Hue inventing one under pressure.',
      // Ticked only when genuinely finished. This used to count as done while
      // there was no résumé, on the reasoning that it was blocked by the step
      // above and two open items for one cause reads as twice the work. Seen on
      // screen that was worse: a tick sat above an unticked step, claiming
      // credit for something the user had never done.
      done: profileBundle !== null && openGaps.length === 0
    }
  ]
  const modelVal = cfg ? (s[cfg.modelField] as string) : ''

  const save = async (): Promise<void> => {
    const next = await window.hue.settings.set(s)
    markPersisted(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  /**
   * Closing, via any route: the X, the backdrop.
   *
   * Intercepted rather than forbidden. Losing a typed API key or a gap answer to
   * a stray backdrop click is the failure this exists to stop; trapping the user
   * in the pane until they manually undo an experiment would be a worse one.
   */
  const requestClose = (): void => {
    if (pristine.current && isSettingsDirty(s, pristine.current, gapDrafts)) {
      setClosePending(true)
      return
    }
    onClose()
  }

  const saveAndClose = async (): Promise<void> => {
    await save()
    setClosePending(false)
    onClose()
  }

  const discardAndClose = (): void => {
    // Back to what is on disk, and drop the unsent drafts with it — leaving them
    // would resurrect the prompt the moment the pane is reopened.
    if (pristine.current) setS(pristine.current)
    setGapDrafts({})
    setClosePending(false)
    onClose()
  }

  /**
   * Uploads the resume to hue-ingest and stores the structured bundle.
   *
   * Replaces the old flow — parse locally, then ask the LLM to tidy the prose —
   * because tidy prose was never the problem. A summary cannot tell the model
   * which stories the candidate actually has, so asked for a failure story by a
   * resume that contains none, its only option was to invent one. The bundle
   * enumerates what exists, and the gap scan collects what doesn't.
   */
  const onResumeFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return

    setResumeIngesting(true)
    setResumeProgress(RESUME_PHASE_PCT.extracting)
    setResumeStatus(`Reading ${file.name}…`)
    // Subscribed before the call, not after: ingest takes about a minute, and
    // the first progress event fires immediately.
    const stopProgress = window.hue.profile.onProgress((p) => {
      // A step count, not a rate. Résumé ingest reports which of four phases it
      // is in and nothing finer, so the bar advances in four jumps — honest
      // about being coarse, rather than a smooth animation implying a
      // measurement nobody is taking.
      setResumeProgress(RESUME_PHASE_PCT[p.phase] ?? null)
      setResumeStatus(
        p.phase === 'extracting'
          ? `Reading ${file.name}…`
          : p.phase === 'mining-profile'
            ? 'Pulling out your roles and dates…'
            : p.phase === 'mining-stories'
              ? `Building your story bank… ${p.elapsedSeconds}s`
              : `Looking for gaps… ${p.elapsedSeconds}s`
      )
    })

    try {
      const outcome = await window.hue.profile.ingest(await file.arrayBuffer())
      if (outcome.ok) {
        // The main process already persisted it; mirror it into the local form
        // state so the pane updates without a reload.
        markFieldsPersisted({ profileBundleJson: JSON.stringify(outcome.bundle) })
        setResumeStatus(`Ready — ${describeBundle(outcome.bundle)}.`)
      } else {
        setResumeStatus(outcome.message)
      }
    } catch (err) {
      setResumeStatus(err instanceof Error ? err.message : String(err))
    } finally {
      stopProgress()
      setResumeIngesting(false)
      setResumeProgress(null)
    }
  }

  /**
   * Sends the pasted posting off to be structured.
   *
   * The posting is worth something even un-analysed — the prompt builder falls
   * back to the raw text — so this is an upgrade rather than a gate, and a
   * failure here leaves the user exactly where they were rather than losing
   * what they pasted.
   */
  const onAnalyseJob = async (): Promise<void> => {
    const text = s.jobDescription.trim()
    if (!text || jobAnalysing) return

    setJobAnalysing(true)
    setJobError(null)
    setJobProgress(0)
    setJobStatus('Reading the posting…')
    try {
      const spec = await window.hue.jobSpec.analyze(text)
      // The main process has already persisted the spec beside the posting;
      // mirroring it into the form is what makes the summary appear without a
      // reload, exactly as the résumé ingest does with its bundle.
      set('jobSpecJson', JSON.stringify(spec))
      setAnalysedText(text)
    } catch (err) {
      setJobError(err instanceof Error ? err.message : String(err))
    } finally {
      setJobAnalysing(false)
      setJobProgress(null)
      setJobStatus(null)
    }
  }

  const onClearJobSpec = async (): Promise<void> => {
    await window.hue.jobSpec.clear()
    // Only the two fields it cleared are taken off the persisted object —
    // assigning the whole thing would drop every unsaved edit open in the
    // drawer, the same trap the cue-sheet handlers below document.
    markFieldsPersisted({ jobDescription: '', jobSpecJson: '' })
    setAnalysedText(null)
    setJobError(null)
    setJobStatus(null)
  }

  const onDeleteProfile = async (): Promise<void> => {
    await window.hue.profile.delete()
    markFieldsPersisted({ profileBundleJson: '' })
    setResumeStatus('Profile deleted.')
  }

  const onRefreshProfile = async (): Promise<void> => {
    setResumeStatus('Reloading…')
    const outcome = await window.hue.profile.refresh()
    if (outcome.ok) {
      markFieldsPersisted({ profileBundleJson: JSON.stringify(outcome.bundle) })
      setResumeStatus(`Reloaded — ${describeBundle(outcome.bundle)}.`)
    } else {
      setResumeStatus(outcome.message)
    }
  }

  const onAnswerGap = async (gapId: string): Promise<void> => {
    const text = (gapDrafts[gapId] ?? '').trim()
    if (!text) return
    // Captured before the await. The list the call returns no longer contains
    // the answered gap, so it has lost the position the cursor needs to walk
    // forward from — only the pre-call list knows what came next.
    const openBefore = openGaps.map((g) => g.id)
    setGapBusy(gapId)
    try {
      const outcome = await window.hue.profile.answerGap(gapId, text)
      if (!outcome.ok) {
        setGapNotes((n) => ({ ...n, [gapId]: outcome.message }))
        return
      }
      markFieldsPersisted({ profileBundleJson: JSON.stringify(outcome.bundle) })
      // Routed through `nextAfterAnswered` even when the answer was rejected:
      // a rejected gap is still open, so this returns the same id and the
      // question the "we couldn't use that" note refers to stays on screen.
      const openAfter = outcome.bundle.gaps.filter((g) => g.status === 'open').map((g) => g.id)
      setGapCursorId(nextAfterAnswered(openBefore, gapId, openAfter))
      if (outcome.accepted) {
        setGapDrafts((d) => ({ ...d, [gapId]: '' }))
        setGapNotes((n) => ({ ...n, [gapId]: '' }))
      } else {
        // On topic, but no story in it. Saying so is the difference between a
        // user who edits their answer and one who assumes the feature is broken.
        setGapNotes((n) => ({
          ...n,
          [gapId]: outcome.reason ?? 'That answer did not contain a story we could use.'
        }))
      }
    } finally {
      setGapBusy(null)
    }
  }

  const onSkipGap = async (gapId: string): Promise<void> => {
    const openBefore = openGaps.map((g) => g.id)
    setGapBusy(gapId)
    try {
      const bundle = await window.hue.profile.skipGap(gapId)
      markFieldsPersisted({ profileBundleJson: JSON.stringify(bundle) })
      const openAfter = bundle.gaps.filter((g) => g.status === 'open').map((g) => g.id)
      setGapCursorId(nextAfterAnswered(openBefore, gapId, openAfter))
    } finally {
      setGapBusy(null)
    }
  }

  /**
   * The single forward control.
   *
   * Typing an answer and then hunting for a separate "Save" is how answers get
   * lost — the user has already said what they came to say, and Next is where
   * their hand is. So Next saves when there is something to save and is plain
   * navigation when there isn't; `onAnswerGap` moves the cursor itself on
   * success, which is also what keeps a rejected answer from scrolling away.
   */
  const onNextGap = (gapId: string): void => {
    if ((gapDrafts[gapId] ?? '').trim()) {
      void onAnswerGap(gapId)
      return
    }
    setGapCursorId(stepCursor(openGapIds, gapId, 1))
  }

  // Derives the default label from a filename by stripping its extension —
  // shared by the initial pick (to pre-fill the editable field) and the
  // confirm step (as the fallback when the field is left blank).
  return (
    <div
      className={open ? 'drawer-overlay' : 'drawer-overlay drawer-overlay--hidden'}
      onClick={requestClose}
    >
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>Settings</h2>
          <span className="drawer-version">{appVersion ? `v${appVersion}` : ''}</span>
          <button className="icon-btn" onClick={requestClose}>
            <CloseIcon />
          </button>
        </div>

        {closePending && (
          // In-app rather than window.confirm: a native dialog blocks the whole
          // renderer in Electron, which would freeze the pane it is asking about.
          <div className="unsaved-guard" role="alertdialog" aria-label="Unsaved changes">
            <div className="unsaved-guard-body">
              <strong>You have unsaved changes.</strong>
              <span>
                Closing now would discard them, including any answer you have typed but not sent.
              </span>
              <div className="unsaved-guard-actions">
                <button type="button" className="icon-btn" onClick={() => void saveAndClose()}>
                  Save and close
                </button>
                <button type="button" className="link-btn" onClick={discardAndClose}>
                  Discard and close
                </button>
                <button type="button" className="link-btn" onClick={() => setClosePending(false)}>
                  Keep editing
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="drawer-body">
          {/*
            Setup, as a checklist that knows where you are.

            Static instructions would sit at the top being ignored once they no
            longer applied. These read live state, so a finished step visibly
            drops out of the way and the one thing left to do is the one thing
            highlighted — which is what someone setting this up an hour before an
            interview actually needs.
          */}
          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="setup" />
              Setup
            </div>
            <ol className="setup-list">
              {setupSteps.map((step) => (
                <li
                  key={step.title}
                  className={`setup-step${step.done ? ' setup-step--done' : ''}`}
                >
                  <span className="setup-mark" aria-hidden="true">
                    {step.done ? '✓' : ''}
                  </span>
                  <div className="setup-body">
                    <div className="setup-title">{step.title}</div>
                    {!step.done && <div className="setup-detail">{step.detail}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {setupSteps.every((step) => step.done) ? (
              <div className="setup-done-note">
                Everything is set up. Close Settings and start a session.
              </div>
            ) : (
              <div className="setup-done-note">
                Steps tick themselves off as you finish them. Nothing below is required to start a
                session — Hue works without a résumé, it just has less of your own material to draw
                on.
              </div>
            )}
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="assistant" />
              Assistant
            </div>
            <div className="settings-field">
              <label className="settings-label">Provider</label>
              <select
                className="settings-input"
                value={s.llmProvider}
                onChange={(e) => {
                  set('llmProvider', e.target.value as LlmProvider)
                  // Reset detected-model state so it doesn't leak across providers.
                  setLlmModels([])
                  setLlmStatus('idle')
                }}
              >
                <option value="anthropic">Anthropic Claude (cloud)</option>
                <option value="google">Google Gemini (cloud)</option>
                <option value="groq">Groq (cloud, fast)</option>
                <option value="mistral">Mistral AI (cloud)</option>
                <option value="cohere">Cohere (cloud)</option>
                <option value="deepseek">DeepSeek (cloud)</option>
                <option value="ollama">Ollama (local)</option>
              </select>
            </div>

            {s.llmProvider === 'anthropic' ? (
              <>
                <div className="settings-field">
                  <label className="settings-label">Anthropic API key</label>
                  <SecretInput
                    value={s.anthropicApiKey}
                    onChange={(next) => set('anthropicApiKey', next)}
                    placeholder="sk-ant-…"
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-label">Model</label>
                  <input
                    className="settings-input"
                    value={s.model}
                    onChange={(e) => set('model', e.target.value)}
                  />
                </div>
              </>
            ) : compat && cfg ? (
              <>
                <div className="settings-field">
                  <label className="settings-label">{cfg.label} API key</label>
                  <SecretInput
                    value={apiKey}
                    onChange={(next) => setStr(cfg.keyField, next)}
                    placeholder={cfg.keyPlaceholder}
                  />
                  <details style={{ marginTop: 6 }}>
                    <summary
                      style={{ color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}
                    >
                      How do I get a {cfg.label} API key?
                    </summary>
                    <ol
                      style={{
                        color: 'var(--text-muted)',
                        fontSize: 12,
                        margin: '6px 0 0',
                        paddingLeft: 18,
                        lineHeight: 1.5
                      }}
                    >
                      {cfg.steps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                    <a
                      href={cfg.consoleUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12, display: 'inline-block', marginTop: 4 }}
                    >
                      {cfg.consoleUrl}
                    </a>
                  </details>
                </div>
                <div className="settings-field">
                  <label className="settings-label">Model</label>
                  {llmModels.length > 0 ? (
                    <select
                      className="settings-input"
                      value={modelVal}
                      onChange={(e) => setStr(cfg.modelField, e.target.value)}
                    >
                      {modelVal && !llmModels.includes(modelVal) && (
                        <option value={modelVal}>{modelVal} (custom)</option>
                      )}
                      {llmModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="settings-input"
                      value={modelVal}
                      onChange={(e) => setStr(cfg.modelField, e.target.value)}
                      placeholder="Detect models, or type a model name"
                    />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }}
                      onClick={() => detectLlmModels(compat, apiKey)}
                      disabled={llmStatus === 'detecting' || !apiKey}
                    >
                      {llmStatus === 'detecting' ? 'Detecting…' : 'Detect models'}
                    </button>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {llmStatus === 'detecting'
                        ? 'Fetching available models…'
                        : llmStatus === 'ok'
                          ? `${llmModels.length} model(s) available.`
                          : llmStatus === 'unreachable'
                            ? 'Could not list models — check the key, or type a model name.'
                            : 'Enter your key, then detect the available models.'}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="settings-field">
                  <label className="settings-label">Ollama server URL</label>
                  <input
                    className="settings-input"
                    value={s.ollamaBaseUrl}
                    onChange={(e) => set('ollamaBaseUrl', e.target.value)}
                    placeholder="http://localhost:11434"
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-label">Model</label>
                  {ollamaModels.length > 0 ? (
                    <select
                      className="settings-input"
                      value={s.ollamaModel}
                      onChange={(e) => set('ollamaModel', e.target.value)}
                    >
                      {!ollamaModels.includes(s.ollamaModel) && (
                        <option value={s.ollamaModel}>{s.ollamaModel} (not installed)</option>
                      )}
                      {ollamaModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="settings-input"
                      value={s.ollamaModel}
                      onChange={(e) => set('ollamaModel', e.target.value)}
                      placeholder="llama3.2"
                    />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }}
                      onClick={() => detectOllama(s.ollamaBaseUrl)}
                      disabled={ollamaStatus === 'detecting'}
                    >
                      {ollamaStatus === 'detecting' ? 'Detecting…' : 'Detect models'}
                    </button>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      {ollamaStatus === 'detecting'
                        ? 'Scanning Ollama server…'
                        : ollamaStatus === 'ok'
                          ? `${ollamaModels.length} model(s) detected.`
                          : ollamaStatus === 'unreachable'
                            ? 'No Ollama server found — is it running? You can also type a model name manually.'
                            : ''}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="mode" />
              Mode
            </div>
            <div className="settings-field">
              <label className="settings-label">Hue&apos;s role</label>
              <select
                className="settings-input"
                value={s.hueMode}
                onChange={(e) => set('hueMode', e.target.value as HueMode)}
              >
                <option value="companion">Companion — help me answer the interviewer</option>
                <option value="interviewer">Interviewer — ask me questions (practice)</option>
              </select>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                {s.hueMode === 'companion'
                  ? 'Hue treats incoming speech as the interviewer’s question and shows a suggested answer as text (it stays silent so it never talks over you).'
                  : 'Hue conducts a mock interview, asking you questions out loud and waiting for your answers.'}
              </span>
            </div>
            <div className="settings-field">
              <label className="settings-label">Listen to</label>
              <select
                className="settings-input"
                value={s.audioSource}
                onChange={(e) => set('audioSource', e.target.value as AudioSource)}
              >
                <option value="microphone">My microphone</option>
                <option value="system">System / call audio (loopback)</option>
              </select>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                {s.audioSource === 'system'
                  ? 'Captures the audio coming out of your speakers — e.g. the interviewer on a Zoom/Meet call. Supported on Windows; you may be asked to pick a screen to share.'
                  : 'Captures your microphone. In Companion mode, speak or relay the interviewer’s question for Hue to answer.'}
              </span>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="phone-mirror" />
              Phone mirror — opens a web page
            </div>
            <div className="settings-field">
              <label className="settings-label">Mirror the session to your phone</label>
              <button
                type="button"
                className="icon-btn"
                style={{
                  alignSelf: 'flex-start',
                  width: 'auto',
                  padding: '6px 12px',
                  fontSize: 13
                }}
                onClick={() => void togglePhone()}
                disabled={phoneBusy || !phone}
              >
                {phoneBusy
                  ? 'Working…'
                  : phone?.running
                    ? 'Disable phone mirror'
                    : 'Enable phone mirror'}
              </button>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Streams the interviewer’s question and Hue’s suggested answer to your phone’s
                browser over your Wi-Fi — nothing leaves your network. Takes effect immediately.
              </span>
              {phone?.running && (
                <>
                  {phoneQr && (
                    <img
                      src={phoneQr}
                      alt="QR code — scan with your phone to open Hue's mirror page"
                      style={{
                        width: 160,
                        height: 160,
                        borderRadius: 8,
                        marginTop: 10,
                        alignSelf: 'flex-start'
                      }}
                    />
                  )}
                  <span
                    style={{
                      fontSize: 12,
                      marginTop: 8,
                      userSelect: 'text',
                      wordBreak: 'break-all'
                    }}
                  >
                    {phone.url}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                    Scan with your phone’s <strong>browser</strong> (same Wi-Fi as this PC) and keep
                    the page open. Not for the Hue app — that’s the “Phone app” code below. The link
                    changes each time Hue restarts, so re-scan if the phone says “reconnecting”.
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="phone-app" />
              Phone app — scan this one in Hue
            </div>
            <div className="settings-field">
              <label className="settings-label">Relay URL</label>
              <input
                className="settings-input"
                type="text"
                value={s.relayBaseUrl}
                placeholder="https://relay.hue.app"
                onChange={(e) => set('relayBaseUrl', e.target.value)}
              />
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Where the Hue relay is running. Changing this takes effect the next time you connect
                the phone app below.
              </span>
            </div>
            <div className="settings-field">
              <label className="settings-label">Mirror the session to the Hue phone app</label>
              <button
                type="button"
                className="icon-btn"
                style={{
                  alignSelf: 'flex-start',
                  width: 'auto',
                  padding: '6px 12px',
                  fontSize: 13
                }}
                onClick={() => void toggleRelay()}
                disabled={relayBusy || !relay}
              >
                {relayBusy
                  ? 'Working…'
                  : relay?.running
                    ? 'Disconnect phone app'
                    : 'Connect phone app'}
              </button>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Streams the interviewer’s question and Hue’s suggested answer to the Hue app on your
                phone. Unlike the phone mirror above this works on mobile data — the transcript
                passes through the relay you configured.
              </span>
              {relay?.error && (
                <span style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>
                  {relay.error}
                </span>
              )}
              {relay?.running && (
                <>
                  {relayQr && (
                    <img
                      src={relayQr}
                      alt="QR code — scan with the Hue app to pair your phone"
                      style={{
                        width: 160,
                        height: 160,
                        borderRadius: 8,
                        marginTop: 10,
                        alignSelf: 'flex-start'
                      }}
                    />
                  )}
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                    Scan with the Hue app. The pairing changes every time Hue restarts — re-scan if
                    the phone says “disconnected”.
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="shortcuts" />
              Shortcuts
            </div>
            <div className="settings-field">
              <label className="settings-label">Summon Hue (show window)</label>
              <HotkeyRecorder value={s.summonHotkey} onChange={(v) => set('summonHotkey', v)} />
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Brings Hue to the front from any app. Click, then press a key combo, a single key
                (e.g. F9), or a mouse button — the Back/Forward side buttons work great.
              </span>
            </div>
            <div className="settings-field">
              <label className="settings-label">Start / stop session</label>
              <HotkeyRecorder
                value={s.startSessionHotkey}
                onChange={(v) => set('startSessionHotkey', v)}
              />
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Works globally — even during a call — to start or stop a session. Click, then press
                a key combo, a single key, or a mouse button (Back/Forward, etc.).
              </span>
            </div>
            <div className="settings-field">
              <label className="settings-label">Capture screen</label>
              <HotkeyRecorder
                value={s.captureScreenHotkey}
                onChange={(v) => set('captureScreenHotkey', v)}
              />
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                During a session, snapshots your screen and asks Hue about it — handy when the
                interviewer shares a coding prompt. Hue hides itself for the shot; the image is sent
                only to your configured AI provider and never saved to disk.
              </span>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="interview" />
              Interview context
            </div>
            <div className="settings-field">
              <label className="settings-label">Job title</label>
              <input
                className="settings-input"
                value={s.jobTitle}
                onChange={(e) => set('jobTitle', e.target.value)}
                placeholder="Senior Frontend Engineer"
              />
            </div>
            {/*
              The posting itself, directly under the one-line title it replaces
              the guesswork of. A job title tells Hue almost nothing — two
              postings with the same title measure completely different things —
              so this is the field that decides whether an answer is aimed at
              this employer or at the average one.
            */}
            <div className="settings-field">
              <label className="settings-label">Job description</label>
              <textarea
                className="settings-input"
                rows={8}
                maxLength={JOB_DESCRIPTION_LIMIT}
                value={s.jobDescription}
                onChange={(e) => set('jobDescription', e.target.value)}
                placeholder="Paste the job posting here — the full text, responsibilities and requirements included."
              />
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Hue uses this to answer the way <em>this</em> employer is measuring — weighting your
                own stories toward what the posting actually asks for. It never claims a skill from
                the posting that isn’t already in your résumé: where the two don’t meet, it gives
                you an honest bridge instead of a sentence you’d have to defend.
              </span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginTop: 8,
                  flexWrap: 'wrap'
                }}
              >
                <button
                  type="button"
                  className="icon-btn"
                  style={{
                    alignSelf: 'flex-start',
                    width: 'auto',
                    padding: '6px 12px',
                    fontSize: 13
                  }}
                  onClick={() => void onAnalyseJob()}
                  disabled={jobAnalysing || !s.jobDescription.trim()}
                >
                  {jobSpec ? 'Re-analyse' : 'Analyse posting'}
                </button>
                {(jobSpec || s.jobDescription) && !jobAnalysing && (
                  <button type="button" className="link-btn" onClick={() => void onClearJobSpec()}>
                    Clear
                  </button>
                )}
              </div>
              {jobAnalysing ? (
                <UploadProgress percent={jobProgress} label={jobStatus ?? 'Working…'} />
              ) : (
                <>
                  {jobError && (
                    <span style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>
                      {jobError}
                    </span>
                  )}
                  {jobSpec && (
                    // Dimmed and marked when the box no longer holds the text
                    // this was built from. Reading a confident summary of a
                    // posting you have since replaced is worse than reading no
                    // summary, because nothing on screen says it is out of date.
                    <div style={{ marginTop: 10, opacity: jobSpecStale ? 0.55 : 1 }}>
                      <AddedChip label={describeJobSpec(jobSpec)} />
                      {jobSpecStale && (
                        <span
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: 12,
                            marginLeft: 8
                          }}
                        >
                          edited since analysis — re-analyse to update
                        </span>
                      )}
                      {jobSpec.mustHaves.length > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                            What they say they require
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: 6,
                              marginTop: 6
                            }}
                          >
                            {/*
                              Capped, because a posting can list a dozen and this
                              panel is a confirmation that the right document was
                              read, not the document itself. Only `text` is ever
                              shown: `evidence` is the verbatim span the
                              verifier uses to prove a requirement came from the
                              posting, and it is provenance, not copy.
                            */}
                            {jobSpec.mustHaves.slice(0, 10).map((req) => (
                              <span
                                key={req.id}
                                style={{
                                  border: '1px solid var(--border)',
                                  borderRadius: 999,
                                  padding: '3px 9px',
                                  fontSize: 12
                                }}
                              >
                                {req.text}
                              </span>
                            ))}
                            {jobSpec.mustHaves.length > 10 && (
                              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                                +{jobSpec.mustHaves.length - 10} more
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                      {jobBrief && jobBrief.likelyQuestions.length > 0 && (
                        <div style={{ marginTop: 10, color: 'var(--text-muted)', fontSize: 12 }}>
                          {jobBrief.likelyQuestions.length} anticipated question
                          {jobBrief.likelyQuestions.length === 1 ? '' : 's'}, {briefMatched} matched
                          to your stories. Hue carries these into every answer.
                        </div>
                      )}
                      {jobSpec.likelyQuestions.length > 0 && (
                        // Collapsed: useful to skim before a call, and noise
                        // while you are still setting the pane up.
                        <details style={{ marginTop: 10 }}>
                          <summary
                            style={{ color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}
                          >
                            Questions they’re likely to ask
                          </summary>
                          <ul
                            style={{
                              color: 'var(--text-muted)',
                              fontSize: 12,
                              margin: '6px 0 0',
                              paddingLeft: 18,
                              lineHeight: 1.5
                            }}
                          >
                            {jobSpec.likelyQuestions.map((q) => (
                              <li key={q}>{q}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="settings-field">
              <label className="settings-label">Mode</label>
              <select
                className="settings-input"
                value={s.interviewMode}
                onChange={(e) => set('interviewMode', e.target.value as InterviewMode)}
              >
                <option value="practice">Practice (coach me)</option>
                <option value="star">STAR-structured</option>
                <option value="live">Live (say-it-now)</option>
              </select>
            </div>
            <div className="settings-field">
              <label className="settings-label">Résumé</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt"
                style={{ display: 'none' }}
                onChange={onResumeFile}
              />
              <button
                type="button"
                className="icon-btn"
                style={{
                  alignSelf: 'flex-start',
                  width: 'auto',
                  padding: '6px 12px',
                  fontSize: 13
                }}
                onClick={() => fileInputRef.current?.click()}
                disabled={resumeIngesting}
              >
                {profileBundle ? 'Replace résumé' : 'Upload PDF / DOCX / TXT'}
              </button>
              {resumeIngesting ? (
                <UploadProgress percent={resumeProgress} label={resumeStatus ?? 'Working…'} />
              ) : (
                <>
                  {profileBundle && <AddedChip label={describeBundle(profileBundle)} />}
                  {resumeStatus && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                      {resumeStatus}
                    </span>
                  )}
                </>
              )}
              {/*
                Ingest sends a whole résumé in one request, which is an order of
                magnitude larger than a live draft, so the provider that is right
                for drafting is not always able to do it at all. Named here
                rather than in a separate pane because this is the setting an
                upload failure sends you looking for.
              */}
              <label className="settings-label" style={{ marginTop: 10 }}>
                Ingest provider
              </label>
              <select
                className="settings-input"
                value={s.ingestProvider}
                onChange={(e) =>
                  set('ingestProvider', e.target.value as HueSettings['ingestProvider'])
                }
              >
                <option value="">Same as drafting</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama">Ollama (local)</option>
                <option value="google">Google</option>
                <option value="groq">Groq</option>
                <option value="mistral">Mistral</option>
                <option value="cohere">Cohere</option>
                <option value="deepseek">DeepSeek</option>
              </select>
              {/*
                Warned before the upload rather than after it. The failure this
                prevents costs a minute of waiting and then returns a raw
                provider rate-limit body, which a user reasonably reads as Hue
                being broken.
              */}
              {ingestWillExceedQuota ? (
                <span style={{ color: '#d08b2c', fontSize: 12, marginTop: 4 }}>
                  Ingest is set to run on Groq, which cannot complete it. Reading a whole résumé
                  needs about 10,000 tokens in one request and Groq’s free tier caps that at 8,000,
                  so the upload will fail. Pick Google or Ollama here — drafting can stay on Groq,
                  where its speed is worth having.
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                  Reading a whole résumé takes far more tokens at once than drafting an answer does,
                  so the fastest provider is not always able to do it. Leave this on “Same as
                  drafting” unless an upload tells you otherwise.
                </span>
              )}
              {profileBundle ? (
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  <div>{describeBundle(profileBundle)}</div>
                  {currentGap ? (
                    /*
                      One question at a time. The whole list used to render at
                      once, and a dozen stacked textareas reads as a form to be
                      completed rather than a conversation to be had — the user
                      scrolls it, sizes up the work, and closes the pane. A
                      single question with a visible end to it is answerable.
                    */
                    <div className="settings-field" style={{ marginTop: 10, gap: 10 }}>
                      <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        These cover the things your résumé can’t show — which are exactly the ones
                        an AI would otherwise make up. “I don’t have one” is a real answer, and Hue
                        records it as one rather than inventing a story.
                      </div>
                      <div className="gap-progress">
                        <span className="gap-progress-count">
                          Question {gapNumberShown} of {gapTotal}
                        </span>
                        <span className="gap-dots">
                          {Array.from({ length: gapTotal }, (_, i) => (
                            <span
                              key={i}
                              className={i < gapNumberShown ? 'gap-dot gap-dot-filled' : 'gap-dot'}
                            />
                          ))}
                        </span>
                      </div>
                      <div style={{ fontSize: 13 }}>{currentGap.question}</div>
                      <textarea
                        className="settings-input"
                        rows={3}
                        value={gapDrafts[currentGap.id] ?? ''}
                        disabled={gapBusy === currentGap.id}
                        onChange={(e) =>
                          setGapDrafts((d) => ({ ...d, [currentGap.id]: e.target.value }))
                        }
                        placeholder="Tell it the way you’d tell it out loud…"
                      />
                      {gapNotes[currentGap.id] && (
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                          {gapNotes[currentGap.id]}
                        </span>
                      )}
                      <div className="gap-nav">
                        <button
                          type="button"
                          className="link-btn"
                          disabled={gapBusy === currentGap.id || gapPosition === 0}
                          onClick={() => setGapCursorId(stepCursor(openGapIds, currentGap.id, -1))}
                        >
                          ← Back
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          disabled={gapBusy === currentGap.id}
                          onClick={() => void onSkipGap(currentGap.id)}
                        >
                          I don’t have one
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={
                            gapBusy === currentGap.id ||
                            // Nothing typed and nowhere further to go, so Next
                            // would be a button that does nothing.
                            (!(gapDrafts[currentGap.id] ?? '').trim() &&
                              gapPosition === openGaps.length - 1)
                          }
                          style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }}
                          onClick={() => onNextGap(currentGap.id)}
                        >
                          {gapBusy === currentGap.id ? 'Saving…' : 'Next →'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                      Gap scan complete.
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                    <button type="button" className="link-btn" onClick={onRefreshProfile}>
                      Reload profile
                    </button>
                    <button type="button" className="link-btn" onClick={onDeleteProfile}>
                      Delete my profile
                    </button>
                  </div>
                </div>
              ) : (
                // The legacy freeform field stays visible only while there is no
                // bundle. It is still what the prompt falls back to, so an
                // existing install keeps working — but it is no longer the path
                // an upload takes.
                <textarea
                  className="settings-input"
                  style={{ marginTop: 8 }}
                  value={s.resumeSummary}
                  onChange={(e) => set('resumeSummary', e.target.value)}
                  rows={3}
                  placeholder="Upload a résumé above, or type a few sentences about your background…"
                />
              )}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="asr" />
              Transcription (ASR)
            </div>
            <div className="settings-field">
              <label className="settings-label">Tier</label>
              <select
                className="settings-input"
                value={s.asrTier}
                onChange={(e) => set('asrTier', e.target.value as AsrTier)}
              >
                <option value="auto">Auto (cloud if a key is set, else on-device)</option>
                <option value="on-device">On-device Whisper</option>
                <option value="cloud">Cloud</option>
              </select>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                {s.asrTier === 'on-device'
                  ? 'Runs Whisper locally — private and free, no API key needed.'
                  : 'Cloud transcription is faster and more accurate; pick a provider and add its key below.'}
              </span>
            </div>
            {s.asrTier !== 'on-device' && (
              <>
                <div className="settings-field">
                  <label className="settings-label">Cloud provider</label>
                  <select
                    className="settings-input"
                    value={s.cloudAsrProvider}
                    onChange={(e) => set('cloudAsrProvider', e.target.value as CloudAsrProvider)}
                  >
                    <option value="deepgram">Deepgram Nova-3</option>
                    <option value="assemblyai">AssemblyAI</option>
                    <option value="groq">Groq Whisper</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-label">
                    {CLOUD_ASR[s.cloudAsrProvider].label} API key
                  </label>
                  <SecretInput
                    value={s[CLOUD_ASR[s.cloudAsrProvider].keyField] as string}
                    onChange={(next) => setStr(CLOUD_ASR[s.cloudAsrProvider].keyField, next)}
                  />
                  <details style={{ marginTop: 6 }}>
                    <summary
                      style={{ color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}
                    >
                      How do I get a {CLOUD_ASR[s.cloudAsrProvider].label} API key?
                    </summary>
                    <ol
                      style={{
                        color: 'var(--text-muted)',
                        fontSize: 12,
                        margin: '6px 0 0',
                        paddingLeft: 18,
                        lineHeight: 1.5
                      }}
                    >
                      {CLOUD_ASR[s.cloudAsrProvider].steps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                    <a
                      href={CLOUD_ASR[s.cloudAsrProvider].consoleUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12, display: 'inline-block', marginTop: 4 }}
                    >
                      {CLOUD_ASR[s.cloudAsrProvider].consoleUrl}
                    </a>
                  </details>
                </div>
              </>
            )}
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="tts" />
              Voice (TTS)
            </div>
            <div className="settings-field">
              <label className="settings-label">Voice</label>
              <select
                className="settings-input"
                value={s.ttsVoice}
                onChange={(e) => set('ttsVoice', e.target.value)}
              >
                {KOKORO_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-field">
              <label className="settings-label">Speed</label>
              <div className="range-row">
                <input
                  type="range"
                  min={0.5}
                  max={1.5}
                  step={0.05}
                  value={s.ttsSpeed}
                  onChange={(e) => set('ttsSpeed', Number(e.target.value))}
                />
                <span className="range-value">{s.ttsSpeed.toFixed(2)}×</span>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="stealth" />
              Stealth
            </div>
            <div className="settings-field">
              <label className="settings-label">Hide Hue from screen sharing</label>
              <button
                type="button"
                className="icon-btn"
                style={{
                  alignSelf: 'flex-start',
                  width: 'auto',
                  padding: '6px 12px',
                  fontSize: 13
                }}
                onClick={() => void toggleStealth()}
                disabled={stealthBusy || !stealth || !stealth.supported}
              >
                {stealthBusy ? 'Working…' : stealth?.enabled ? 'Disable stealth' : 'Enable stealth'}
              </button>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Asks the OS to leave this window out of screen shares and screen-capture APIs, so it
                stays visible to you but not to the people you share with. Takes effect immediately.
              </span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                It hides the window and nothing else: the Hue process, its tray icon and the audio
                devices it holds open are all still there, and it cannot do anything about a camera
                pointed at your screen.
              </span>
              {stealth && !stealth.supported && (
                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                  Unavailable on this system — Linux and Windows 10 builds older than 2004 provide
                  no equivalent, so the switch would do nothing.
                </span>
              )}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="answering" />
              Answering
            </div>
            <div className="settings-field">
              <label className="settings-label">Speculative drafting</label>
              <button
                className="capture-btn"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => set('speculativeDrafting', !s.speculativeDrafting)}
              >
                {s.speculativeDrafting ? 'Turn off drafting early' : 'Draft while they speak'}
              </button>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Starts drafting an answer from a partial transcript, before the interviewer
                finishes, so the suggestion is ready sooner. It sends more requests than waiting
                does, and drafts that turn out to be wrong are thrown away — so it costs extra
                tokens to buy latency. Companion mode only.
              </span>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="docking" />
              Docking
            </div>
            <div className="settings-field">
              <label className="settings-label">Anchor position</label>
              <div className="anchor-grid">
                {ANCHOR_CELLS.map((anchor) => (
                  <button
                    key={anchor}
                    type="button"
                    className={`anchor-cell${s.windowAnchor === anchor ? ' anchor-cell--on' : ''}`}
                    aria-label={ANCHOR_LABELS[anchor]}
                    aria-pressed={s.windowAnchor === anchor}
                    title={ANCHOR_LABELS[anchor]}
                    onClick={() => set('windowAnchor', anchor)}
                  >
                    <span className="anchor-dot" />
                  </button>
                ))}
              </div>
              <button
                className="capture-btn"
                style={{ alignSelf: 'flex-start', marginTop: 8 }}
                onClick={() => set('windowAnchor', 'free')}
                disabled={s.windowAnchor === 'free'}
              >
                {s.windowAnchor === 'free' ? 'Free — drag it anywhere' : 'Unpin'}
              </button>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                Parks Hue in a fixed corner of whichever screen it is on, clear of the taskbar, and
                puts it back there if your displays change. Dragging the window releases the anchor
                — your position is remembered either way, including across restarts.
              </span>
            </div>
            <div className="settings-field">
              <label className="settings-label">Edge margin</label>
              <div className="range-row">
                <input
                  type="range"
                  min={0}
                  max={64}
                  step={4}
                  value={s.windowAnchorMargin}
                  onChange={(e) => set('windowAnchorMargin', Number(e.target.value))}
                />
                <span className="range-value">{s.windowAnchorMargin}px</span>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">
              <SectionIcon name="appearance" />
              Appearance
            </div>
            <div className="settings-field">
              <label className="settings-label">Window transparency</label>
              <div className="range-row">
                <input
                  type="range"
                  min={0.4}
                  max={1}
                  step={0.05}
                  value={s.windowOpacity}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    set('windowOpacity', v)
                    // Live preview — apply immediately so the slider is tangible.
                    document.documentElement.style.setProperty('--bg-alpha', String(v))
                  }}
                />
                <span className="range-value">{Math.round(s.windowOpacity * 100)}%</span>
                {/*
                  Settings is opaque now, so the slider can no longer be
                  previewed by looking through the pane at the desktop. This
                  swatch is the replacement, and it is the better test: it shows
                  the surface at the chosen alpha over a checkerboard, which
                  stands in for an arbitrary background rather than whichever
                  one happens to be behind the window right now.
                */}
                <span
                  className="opacity-preview"
                  title={`Preview at ${Math.round(s.windowOpacity * 100)}%`}
                  aria-hidden="true"
                >
                  <span className="opacity-preview-fill" style={{ opacity: s.windowOpacity }} />
                </span>
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                How opaque the floating window is. Lower lets more of the desktop show through.
                Settings itself stays solid regardless, so your keys and notes are always readable.
              </span>
            </div>
          </div>
        </div>

        <div className="drawer-footer">
          <button className={`save-btn${saved ? ' save-btn--saved' : ''}`} onClick={save}>
            {saved ? 'Saved' : 'Save settings'}
          </button>
        </div>
      </div>
    </div>
  )
}
