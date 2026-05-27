import { useState, useEffect, useRef, useCallback } from 'react'
import { useVoiceMode } from './hooks/useVoiceMode'
import type { PipelineState } from './lib/pipeline'
import type { VoiceTurn } from './hooks/useVoiceMode'
import { Settings } from './components/Settings'

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

// ── Orb content by pipeline state ──

function OrbInner({ state }: { state: PipelineState }): React.JSX.Element {
  if (state === 'connecting') {
    return <span className="orb-spinner" />
  }
  if (state === 'thinking') {
    return (
      <div className="thinking-dots">
        <span />
        <span />
        <span />
      </div>
    )
  }
  if (state === 'speaking') {
    return (
      <svg
        width="30"
        height="30"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" fillOpacity="0.2" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </svg>
    )
  }
  if (state === 'transcribing') {
    return (
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      >
        <path d="M3 6h18M3 10h14M3 14h10M3 18h7" />
      </svg>
    )
  }
  return <MicIcon />
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
}

// ── App ──

export default function App(): React.JSX.Element {
  const voice = useVoiceMode()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const companion = voice.mode === 'companion'
  const userLabel = companion ? 'Interviewer' : 'You'
  const assistantLabel = companion ? 'Suggested answer' : 'Hue'
  const [messages, setMessages] = useState<Message[]>([])
  const transcriptRef = useRef<HTMLDivElement>(null)
  const prevTranscriptTextRef = useRef<string | undefined>(undefined)

  // Drive the floating card's translucency from the saved windowOpacity setting.
  // Re-applied when the settings drawer closes so the slider takes effect live.
  const applyAppearance = useCallback(async (): Promise<void> => {
    const s = await window.hue.settings.get()
    document.documentElement.style.setProperty('--bg-alpha', String(s.windowOpacity))
  }, [])

  useEffect(() => {
    void applyAppearance()
  }, [applyAppearance])

  useEffect(() => {
    const t: VoiceTurn | null = voice.userTranscript
    if (!t?.text || t.text === prevTranscriptTextRef.current) return
    prevTranscriptTextRef.current = t.text
    setMessages((prev) => [
      ...prev,
      { role: 'user', text: t.text, tier: String(t.tier), latencyMs: t.latencyMs }
    ])
  }, [voice.userTranscript])

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

  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, voice.greetingText])

  // Reset the visible transcript and the underlying LLM history so the next turn
  // starts fresh. Also clear the dedupe ref so a repeated phrase still shows up.
  const clearConversation = (): void => {
    voice.clear()
    setMessages([])
    prevTranscriptTextRef.current = undefined
  }

  const hasConversation = messages.length > 0 || Boolean(voice.greetingText)

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <div className={`brand-orb brand-orb--${voice.state}`} />
          <span className="brand-name">Hue</span>
        </div>
        <div className="header-pills">
          <div className={`state-pill state-pill--${voice.state}`}>{STATE_LABELS[voice.state]}</div>
          <div
            className="mode-pill"
            title={`Listening to ${voice.audioSource === 'system' ? 'system / call audio' : 'microphone'}`}
          >
            {companion ? 'Companion' : 'Interviewer'}
            {voice.audioSource === 'system' ? ' · System' : ' · Mic'}
          </div>
        </div>
        {hasConversation && (
          <button
            className="icon-btn"
            onClick={clearConversation}
            title="Clear conversation and start fresh"
          >
            <ClearIcon />
          </button>
        )}
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Open settings">
          <GearIcon />
        </button>
      </header>

      <main className="app-main">
        <div className="orb-section">
          <div className={`voice-orb voice-orb--${voice.state}`}>
            <OrbInner state={voice.state} />
          </div>
        </div>

        <div className="transcript" ref={transcriptRef}>
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
                <div className="bubble-label">{msg.role === 'user' ? userLabel : assistantLabel}</div>
                <div className="bubble-text">{msg.text}</div>
                {msg.role === 'user' && msg.tier && (
                  <div className="bubble-meta">
                    {msg.tier} · {msg.latencyMs}ms
                  </div>
                )}
              </div>
            ))
          )}
          {voice.error && <div className="error-msg">{voice.error}</div>}
        </div>
      </main>

      <footer className="app-footer">
        <div className="footer-meta">
          {voice.userTranscript && (
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
        <div className="footer-meta" />
      </footer>

      {settingsOpen && (
        <Settings
          onClose={() => {
            setSettingsOpen(false)
            voice.reloadConfig()
            void applyAppearance()
          }}
        />
      )}
    </div>
  )
}
