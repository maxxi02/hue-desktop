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
import type { CueSheet } from '@shared/cuesheet'

const KOKORO_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'bf_emma', 'bm_george']

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
  }
}

const isCompatProvider = (p: LlmProvider): p is OpenAiCompatProvider =>
  p === 'google' || p === 'groq' || p === 'mistral' || p === 'cohere'

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

export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [s, setS] = useState<HueSettings | null>(null)
  const [saved, setSaved] = useState(false)
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
  const [cueSheets, setCueSheets] = useState<CueSheet[]>([])
  const [cueSheetStatus, setCueSheetStatus] = useState<string | null>(null)
  // Set once a file is picked; cleared once its ingest is confirmed or
  // cancelled. Holding the label here (rather than ingesting immediately on
  // pick) is what lets the user see and edit the default before it's sent.
  const [pendingCueFile, setPendingCueFile] = useState<File | null>(null)
  const [pendingCueLabel, setPendingCueLabel] = useState('')
  const [cueIngesting, setCueIngesting] = useState(false)
  const cueFileInputRef = useRef<HTMLInputElement>(null)
  // Tracks whether unmount has already happened, so a slow ingest that finishes
  // after the pane closes can't set state on it or leave onProgress subscribed
  // into a stale closure.
  const mountedRef = useRef(true)
  const cueStopProgressRef = useRef<(() => void) | null>(null)
  // Parsed from the settings field rather than held separately, so there is one
  // source of truth and a hand-edited settings file can't put the pane and the
  // prompt builder out of step.
  // `s` is null until settings load; the pane renders a loading state then.
  const profileBundle = s ? parseProfileBundle(s.profileBundleJson) : null
  const openGaps = profileBundle ? profileBundle.gaps.filter((g) => g.status === 'open') : []
  // Groq's free tier caps a single request at 8,000 tokens; story mining asks
  // for roughly 10,000. Resolved the same way `providerFor` does in the main
  // process — empty means "same as drafting".
  const effectiveIngestProvider = s ? s.ingestProvider || s.llmProvider : ''
  const ingestWillExceedQuota = effectiveIngestProvider === 'groq'
  const fileInputRef = useRef<HTMLInputElement>(null)
  const detectSeq = useRef(0)
  const llmDetectSeq = useRef(0)

  useEffect(() => {
    window.hue.settings.get().then(setS)
  }, [])

  const loadCueSheets = useCallback(async (): Promise<void> => {
    const list = await window.hue.cueSheet.list()
    if (mountedRef.current) setCueSheets(list)
  }, [])

  useEffect(() => {
    void loadCueSheets()
    return () => {
      mountedRef.current = false
      // If a pane close races an in-flight ingest, drop the listener too —
      // otherwise it fires progress into a component that's gone.
      cueStopProgressRef.current?.()
    }
  }, [loadCueSheets])

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
      setS((prev) => (prev ? { ...prev, phoneMirrorEnabled: status.running } : prev))
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
      setS((prev) => (prev ? { ...prev, stealthMode: status.enabled } : prev))
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
      setS((prev) => (prev ? { ...prev, relayEnabled: status.running } : prev))
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
      <div className="drawer-overlay" onClick={onClose}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="drawer-header">
            <h2>Settings</h2>
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
  const modelVal = cfg ? (s[cfg.modelField] as string) : ''

  const save = async (): Promise<void> => {
    const next = await window.hue.settings.set(s)
    setS(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
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

    setResumeStatus(`Reading ${file.name}…`)
    // Subscribed before the call, not after: ingest takes about a minute, and
    // the first progress event fires immediately.
    const stopProgress = window.hue.profile.onProgress((p) => {
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
        set('profileBundleJson', JSON.stringify(outcome.bundle))
        setResumeStatus(`Ready — ${describeBundle(outcome.bundle)}.`)
      } else {
        setResumeStatus(outcome.message)
      }
    } catch (err) {
      setResumeStatus(err instanceof Error ? err.message : String(err))
    } finally {
      stopProgress()
    }
  }

  const onDeleteProfile = async (): Promise<void> => {
    await window.hue.profile.delete()
    set('profileBundleJson', '')
    setResumeStatus('Profile deleted.')
  }

  const onRefreshProfile = async (): Promise<void> => {
    setResumeStatus('Reloading…')
    const outcome = await window.hue.profile.refresh()
    if (outcome.ok) {
      set('profileBundleJson', JSON.stringify(outcome.bundle))
      setResumeStatus(`Reloaded — ${describeBundle(outcome.bundle)}.`)
    } else {
      setResumeStatus(outcome.message)
    }
  }

  const onAnswerGap = async (gapId: string): Promise<void> => {
    const text = (gapDrafts[gapId] ?? '').trim()
    if (!text) return
    setGapBusy(gapId)
    try {
      const outcome = await window.hue.profile.answerGap(gapId, text)
      if (!outcome.ok) {
        setGapNotes((n) => ({ ...n, [gapId]: outcome.message }))
        return
      }
      set('profileBundleJson', JSON.stringify(outcome.bundle))
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
    setGapBusy(gapId)
    try {
      const bundle = await window.hue.profile.skipGap(gapId)
      set('profileBundleJson', JSON.stringify(bundle))
    } finally {
      setGapBusy(null)
    }
  }

  // Derives the default label from a filename by stripping its extension —
  // shared by the initial pick (to pre-fill the editable field) and the
  // confirm step (as the fallback when the field is left blank).
  const defaultCueLabel = (filename: string): string => filename.replace(/\.[^./\\]+$/, '')

  // A file has been picked; stage it and pre-fill the editable label rather
  // than ingesting immediately — the user needs to see and change the name
  // before it's sent, since "notes-final-v2" isn't something they can pick
  // between under pressure later.
  const onCueFilePicked = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    setPendingCueFile(file)
    setPendingCueLabel(defaultCueLabel(file.name))
    setCueSheetStatus(null)
  }

  const onCancelCueSheet = (): void => {
    setPendingCueFile(null)
    setPendingCueLabel('')
  }

  /**
   * Uploads the staged cue sheet document and refreshes the list on success.
   *
   * Ingest can fail for ordinary reasons — no API key configured, an
   * unreadable document, or a model response that yields zero usable cards —
   * so every path (throw, or a sheet with an empty `cards` array) has to land
   * on screen rather than leaving the progress line stuck mid-upload.
   */
  const onConfirmCueSheet = async (): Promise<void> => {
    const file = pendingCueFile
    if (!file || cueIngesting) return

    // Blank/whitespace-only falls back to the filename default rather than
    // creating an unnamed sheet; always trimmed before it's sent.
    const trimmed = pendingCueLabel.trim()
    const label = trimmed || defaultCueLabel(file.name)

    setCueIngesting(true)
    setPendingCueFile(null)
    setPendingCueLabel('')
    setCueSheetStatus(`Uploading ${file.name}…`)
    // Subscribed before the call, not after: ingest takes a while, and the
    // first progress event fires immediately.
    const stopProgress = window.hue.cueSheet.onProgress((p) => {
      if (!mountedRef.current) return
      setCueSheetStatus(`${p.phase}… ${Math.round(p.pct)}%`)
    })
    cueStopProgressRef.current = stopProgress

    try {
      const buf = await file.arrayBuffer()
      const sheet = await window.hue.cueSheet.ingest(buf, file.name, label)
      if (!mountedRef.current) return

      // Arm it. Uploading a cue sheet minutes before an interview means "use
      // this one" — leaving it inert behind a second, separate radio click is
      // how a user ends up with prepared answers loaded and nothing on screen,
      // which is exactly the failure this replaces. An empty sheet is not armed:
      // arming it would silently disarm a working one in favour of nothing.
      if (sheet.cards.length > 0) await onSelectCueSheet(sheet.id)

      setCueSheetStatus(
        sheet.cards.length === 0
          ? `"${sheet.label}" uploaded, but no usable cue cards were found in it. Try a ` +
              'document with clearer question-and-answer sections.'
          : `"${sheet.label}" is armed and ready — ${sheet.cards.length} cue card` +
              `${sheet.cards.length === 1 ? '' : 's'}. Close Settings to read it.`
      )
      await loadCueSheets()
    } catch (err) {
      if (mountedRef.current) setCueSheetStatus(err instanceof Error ? err.message : String(err))
    } finally {
      stopProgress()
      if (cueStopProgressRef.current === stopProgress) cueStopProgressRef.current = null
      if (mountedRef.current) setCueIngesting(false)
    }
  }

  // Both of these take ONLY `selectedCueSheetId` off the persisted object and
  // merge it into whatever is in the drawer right now. Assigning the whole
  // returned settings object with `setS(next)` would overwrite every unsaved
  // edit the user has open — a half-typed API key, a moved slider — because
  // the persisted copy predates them. Matches the functional-partial-update
  // pattern the phone/stealth/relay toggles in this file already use.
  const onSelectCueSheet = async (id: string): Promise<void> => {
    const next = await window.hue.cueSheet.select(id)
    setS((prev) => (prev ? { ...prev, selectedCueSheetId: next.selectedCueSheetId } : prev))
  }

  const onDeleteCueSheet = async (id: string): Promise<void> => {
    await window.hue.cueSheet.delete(id)
    // The main process clears the selection server-side if it was selected;
    // re-fetch settings so the radio group doesn't keep pointing at a sheet
    // that no longer exists.
    const next = await window.hue.settings.get()
    setS((prev) => (prev ? { ...prev, selectedCueSheetId: next.selectedCueSheetId } : prev))
    await loadCueSheets()
  }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="drawer-body">
          <div className="settings-section">
            <div className="settings-section-title">Assistant</div>
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
            <div className="settings-section-title">Mode</div>
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
            <div className="settings-section-title">Phone mirror — opens a web page</div>
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
            <div className="settings-section-title">Phone app — scan this one in Hue</div>
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
            <div className="settings-section-title">Shortcuts</div>
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
            <div className="settings-section-title">Interview context</div>
            <div className="settings-field">
              <label className="settings-label">Job title</label>
              <input
                className="settings-input"
                value={s.jobTitle}
                onChange={(e) => set('jobTitle', e.target.value)}
                placeholder="Senior Frontend Engineer"
              />
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
              >
                Upload PDF / DOCX / TXT
              </button>
              {resumeStatus && (
                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                  {resumeStatus}
                </span>
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
                  {openGaps.length > 0 ? (
                    <div
                      style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 14 }}
                    >
                      <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                        These cover the things your résumé can’t show — which are exactly the ones
                        an AI would otherwise make up. “I don’t have one” is a real answer, and Hue
                        records it as one rather than inventing a story.
                      </div>
                      {openGaps.map((gap) => (
                        <div
                          key={gap.id}
                          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                        >
                          <div style={{ fontSize: 13 }}>{gap.question}</div>
                          <textarea
                            className="settings-input"
                            rows={3}
                            value={gapDrafts[gap.id] ?? ''}
                            disabled={gapBusy === gap.id}
                            onChange={(e) =>
                              setGapDrafts((d) => ({ ...d, [gap.id]: e.target.value }))
                            }
                            placeholder="Tell it the way you’d tell it out loud…"
                          />
                          {gapNotes[gap.id] && (
                            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                              {gapNotes[gap.id]}
                            </span>
                          )}
                          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <button
                              type="button"
                              className="icon-btn"
                              disabled={gapBusy === gap.id || !(gapDrafts[gap.id] ?? '').trim()}
                              style={{
                                alignSelf: 'flex-start',
                                width: 'auto',
                                padding: '4px 10px',
                                fontSize: 12
                              }}
                              onClick={() => void onAnswerGap(gap.id)}
                            >
                              {gapBusy === gap.id ? 'Saving…' : 'Save answer'}
                            </button>
                            <button
                              type="button"
                              className="link-btn"
                              disabled={gapBusy === gap.id}
                              onClick={() => void onSkipGap(gap.id)}
                            >
                              I don’t have one
                            </button>
                          </div>
                        </div>
                      ))}
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
            <div className="settings-section-title">Cue sheets</div>
            <div className="settings-field">
              <label className="settings-label">Prepared answers</label>
              <input
                ref={cueFileInputRef}
                type="file"
                accept=".pdf,.docx,.txt,.md"
                style={{ display: 'none' }}
                onChange={onCueFilePicked}
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
                onClick={() => cueFileInputRef.current?.click()}
                disabled={cueIngesting}
              >
                Upload PDF / DOCX / TXT / MD
              </button>
              {pendingCueFile && (
                <div
                  style={{
                    marginTop: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    alignItems: 'flex-start'
                  }}
                >
                  <label className="settings-label">Name this cue sheet</label>
                  <input
                    className="settings-input"
                    value={pendingCueLabel}
                    onChange={(e) => setPendingCueLabel(e.target.value)}
                    placeholder={defaultCueLabel(pendingCueFile.name)}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }}
                      onClick={() => void onConfirmCueSheet()}
                      disabled={cueIngesting}
                    >
                      Add cue sheet
                    </button>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={onCancelCueSheet}
                      disabled={cueIngesting}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {cueSheetStatus && (
                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                  {cueSheetStatus}
                </span>
              )}
              {cueSheets.length === 0 ? (
                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 8 }}>
                  Upload the notes you prepared for this interview. Hue will show your own answer
                  when it hears a question you prepared for, and fall back to generating one when it
                  doesn&apos;t.
                </span>
              ) : (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13,
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="cueSheetSelection"
                      checked={s.selectedCueSheetId === ''}
                      onChange={() => void onSelectCueSheet('')}
                    />
                    None — always generate an answer
                  </label>
                  {cueSheets.map((sheet) => (
                    <div
                      key={sheet.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
                    >
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flex: 1,
                          cursor: 'pointer'
                        }}
                      >
                        <input
                          type="radio"
                          name="cueSheetSelection"
                          checked={s.selectedCueSheetId === sheet.id}
                          onChange={() => void onSelectCueSheet(sheet.id)}
                        />
                        <span>
                          {sheet.label}
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                            {' — '}
                            {sheet.cards.length} card{sheet.cards.length === 1 ? '' : 's'}
                            {' · '}
                            {new Date(sheet.createdAt).toLocaleDateString()}
                          </span>
                        </span>
                      </label>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => void onDeleteCueSheet(sheet.id)}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Transcription (ASR)</div>
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
            <div className="settings-section-title">Voice (TTS)</div>
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
            <div className="settings-section-title">Stealth</div>
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
            <div className="settings-section-title">Answering</div>
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
            <div className="settings-section-title">Docking</div>
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
            <div className="settings-section-title">Appearance</div>
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
