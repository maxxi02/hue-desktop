/**
 * The small reusable controls the Settings screen is built from.
 *
 * Leaf components: each takes props, renders, and holds no knowledge of the
 * settings object. They lived at the top of `Settings.tsx` purely because that
 * is where they were written.
 */

import { useState, useEffect } from 'react'
import { domButtonName, eventToAccelerator, formatAccelerator } from './accelerators.ts'

// Click-to-record control for a global trigger. Captures the next key combo,
// single key, or mouse button (back/forward/middle/right) and hands back the
// trigger string ("Ctrl+Shift+Space", "F9", or "Mouse:Back").
export function HotkeyRecorder({
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

/* Hand-drawn to match `SectionIcon` — the house style is inline SVG at one
   stroke weight, and a two-path glyph is not worth an icon dependency. */
export function SearchIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  )
}

export function CloseIcon(): React.JSX.Element {
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
export function AddedChip({ label }: { label: string }): React.JSX.Element {
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
export function UploadProgress({
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

export function EyeIcon({ off }: { off: boolean }): React.JSX.Element {
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
export function SecretInput({
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
