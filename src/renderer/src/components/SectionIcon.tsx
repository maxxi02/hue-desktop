/**
 * One 16px glyph per Settings section.
 *
 * ## Why hand-drawn inline SVG and not an icon package
 *
 * The renderer ships offline and every byte of it is bundled into the desktop
 * build, so a dependency for fourteen shapes would be build size and a
 * supply-chain surface bought for nothing — nothing here is more than four
 * paths. `App.tsx` already draws its icons this way, so this is the house
 * style rather than a new one.
 *
 * ## Why every glyph is `aria-hidden`
 *
 * The section heading sits immediately beside the glyph and is already the
 * accessible name for that section. Giving the icon a label too would make a
 * screen reader announce the same section twice — the glyph is here so the
 * pane can be recognised at a glance while scrolling, which is a purely
 * visual job. Hiding it is what keeps the non-visual reading clean.
 *
 * `stroke="currentColor"` is deliberate: `.settings-section-title` sets
 * `color: var(--text-muted)`, so the glyph tracks the heading in both themes
 * with no per-theme rule of its own.
 */

export type SectionIconName =
  | 'setup'
  | 'assistant'
  | 'mode'
  | 'phone-mirror'
  | 'phone-app'
  | 'shortcuts'
  | 'interview'
  | 'cue-sheets'
  | 'asr'
  | 'tts'
  | 'stealth'
  | 'answering'
  | 'docking'
  | 'appearance'

/**
 * The shapes, on a 24 grid.
 *
 * Kept deliberately unlike one another — a set of icons that all read as "a
 * rounded blob" is decoration, and the whole reason these exist is that the
 * fourteen headings were previously indistinguishable at a glance. Where two
 * natural choices collided (Docking and Appearance both wanted a teardrop),
 * one was redrawn: Docking is a thumbtack, Appearance a droplet.
 */
const GLYPHS: Record<SectionIconName, React.JSX.Element> = {
  // Sliders — two faders. Three would be truer to a mixing desk and unreadable
  // at 16px; two still says "settings you slide".
  setup: (
    <>
      <path d="M3 8h18" />
      <circle cx="9" cy="8" r="2" />
      <path d="M3 16h18" />
      <circle cx="15" cy="16" r="2" />
    </>
  ),
  // Sparkle — the four-point star that means "the model" everywhere else.
  assistant: <path d="M12 3c.6 5 4 8.4 9 9-5 .6-8.4 4-9 9-.6-5-4-8.4-9-9 5-.6 8.4-4 9-9z" />,
  // Two arrows swapping.
  mode: (
    <>
      <path d="M3 9h14" />
      <path d="M14 5l4 4-4 4" />
      <path d="M21 15H7" />
      <path d="M10 11l-4 4 4 4" />
    </>
  ),
  // Browser window — this section opens a web page on the phone.
  'phone-mirror': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M6.5 6.5h.01M9.5 6.5h.01" />
    </>
  ),
  // QR code — four corner brackets and a centre block. The brackets are one
  // path with four subpaths so the whole glyph stays two elements.
  'phone-app': (
    <>
      <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
      <rect x="10" y="10" width="4" height="4" />
    </>
  ),
  // Keyboard.
  shortcuts: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01" />
      <path d="M8 14h8" />
    </>
  ),
  // Briefcase — the job, the résumé, the posting.
  interview: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 12h18" />
    </>
  ),
  // Stacked cards, seen from above.
  'cue-sheets': (
    <>
      <path d="M12 2 3 7l9 5 9-5-9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </>
  ),
  // Microphone.
  asr: (
    <>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </>
  ),
  // Speaker with two sound waves.
  tts: (
    <>
      <path d="M4 9h3l5-4v14l-5-4H4z" />
      <path d="M16 9.5a4 4 0 0 1 0 5" />
      <path d="M18.5 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  // Eye with a slash. The slash runs corner to corner because at 16px a subtle
  // mark is the difference between "hidden" and "visible" going unnoticed.
  stealth: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      <path d="M3 21 21 3" />
    </>
  ),
  // Chat bubble with a tail.
  answering: (
    <path d="M20 4H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3v4l5-4h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z" />
  ),
  // Thumbtack — a pin you push in, not a map marker. Chosen over the teardrop
  // marker so it cannot be confused with the Appearance droplet below.
  docking: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </>
  ),
  // Paint droplet — point up, round below, the mirror of the thumbtack.
  appearance: (
    <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5S12.5 5.5 12 3c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
  )
}

export function SectionIcon({ name }: { name: SectionIconName }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  )
}
