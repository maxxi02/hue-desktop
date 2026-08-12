// src/main/cuesheet-ingest.ts
/**
 * Cue sheet ingest, in the main process, on the configured ingest provider.
 *
 * This used to call `completeOnce` from `./anthropic.ts` directly, which threw
 * without an Anthropic key no matter which provider Settings named — so a user
 * who picked Ollama for privacy could upload a resume but not a cue sheet, and
 * the app's offline story was only half true. It now shares the resume
 * pipeline's client, so both uploads honour one setting.
 *
 * The privacy property that motivated keeping this local is unchanged and worth
 * restating: a cue sheet is a user's rehearsed answers for a named employer, and
 * it reaches the model provider and nowhere else — never Hue's own
 * infrastructure, and with Ollama selected, never off the machine at all.
 */
import { createHash, randomUUID } from 'node:crypto'
import { extractText as extractPdf } from 'unpdf'
import mammoth from 'mammoth'
import { saveSheet, sheetsDir } from './cuesheet-store.ts'
import { verifyCard, type CueCard, type CueSheet } from '../shared/cuesheet.ts'
// The model client (and everything it pulls in via `./settings`, including real
// Electron `app`/`safeStorage` bindings) is imported lazily inside
// `ingestCueSheet` below rather than at module scope. `segment`, `parseCards`
// and `cardsFromStructured` are the pure, unit-tested surface of this file and
// must be loadable under plain `node --test`, outside Electron; a static import
// here would drag Electron's runtime into every test run of this module.

export async function extractText(bytes: Uint8Array, filename: string): Promise<string> {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) {
    const { text } = await extractPdf(bytes, { mergePages: true })
    return text
  }
  if (lower.endsWith('.docx')) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
    return value
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Split the document into candidate cards.
 *
 * Headings first, then `Q:` lines — which is the shape prepared interview
 * notes usually already have. A document with neither returns one section, and
 * the caller asks the user to confirm the split rather than guessing where one
 * answer ends and the next begins.
 */
export function segment(text: string): { heading: string; body: string }[] {
  const headingMatch = /^#{1,6}\s+(.+)$/gm
  const qMatch = /^\s*Q:\s*(.+)$/gm

  const pattern = headingMatch.test(text)
    ? /^#{1,6}\s+(.+)$/gm
    : qMatch.test(text)
      ? /^\s*Q:\s*(.+)$/gm
      : null
  if (pattern === null) return [{ heading: '', body: text }]

  const out: { heading: string; body: string }[] = []
  const marks: { heading: string; start: number; end: number }[] = []
  for (const m of text.matchAll(pattern)) {
    marks.push({ heading: m[1].trim(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  for (let i = 0; i < marks.length; i++) {
    const body = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : undefined)
    out.push({ heading: marks[i].heading, body })
  }
  return out
}

/**
 * Read cards out of the model's reply.
 *
 * Models wrap JSON in fences and prose often enough that demanding a bare
 * array would fail on output that is otherwise perfectly good. Unusable output
 * yields an empty array rather than an exception — the caller surfaces "no
 * cards found" and keeps the app alive.
 */
export function parseCards(raw: string): CueCard[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
  try {
    const parsed = JSON.parse(candidate)
    if (!Array.isArray(parsed)) return []
    const wellFormed = parsed.filter(
      (c): c is CueCard =>
        typeof c?.id === 'string' &&
        typeof c?.heading === 'string' &&
        typeof c?.script === 'string' &&
        Array.isArray(c?.cues) &&
        Array.isArray(c?.triggers)
    )

    // Ids must be unique. The model is asked for "a short kebab-case slug" and
    // two sections with similar headings can easily collide on one. Nothing
    // downstream notices: `CueMatcher.match` scores every card and can return
    // the SECOND card's id, while `CueMatcher.card(id)` resolves it with
    // `find`, which returns the FIRST. The user then sees a correct match
    // render the wrong prepared answer — a silent failure, and the worst
    // possible shape of one. Dropping the later duplicate costs one card;
    // keeping it costs trust in every card.
    const seen = new Set<string>()
    return wellFormed.filter((c) => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })
  } catch {
    return []
  }
}

/**
 * Cards from a structured response, falling back to the prose-tolerant parser.
 *
 * Strict `json_schema` is not universal — local models in particular hand back
 * JSON wrapped in prose or fenced in backticks, which is exactly what
 * `parseCards` was written to survive. So it stays, as the second attempt.
 *
 * Both paths funnel through `parseCards` rather than validating separately:
 * the id-uniqueness rule it enforces is load-bearing (a duplicate id makes a
 * correct match render the wrong prepared answer), and a second validator would
 * be a second place to forget it.
 */
export function cardsFromStructured(response: unknown): CueCard[] {
  if (Array.isArray(response)) return parseCards(JSON.stringify(response))
  if (response && typeof response === 'object') {
    const cards = (response as { cards?: unknown }).cards
    if (Array.isArray(cards)) return parseCards(JSON.stringify(cards))
  }
  return parseCards(typeof response === 'string' ? response : '')
}

/**
 * The shape the provider must return.
 *
 * Every object carries `additionalProperties: false` because the strict
 * `json_schema` dialect requires it. Lengths are bounded in code, not here —
 * `minItems`/`maxItems` are not enforced by the dialect, and `verifyCard` is
 * the thing that actually decides whether a card is usable.
 */
const CUESHEET_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'heading', 'cues', 'script', 'triggers'],
        properties: {
          id: { type: 'string' },
          heading: { type: 'string' },
          cues: { type: 'array', items: { type: 'string' } },
          script: { type: 'string' },
          triggers: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

const SYSTEM = `You turn a candidate's prepared interview notes into cue cards.

For each section you are given, return one card as JSON with these fields:
- id: a short kebab-case slug
- heading: the question this section answers
- script: the candidate's answer, COPIED VERBATIM from the section body. Select a span; never rewrite, summarise, or improve it. A script that is not a literal substring of the body will be discarded.
- cues: 3-5 short bold lines summarising the script. Every content word must already appear in the script, IN THE SAME ORDER as the script uses them — do not reorder, because a reordered cue is rejected by verification and lost. Never introduce a number, employer, or claim the script does not contain. If the script negates something ("did not", "never"), the cue MUST carry that negation; a cue that drops it inverts the meaning and is rejected.
- triggers: 8-15 different ways an interviewer might ASK this question out loud. These are questions, not answers. Vary the wording heavily — include blunt, casual, and formal phrasings, and phrasings that share no vocabulary with the heading. These are never shown to the candidate; they are a search index.

Return a JSON array and nothing else.`

export async function ingestCueSheet(
  bytes: Uint8Array,
  filename: string,
  label: string,
  onProgress: (p: { phase: string; pct: number }) => void
): Promise<CueSheet> {
  onProgress({ phase: 'Reading document', pct: 10 })
  const source = await extractText(bytes, filename)

  onProgress({ phase: 'Finding questions', pct: 30 })
  const sections = segment(source)

  onProgress({ phase: 'Building cue cards', pct: 50 })
  // Was `completeOnce` from `./anthropic.ts`, which threw without an Anthropic
  // key regardless of the configured provider — so a user who chose Ollama for
  // privacy could upload a resume but not a cue sheet. Routed through the same
  // client the resume pipeline uses, "local only" is now true for both.
  const { clientForSettings, quotaMessage } = await import('./structured-llm.ts')
  const llm = await clientForSettings('ingest')
  let response: unknown
  try {
    response = await llm.structured<unknown>({
      label: 'cue sheet',
      system: SYSTEM,
      schema: CUESHEET_SCHEMA,
      user: sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n'),
      maxTokens: 8000
    })
  } catch (err) {
    // A quota failure reaches the renderer as the provider's raw JSON body
    // otherwise — several lines of organisation ids and token arithmetic, in a
    // status line, at the moment the user is trying to prepare for an
    // interview. Rethrown rather than swallowed: this still failed.
    const quota = quotaMessage(err)
    throw quota ? new Error(quota) : err
  }

  onProgress({ phase: 'Checking against your notes', pct: 80 })
  const cards = cardsFromStructured(response)
    .map((c) => verifyCard(c, source))
    .filter((c) => c.script.length > 0 && c.cues.length > 0 && c.triggers.length > 0)

  const sheet: CueSheet = {
    id: randomUUID(),
    label,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    createdAt: new Date().toISOString(),
    cards
  }

  saveSheet(sheetsDir(), sheet)
  onProgress({ phase: 'Done', pct: 100 })
  return sheet
}
