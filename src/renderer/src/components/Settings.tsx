import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  HueSettings,
  AsrTier,
  AudioSource,
  CloudAsrProvider,
  HueMode,
  InterviewMode,
  LlmProvider,
  OpenAiCompatProvider
} from '@shared/types'
import { parseResume } from '../lib/resume'
import { cleanResumeText } from '../lib/resumeCleanup'
import { isLlmConfigured } from '../lib/greeting'

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
      {recording
        ? 'Press a key or mouse button… (Esc to cancel)'
        : formatAccelerator(value)}
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const detectSeq = useRef(0)
  const llmDetectSeq = useRef(0)

  useEffect(() => {
    window.hue.settings.get().then(setS)
  }, [])

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

  const onResumeFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    setResumeStatus(`Reading ${file.name}…`)
    try {
      const result = await parseResume(file)
      // Always keep the raw text in place first, so something usable is loaded
      // even if the AI clean-up can't run or fails.
      set('resumeSummary', result.text)

      if (!isLlmConfigured(s)) {
        setResumeStatus(
          `Loaded ${result.fileName} (${result.wordCount} words). Configure & save an LLM to auto-clean it. Review and save.`
        )
        return
      }

      setResumeStatus(`Cleaning up ${result.fileName} with AI…`)
      try {
        // The main process runs the LLM against the *saved* settings, so persist
        // the current provider/key first (otherwise a just-typed, unsaved key
        // wouldn't be used and clean-up would fail).
        await window.hue.settings.set(s)
        const cleaned = await cleanResumeText(result.text)
        if (cleaned) set('resumeSummary', cleaned)
        setResumeStatus(`Loaded & cleaned ${result.fileName}. Review and save.`)
      } catch (aiErr) {
        const msg = aiErr instanceof Error ? aiErr.message : String(aiErr)
        setResumeStatus(`Loaded ${result.fileName} (raw text — AI clean-up failed: ${msg}). Review and save.`)
      }
    } catch (err) {
      setResumeStatus(err instanceof Error ? err.message : String(err))
    }
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
                  <input
                    type="password"
                    className="settings-input"
                    value={s.anthropicApiKey}
                    onChange={(e) => set('anthropicApiKey', e.target.value)}
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
                  <input
                    type="password"
                    className="settings-input"
                    value={apiKey}
                    onChange={(e) => setStr(cfg.keyField, e.target.value)}
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
                Works globally — even during a call — to start or stop a session. Click, then press a
                key combo, a single key, or a mouse button (Back/Forward, etc.).
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
              <textarea
                className="settings-input"
                style={{ marginTop: 8 }}
                value={s.resumeSummary}
                onChange={(e) => set('resumeSummary', e.target.value)}
                rows={3}
                placeholder="Upload a résumé above, or type a few sentences about your background…"
              />
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
                  <input
                    type="password"
                    className="settings-input"
                    value={s[CLOUD_ASR[s.cloudAsrProvider].keyField] as string}
                    onChange={(e) => setStr(CLOUD_ASR[s.cloudAsrProvider].keyField, e.target.value)}
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
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                How opaque the floating window is. Lower lets more of the desktop show through.
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
