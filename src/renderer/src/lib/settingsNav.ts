import type { SectionIconName } from '../components/SectionIcon'

/**
 * The map of the Settings pane: which section belongs to which category, and
 * what someone might type when looking for it.
 *
 * ## Why this exists
 *
 * Settings had grown to fourteen sections flowed into a `repeat(auto-fit,
 * minmax(300px, 1fr))` grid. That layout has no opinion about what belongs
 * beside what — it packs by whatever fits — so Stealth landed next to
 * Transcription, the column count changed when the window was resized, and the
 * only way to find anything was to read all fourteen headings. Nothing was
 * *missing*; it was unfindable, which for a settings pane is the same failure.
 *
 * Categories fix the adjacency. Search fixes the case categories cannot: you
 * remember the word "hotkey" but not that hotkeys live under Window.
 *
 * ## Why the data lives here and not in the JSX
 *
 * The component renders the sections; this decides which are visible. Keeping
 * that decision as a pure function of (category, query) is what makes it
 * testable without mounting React, and it is the only part with behaviour worth
 * testing — the rest is markup.
 *
 * Section ids are the `SectionIconName` values, which are already unique per
 * section and already spelled out in the JSX. Reusing them means a section
 * cannot be added to the pane without either appearing here or failing the
 * exhaustiveness check in `settingsNav.test.ts`.
 */

export type SettingsCategoryId = 'start' | 'interview' | 'models' | 'audio' | 'window' | 'phone'

export interface SettingsCategory {
  id: SettingsCategoryId
  /** Sentence case, not Title Case — it is a label, not a headline. */
  label: string
  /** The glyph in the rail. Borrowed from one of the category's own sections. */
  icon: SectionIconName
  /** One line under the heading, so a category explains itself before it is read. */
  blurb: string
}

/**
 * Ordered by how often a category is opened, not by setup sequence.
 *
 * Get started is first because it is first *once*; everything after it is
 * ordered by daily use. Interview is what someone opens before a call. Window
 * and Phone are configured once and forgotten, so they sit at the bottom where
 * they cost nothing to skip.
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: 'start',
    label: 'Get started',
    icon: 'setup',
    blurb: 'What Hue still needs before it can help in a real interview.'
  },
  {
    id: 'interview',
    label: 'Interview',
    icon: 'interview',
    blurb: 'The job you’re preparing for, your résumé, and how Hue answers.'
  },
  {
    id: 'models',
    label: 'Models & keys',
    icon: 'assistant',
    blurb: 'Which provider drafts your answers, and which one reads your résumé.'
  },
  {
    id: 'audio',
    label: 'Audio',
    icon: 'asr',
    blurb: 'How Hue hears the interviewer, and how it sounds back.'
  },
  {
    id: 'window',
    label: 'Window',
    icon: 'appearance',
    blurb: 'Where the card sits, how visible it is, and the keys that summon it.'
  },
  {
    id: 'phone',
    label: 'Phone',
    icon: 'phone-app',
    blurb: 'Mirror the session to a second screen you can glance at.'
  }
] as const

export interface SettingsSectionMeta {
  id: SectionIconName
  category: SettingsCategoryId
  /** Matches the heading in the JSX. Search reads it, so it must not drift. */
  title: string
  /**
   * The words someone would actually type, which are rarely the heading.
   *
   * "Hotkey" is the word people use for what the pane calls Shortcuts;
   * "microphone" is what they mean by Transcription. A search that only matched
   * headings would be a search that only works for people who already know
   * where everything is — the exact people who do not need one.
   */
  keywords: string
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: 'setup',
    category: 'start',
    title: 'Setup',
    keywords: 'checklist onboarding first run getting started steps todo'
  },
  {
    id: 'applications',
    category: 'interview',
    title: 'Applications',
    keywords: 'jobs switch role company saved slots targets prep multiple'
  },
  {
    id: 'interview',
    category: 'interview',
    title: 'Interview context',
    keywords:
      'job title description posting résumé resume cv upload story bank gaps questions analyse'
  },
  {
    id: 'mode',
    category: 'interview',
    title: 'Mode',
    keywords: 'companion interviewer practice live rehearse who speaks'
  },
  {
    id: 'answering',
    category: 'interview',
    title: 'Answering',
    keywords: 'speculative drafting latency speed draft early guess'
  },
  {
    id: 'assessment',
    category: 'interview',
    title: 'Assessment mode',
    keywords:
      'coding code algorithm leetcode technical whiteboard hackerrank codepad complexity assessment'
  },
  {
    id: 'assistant',
    category: 'models',
    title: 'Assistant',
    keywords:
      'api key provider model anthropic claude ollama groq openai google gemini mistral cohere deepseek local cloud ingest token'
  },
  {
    id: 'asr',
    category: 'audio',
    title: 'Transcription (ASR)',
    keywords:
      'speech to text microphone mic listen deepgram assemblyai whisper local cloud system audio input language'
  },
  {
    id: 'tts',
    category: 'audio',
    title: 'Voice (TTS)',
    keywords: 'speak voice kokoro speed rate read aloud output sound'
  },
  {
    id: 'appearance',
    category: 'window',
    title: 'Appearance',
    keywords: 'opacity transparency translucent theme look see through'
  },
  {
    id: 'docking',
    category: 'window',
    title: 'Docking',
    keywords: 'anchor corner position place move margin snap monitor display'
  },
  {
    id: 'stealth',
    category: 'window',
    title: 'Stealth',
    keywords: 'hide screen share capture zoom teams meet obs invisible privacy'
  },
  {
    id: 'shortcuts',
    category: 'window',
    title: 'Shortcuts',
    keywords: 'hotkey keyboard key global trigger summon start stop capture screenshot mouse button'
  },
  {
    id: 'phone-mirror',
    category: 'phone',
    title: 'Phone mirror — opens a web page',
    keywords: 'lan browser local network web page second screen glance qr'
  },
  {
    id: 'phone-app',
    category: 'phone',
    title: 'Phone app — scan this one in Hue',
    keywords: 'relay cloud cellular pair pairing qr code android app remote'
  }
] as const

/** Sections belonging to one category, in pane order. */
export function sectionsIn(category: SettingsCategoryId): SettingsSectionMeta[] {
  return SETTINGS_SECTIONS.filter((section) => section.category === category)
}

/** First and last code point of the combining diacritical marks block. */
const COMBINING_FIRST = 0x0300
const COMBINING_LAST = 0x036f

function fold(text: string): string {
  // NFD splits an accented letter into its base letter plus a combining mark,
  // and every mark that matters here lands in one contiguous block. Dropping
  // that block turns "résumé" into "resume", which is what someone types.
  // Filtering by code point rather than by a `\p{Diacritic}` regex keeps the
  // rule visible in the source: the alternative is a character class made of
  // invisible characters, which no reviewer can check.
  let out = ''
  for (const ch of text.toLowerCase().normalize('NFD')) {
    const code = ch.codePointAt(0) ?? 0
    if (code < COMBINING_FIRST || code > COMBINING_LAST) out += ch
  }
  return out
}

/**
 * Every term in the query must match somewhere in the section, so typing more
 * narrows rather than widens.
 *
 * Substring rather than word-prefix matching, because the useful queries here
 * are fragments — "opac", "hotk", "assembly". Diacritics are folded so "resume"
 * finds "résumé", which is otherwise unreachable from a keyboard people
 * actually have.
 */
export function matchesQuery(section: SettingsSectionMeta, query: string): boolean {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = fold(`${section.title} ${section.keywords} ${section.category}`)
  return terms.every((term) => haystack.includes(term))
}

/**
 * Which sections the pane should render right now.
 *
 * A query outranks the selected category: someone who has typed "hotkey" wants
 * the shortcuts section wherever it lives, and filtering the search down to the
 * category they happen to be standing in would hide the answer they asked for.
 */
export function visibleSections(
  activeCategory: SettingsCategoryId,
  query: string
): Set<SectionIconName> {
  const searching = query.trim().length > 0
  const visible = SETTINGS_SECTIONS.filter((section) =>
    searching ? matchesQuery(section, query) : section.category === activeCategory
  )
  return new Set(visible.map((section) => section.id))
}

/**
 * Categories that contain at least one search hit, so the rail can dim the ones
 * that do not and stay a map of where the results are.
 */
export function categoriesWithMatches(query: string): Set<SettingsCategoryId> {
  if (!query.trim()) return new Set(SETTINGS_CATEGORIES.map((c) => c.id))
  return new Set(
    SETTINGS_SECTIONS.filter((section) => matchesQuery(section, query)).map((s) => s.category)
  )
}
