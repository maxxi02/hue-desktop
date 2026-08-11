// src/main/cuesheet-ingest.ts
/**
 * Cue sheet ingest, in the main process.
 *
 * Unlike `ingest.ts`, this does **not** call the remote `hue-ingest` service.
 * That client POSTs bytes to `${ingestBaseUrl}/v1/accounts/{id}/ingest` and
 * polls a job; routing cue sheets through it would mean shipping a coordinated
 * change to a second repo before anything worked here.
 *
 * It also buys a real privacy property worth stating plainly: a cue sheet is a
 * user's rehearsed answers for a named employer, and under this design it
 * reaches the model provider and nowhere else — never Hue's own infrastructure.
 */
import { createHash, randomUUID } from 'node:crypto'
import { extractText as extractPdf } from 'unpdf'
import mammoth from 'mammoth'
import { saveSheet, sheetsDir } from './cuesheet-store.ts'
import { verifyCard, type CueCard, type CueSheet } from '../shared/cuesheet.ts'
// `completeOnce` (and everything it pulls in via `./settings`, including real
// Electron `app`/`safeStorage` bindings) is imported lazily inside
// `ingestCueSheet` below rather than at module scope. `segment` and
// `parseCards` are the pure, unit-tested surface of this file and must be
// loadable under plain `node --test`, outside Electron; a static import here
// would drag Electron's runtime into every test run of this module, even
// though nothing test-covered ever calls it.

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

  const pattern = headingMatch.test(text) ? /^#{1,6}\s+(.+)$/gm : qMatch.test(text) ? /^\s*Q:\s*(.+)$/gm : null
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
    return parsed.filter(
      (c): c is CueCard =>
        typeof c?.id === 'string' &&
        typeof c?.heading === 'string' &&
        typeof c?.script === 'string' &&
        Array.isArray(c?.cues) &&
        Array.isArray(c?.triggers)
    )
  } catch {
    return []
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
  const { completeOnce } = await import('./anthropic.ts')
  const raw = await completeOnce({
    system: SYSTEM,
    prompt: sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n'),
    model: 'claude-sonnet-5',
    maxTokens: 8000
  })

  onProgress({ phase: 'Checking against your notes', pct: 80 })
  const cards = parseCards(raw)
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
