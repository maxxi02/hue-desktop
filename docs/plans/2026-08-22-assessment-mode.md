# Assessment Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Hue a second kind of answer — steps-first with supporting code, routed to its own provider, never spoken — selected per question while the mode is armed.

**Architecture:** A pure classifier in `shared/` decides per question. Routing threads a `role` through the existing LLM stream IPC so a single question can use a different provider from the one drafting prose. The answer arrives in the same `## marker` beat format the app already parses, with four new labels and three parser fixes that a code block requires. `Grounding` gains a third state so a code answer is not reported as a hallucination.

**Tech Stack:** TypeScript, Electron 39, React 19, `node --test` (no vitest — see Global Constraints), vanilla CSS with the tokens in `src/renderer/src/assets/base.css`.

**Spec:** `docs/specs/2026-08-22-assessment-mode-design.md`

## Global Constraints

- **Test runner is `node --test`, not vitest.** `package.json` defines `"test": "node --test src/**/*.test.ts"`. Run a single file with `node --test src/shared/assessment.test.ts`. Tests import `{ test } from 'node:test'` and `assert from 'node:assert/strict'`.
- **Imports inside `src/shared/` and `src/main/` use explicit `.ts` extensions** (e.g. `from './types.ts'`). Renderer files do not. Copy the convention of the file you are editing.
- **No new dependencies.** The app ships offline; icons are hand-drawn inline SVG. Do not add a syntax highlighter, an icon package, or a markdown renderer.
- **No em dashes or en dashes in `src/shared/answer-shape.ts`.** `answer-shape.test.ts` enforces this, because prompt text teaches its own punctuation to the model.
- **Everything in `src/shared/` must load under plain `node --test`** — no browser globals, no Electron imports, no React.
- **Verify before claiming.** Run the command and read the output. Never write "tests pass" without having run them.
- **Prettier before commit:** `npx prettier --write <files>`. Line endings are CRLF in the working tree; ignore git's LF warnings.

---

### Task 1: The classifier

**Files:**

- Create: `src/shared/assessment.ts`
- Test: `src/shared/assessment.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `looksLikeCodingQuestion(text: string): boolean` — used by Task 7 (pipeline routing) and Task 8 (capture).

The must-**not**-fire corpus is the important half. A behavioural question dense with technical words ("tell me about a hard technical decision") must stay behavioural, or the mode buries a STAR answer under a code block mid-interview.

- [x] **Step 1: Write the failing test**

Create `src/shared/assessment.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeCodingQuestion } from './assessment.ts'

const CODING = [
  'How would you design an SSR function?',
  'how would you implement a rate limiter',
  'Write a function that reverses a linked list',
  "What's the time complexity of that?",
  'Walk me through the algorithm you would use',
  'Can you code up a debounce for me',
  'How would you structure the database schema for this',
  'implement fizzbuzz'
]

const BEHAVIOURAL = [
  'Tell me about a time you disagreed with your manager',
  'Tell me about a hard technical decision you made',
  "What's the hardest bug you've ever shipped?",
  'How do you approach code review?',
  'Why do you want to work here?',
  'Tell me about yourself',
  'How do you handle disagreement on a technical team?',
  'What did you learn from that project?'
]

test('a coding question is recognised', () => {
  for (const q of CODING) {
    assert.equal(looksLikeCodingQuestion(q), true, `should fire: ${q}`)
  }
})

test('a behavioural question wearing technical words is not', () => {
  // This is the half that matters. Firing here buries a STAR answer under a
  // code block while the user is mid-interview.
  for (const q of BEHAVIOURAL) {
    assert.equal(looksLikeCodingQuestion(q), false, `should not fire: ${q}`)
  }
})

test('empty and junk input never fires', () => {
  assert.equal(looksLikeCodingQuestion(''), false)
  assert.equal(looksLikeCodingQuestion('   '), false)
  assert.equal(looksLikeCodingQuestion('uh, so, um'), false)
})

test('classification survives a partial interim transcript', () => {
  // Routing happens on the interim transcript, so the decision must be
  // reachable before the sentence is finished.
  assert.equal(looksLikeCodingQuestion('how would you implement a'), true)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/assessment.test.ts`
Expected: FAIL — `Cannot find module './assessment.ts'`

- [x] **Step 3: Write minimal implementation**

Create `src/shared/assessment.ts`:

```ts
/**
 * Does this question want code rather than a story?
 *
 * Runs on the *interim* transcript, before the provider is chosen, so it is a
 * local heuristic rather than a model call: a classifier round-trip would add
 * its own latency to the front of the slowest answer type in the app.
 *
 * It matches on question *intent*, never on vocabulary alone. "Tell me about a
 * hard technical decision" is dense with technical words and is a behavioural
 * question; firing on it would bury a STAR answer under a code block while the
 * user is mid-interview. So a behavioural opener disqualifies the line outright,
 * whatever else it contains.
 *
 * It will still be wrong sometimes. That is designed for rather than argued
 * away: the answer card carries a one-click override that re-runs the question
 * through the other path. The escape hatch is the feature; this is a tuning
 * exercise on top of it.
 */

/**
 * Openers that mark a question as being about the candidate's past, not about
 * code. Checked first and allowed to veto: they are the reliable signal, and
 * the technical vocabulary that follows them is a description of the work, not
 * a request to write any.
 */
const BEHAVIOURAL_OPENERS = [
  'tell me about',
  'describe a time',
  'give me an example',
  'what did you learn',
  'why do you want',
  'how do you handle',
  'how do you approach',
  'what is the hardest',
  "what's the hardest",
  'have you ever'
]

/** Phrases that ask for something to be built, designed, or analysed. */
const CODING_INTENT = [
  'how would you implement',
  'how would you design',
  'how would you build',
  'how would you structure',
  'how would you write',
  'how would you solve',
  'write a function',
  'write a method',
  'write some code',
  'code up',
  'implement a',
  'implement an',
  'implement fizzbuzz',
  'design a function',
  'time complexity',
  'space complexity',
  'big o',
  'walk me through the algorithm',
  'what data structure',
  'which data structure',
  'database schema',
  'reverse a linked list'
]

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function looksLikeCodingQuestion(text: string): boolean {
  const line = normalise(text)
  if (line.length === 0) return false
  if (BEHAVIOURAL_OPENERS.some((opener) => line.includes(opener))) return false
  return CODING_INTENT.some((phrase) => line.includes(phrase))
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test src/shared/assessment.test.ts`
Expected: PASS, 4 tests.

If `'implement fizzbuzz'` or `'Can you code up a debounce for me'` fails, the phrase list is missing an entry — add it, do not weaken the behavioural veto.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/shared/assessment.ts src/shared/assessment.test.ts
git add src/shared/assessment.ts src/shared/assessment.test.ts
git commit -m "feat(assessment): classify a question as wanting code"
```

---

### Task 2: The answer shape

**Files:**

- Modify: `src/shared/answer-shape.ts`
- Test: `src/shared/answer-shape.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `ASSESSMENT_SHAPE: string`, exported. Task 7 selects it instead of calling `answerShapeFor`.

`answerShapeFor(mode)` switches on `InterviewMode`, and assessment is **not** an interview mode — it is orthogonal to practice/star/live. Export the constant directly rather than adding a fourth mode, or a user in star mode could not get a code answer.

- [x] **Step 1: Write the failing test**

Append to `src/shared/answer-shape.test.ts`:

```ts
test('the assessment shape names all four markers', () => {
  for (const marker of ['## approach', '## steps', '## code', '## complexity']) {
    assert.ok(ASSESSMENT_SHAPE.includes(marker), `missing ${marker}`)
  }
})

test('the assessment shape permits numbering, which every other shape forbids', () => {
  // LABELLED_SHAPE ends with "never write a heading, a label, a number, or a
  // bullet of your own". Steps are the one exception and must say so, or the
  // two instructions fight and the model picks one.
  assert.match(ASSESSMENT_SHAPE, /number/i)
})

test('the assessment shape keeps code out of the spoken part', () => {
  assert.match(ASSESSMENT_SHAPE, /never read (it )?aloud|do not read/i)
})
```

Add `ASSESSMENT_SHAPE` to the existing import at the top of that file.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/answer-shape.test.ts`
Expected: FAIL — `ASSESSMENT_SHAPE` is not exported.

- [x] **Step 3: Write minimal implementation**

Add to `src/shared/answer-shape.ts`, above `answerShapeFor`. **No em dashes or en dashes** — the existing test in this file enforces it.

```ts
/**
 * The shape of a code answer.
 *
 * Exported directly rather than reached through `answerShapeFor`, because
 * assessment is not an interview mode. It is orthogonal to practice, star and
 * live: someone in star mode who is asked to design a function still needs the
 * code answer. Folding it into that switch would make the two settings fight.
 *
 * Explanation leads and code supports, because the user is talking an
 * interviewer through a design rather than reading syntax aloud. The steps are
 * what gets said; the code is a prop they glance at.
 */
export const ASSESSMENT_SHAPE =
  'Write the response in up to four parts. Each part begins with a marker alone on its own line. ' +
  'PART ONE begins with "## approach" and is one sentence naming the shape of the answer, said ' +
  'first so the interviewer knows where this is going. Keep it under about 25 words. ' +
  'PART TWO begins with "## steps" and holds the ordered beats of the approach, each one a short ' +
  'sentence the user can say on its own while pointing at the code. Number them 1., 2., 3. This ' +
  'is the one place a number is wanted: it is what lets someone glance down, find their place, ' +
  'and carry on talking. Keep the whole part under about 120 words. ' +
  'PART THREE is optional and begins with "## code". It holds one compact block in whatever ' +
  'language the question implies. Write real, working code and keep it short enough to read at a ' +
  'glance. This part is never read aloud, so it is the only place in the response where ' +
  'punctuation, symbols and indentation are for the eye rather than the voice. ' +
  'PART FOUR is optional and begins with "## complexity" and gives time and space cost in under ' +
  'about 20 words. Include it only when the question is about an algorithm. ' +
  'Omit "## code" if the question is about approach rather than implementation, and omit ' +
  '"## complexity" if the question does not turn on cost. A part with nothing real to put in it ' +
  'is an instruction to invent something. ' +
  'Outside the code part, write plain speakable prose in the first person, and never write a ' +
  'heading, a label, or a bullet of your own. The app strips the markers before the user sees ' +
  'them, so never mention them in the prose.'
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test src/shared/answer-shape.test.ts`
Expected: PASS, including the pre-existing dash test.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/shared/answer-shape.ts src/shared/answer-shape.test.ts
git add src/shared/answer-shape.ts src/shared/answer-shape.test.ts
git commit -m "feat(assessment): add the code answer shape"
```

---

### Task 3: Beat parser — four labels and three fixes

**Files:**

- Modify: `src/shared/answer-beats.ts`
- Test: `src/shared/answer-beats.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `BeatLabel` widened to include `'approach' | 'steps' | 'code' | 'complexity'`; `Beat` unchanged; `isCodeBeat(beat: Beat): boolean` for Task 9's renderer.

Read spec §5 before starting. The three defects, worst first:

1. `buffer.join('\n').trim()` dedents the first line of an indented block. Happens on ordinary input, every time.
2. `withholdPartialMarker` withholds a trailing one-word comment (`# key`), so it flickers while streaming.
3. `MARKER` is tested against `line.trim()`, so an indented `    ## code` inside a block splits the beat.

- [x] **Step 1: Write the failing test**

Append to `src/shared/answer-beats.test.ts`:

```ts
const CODE_ANSWER =
  '## approach\nCache the render and stream the shell first.\n' +
  '## steps\n1. Key the cache on the route.\n2. Stream the shell.\n' +
  '## code\n' +
  'function render(req) {\n' +
  '    const key = routeKey(req)\n' +
  '    return cache.get(key)\n' +
  '}\n' +
  '## complexity\nO(1) lookup, O(n) render.'

test('the four assessment labels are recognised', () => {
  const beats = parseBeats(CODE_ANSWER)
  assert.deepEqual(
    beats.map((b) => b.label),
    ['approach', 'steps', 'code', 'complexity']
  )
})

test('a code beat keeps the indentation of its first line', () => {
  // parseBeats used to flush with .trim(), which strips leading whitespace from
  // the START of the joined body -- i.e. the first line only. The result was a
  // block whose first line was dedented and whose others were not.
  const beats = parseBeats('## code\n    def key(req):\n        return req.path')
  const code = beats.find((b) => b.label === 'code')
  assert.ok(code)
  assert.equal(code.text, '    def key(req):\n        return req.path')
})

test('a code beat still drops surrounding blank lines', () => {
  const beats = parseBeats('## code\n\n\nconst a = 1\n\n\n')
  assert.equal(beats.find((b) => b.label === 'code')?.text, 'const a = 1')
})

test('a one-word comment at the end of a code beat does not flicker', () => {
  // withholdPartialMarker holds back an unterminated last line that could still
  // become a marker, and PARTIAL_MARKER matches "# key". Inside a code beat
  // that made the last line vanish and reappear as tokens arrived.
  const beats = parseBeats('## code\nconst a = 1\n# key')
  assert.equal(beats.find((b) => b.label === 'code')?.text, 'const a = 1\n# key')
})

test('an indented label line inside code does not split the beat', () => {
  const beats = parseBeats('## code\nif (x) {\n    ## code\n}')
  assert.equal(beats.length, 1)
  assert.equal(beats[0].text, 'if (x) {\n    ## code\n}')
})

test('a marker at column zero still closes a code beat', () => {
  const beats = parseBeats('## code\nconst a = 1\n## complexity\nO(1).')
  assert.deepEqual(
    beats.map((b) => b.label),
    ['code', 'complexity']
  )
})

test('prose beats are unaffected by the code-beat rules', () => {
  const beats = parseBeats('## what\n  Leading space is still trimmed here.')
  assert.equal(beats[0].text, 'Leading space is still trimmed here.')
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/answer-beats.test.ts`
Expected: FAIL on the label test (`approach` is not in the vocabulary) and on the indentation test.

- [x] **Step 3: Write minimal implementation**

In `src/shared/answer-beats.ts`:

Widen the vocabulary:

```ts
export type BeatLabel =
  | 'what'
  | 'why'
  | 'how'
  | 'when'
  | 'scenario'
  | 'approach'
  | 'steps'
  | 'code'
  | 'complexity'

export const BEAT_LABELS: readonly BeatLabel[] = [
  'what',
  'why',
  'how',
  'when',
  'scenario',
  'approach',
  'steps',
  'code',
  'complexity'
]
```

Extend the margin tags:

```ts
export const BEAT_LABEL_TEXT: Record<BeatLabel, string> = {
  what: 'what',
  why: 'why',
  how: 'how',
  when: 'when',
  scenario: 'if they ask',
  approach: 'approach',
  steps: 'steps',
  // Not "code": the tag says what to DO with the block, and this is the one
  // part of an answer that is never spoken.
  code: 'do not read aloud',
  complexity: 'complexity'
}

/** A beat whose body is code, and must be rendered verbatim. */
export function isCodeBeat(beat: Beat): boolean {
  return beat.label === 'code'
}
```

Add a blank-line trim that preserves indentation:

```ts
/**
 * Strip leading and trailing blank lines without touching indentation.
 *
 * `.trim()` cannot be used on a code body: it strips whitespace from the start
 * of the joined string, which is the first line's indentation, and leaves every
 * other line alone. The result is a block whose first line is dedented and
 * whose others are not.
 */
function trimBlankLines(lines: string[]): string {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim().length === 0) start += 1
  while (end > start && lines[end - 1].trim().length === 0) end -= 1
  return lines.slice(start, end).join('\n')
}
```

Rewrite `withholdPartialMarker` to take the current label, and `parseBeats` to track whether it is inside a code beat:

```ts
function withholdPartialMarker(raw: string, insideCode: boolean): string {
  // Inside a code beat a leading '#' is a comment, not a marker in progress.
  // Withholding it made the last line of a block flicker as tokens arrived.
  if (insideCode) return raw
  if (raw.endsWith('\n')) return raw
  const cut = raw.lastIndexOf('\n')
  const tail = raw.slice(cut + 1).trimStart()
  if (tail.length === 0 || tail[0] !== '#') return raw
  return PARTIAL_MARKER.test(tail) ? raw.slice(0, cut + 1) : raw
}

export function parseBeats(raw: string): Beat[] {
  // Whether the buffer's final beat is a code beat decides both the withholding
  // rule and the trim, so it has to be known before either runs.
  const lastMarker = /^##[ \t]*([a-z]+)[ \t]*$/gim
  let endsInCode = false
  for (const m of raw.matchAll(lastMarker)) endsInCode = m[1].toLowerCase() === 'code'

  const text = withholdPartialMarker(raw, endsInCode)
  const beats: Beat[] = []
  let label: BeatLabel | null = null
  let buffer: string[] = []

  const flush = (): void => {
    const body = label === 'code' ? trimBlankLines(buffer) : buffer.join('\n').trim()
    if (body.length > 0) beats.push({ label, text: body })
    buffer = []
  }

  for (const line of text.split('\n')) {
    // Inside a code beat only a marker at column zero closes it, so an indented
    // '## code' in a comment cannot split the block.
    const candidate = label === 'code' ? line : line.trim()
    const match = label === 'code' && line !== line.trimStart() ? null : MARKER.exec(candidate)
    const word = match ? match[1].toLowerCase() : null
    if (word !== null && isLabel(word)) {
      flush()
      label = word
      continue
    }
    if (label === null && line.trim().length === 0) {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()
  return beats
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test src/shared/answer-beats.test.ts`
Expected: PASS — the seven new tests **and** every pre-existing test in the file. If a pre-existing streaming test now fails, the withholding change leaked into prose beats; re-check the `insideCode` guard.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/shared/answer-beats.ts src/shared/answer-beats.test.ts
git add src/shared/answer-beats.ts src/shared/answer-beats.test.ts
git commit -m "feat(assessment): beats can hold code without mangling it"
```

---

### Task 4: Grounding gains a third state

**Files:**

- Modify: `src/shared/grounding.ts` (the `Grounding` union, ~line 68)
- Modify: `src/renderer/src/App.tsx:239`
- Modify: `src/renderer/src/lib/pipeline.ts:1021`
- Modify: `src/renderer/src/lib/sessionHistory.ts:124` and `:133`
- Modify: `src/shared/session-review.ts:134` and `:158`
- Test: `src/shared/session-review.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `Grounding` widened with `{ kind: 'general-knowledge' }`. Task 7 constructs it.

A union member rather than a boolean, so the compiler forces all six consumers to say what they do with it. Run `npm run typecheck` after widening the type and let the errors enumerate the work.

- [x] **Step 1: Write the failing test**

Append to `src/shared/session-review.test.ts`:

```ts
test('a general-knowledge answer is neither grounded nor a miss', () => {
  // `ungrounded` is computed as `receipts.length - grounded.length`, a
  // subtraction, so a general-knowledge receipt counts as ungrounded unless it
  // is excluded from the population first. That would report a session of
  // coding questions as a session of hallucinations, which teaches the user to
  // ignore the indicator everywhere -- including on the behavioural answers
  // where it is load-bearing.
  const review = reviewSession(
    [
      { role: 'assistant', grounding: { kind: 'general-knowledge' } },
      { role: 'assistant', grounding: { kind: 'general-knowledge' } },
      { role: 'assistant', grounding: { kind: 'ungrounded', claimedId: null } }
    ],
    null
  )
  assert.equal(review.answers.grounded, 0)
  assert.equal(review.answers.ungrounded, 1)
  assert.equal(review.answers.total, 1)
  assert.equal(review.answers.generalKnowledge, 2)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/session-review.test.ts`
Expected: FAIL — `'general-knowledge'` is not assignable to `Grounding`.

- [x] **Step 3: Write minimal implementation**

In `src/shared/grounding.ts`:

```ts
/**
 * Where an answer came from.
 *
 * `general-knowledge` is not a third flavour of failure. `grounded` and
 * `ungrounded` both presuppose the question was one the resume could answer;
 * this says it was outside the bank by design, which is the normal and correct
 * state for a code answer.
 *
 * A union member rather than a flag on purpose: every consumer is forced by the
 * compiler to say what it does with it, and none can quietly treat it as a
 * hallucination.
 */
export type Grounding =
  | { kind: 'grounded'; story: ProfileStory }
  | { kind: 'ungrounded'; claimedId: string | null }
  | { kind: 'general-knowledge' }
```

Run `npm run typecheck` and fix each reported site:

- `session-review.ts:134` — `ungrounded` is `receipts.length - grounded.length`, so exclusion has to happen before the subtraction. Add a count of its own rather than dropping the receipts on the floor, so the review can still say how many code answers there were:

```ts
export interface AnswerCounts {
  /** Answers that carried a receipt and were measurable against the bank. */
  total: number
  grounded: number
  ungrounded: number
  /** Code answers, which no story could have anchored. Excluded from the score. */
  generalKnowledge: number
}
```

```ts
const general = receipts.filter((r) => r.kind === 'general-knowledge')
// Scored against the bank only. A code answer was never a candidate for a
// story, so it is not a miss.
const scored = receipts.filter((r) => r.kind !== 'general-knowledge')
const grounded = scored.filter((r) => r.kind === 'grounded')
const answers: AnswerCounts = {
  total: scored.length,
  grounded: grounded.length,
  ungrounded: scored.length - grounded.length,
  generalKnowledge: general.length
}
```

- `session-review.ts:158` — the `for (const receipt of grounded)` loop already re-narrows with `if (receipt.kind !== 'grounded') continue`, so it needs no change once `grounded` is derived from `scored`.
- `describeReview` (line 205) — check whether it reports `total` in prose; if it does, decide whether code answers should appear in that sentence and make it explicit either way.
- `pipeline.ts:1021` — do not log the ungrounded warning for it.
- `App.tsx:239` — render a neutral marker reading `general knowledge, not from your résumé`. Style it with `var(--text-muted)`, not `var(--danger)`: it is provenance, not a warning.
- `sessionHistory.ts:124` / `:133` — serialise and revive it. It has no payload, so `{ kind: 'general-knowledge' }` round-trips as itself; make sure the reviver returns it rather than falling through to `null`.

- [x] **Step 4: Run tests and typecheck**

Run: `npm run typecheck && node --test src/shared/session-review.test.ts src/renderer/src/lib/sessionHistory.test.ts`
Expected: typecheck clean, tests PASS.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/shared/grounding.ts src/shared/session-review.ts src/renderer/src/App.tsx src/renderer/src/lib/pipeline.ts src/renderer/src/lib/sessionHistory.ts
git add -A
git commit -m "feat(assessment): a code answer is general knowledge, not ungrounded"
```

---

### Task 5: Settings fields and provider resolution

**Files:**

- Modify: `src/shared/types.ts` (`HueSettings` ~line 164, `DEFAULT_SETTINGS` ~line 312)
- Modify: `src/main/structured-llm.ts` (`providerFor`, line 272)
- Test: `src/main/structured-llm.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `assessmentEnabled: boolean`, `assessmentProvider: LlmProvider | ''`, `assessmentHotkey: string` on `HueSettings`; `providerFor(role: 'drafting' | 'ingest' | 'assessment', llmProvider, ingestProvider, assessmentProvider)` — Task 6 calls it.

- [x] **Step 1: Write the failing test**

Append to `src/main/structured-llm.test.ts`:

```ts
test('the assessment role falls back to drafting when unset', () => {
  assert.equal(providerFor('assessment', 'groq', '', ''), 'groq')
})

test('the assessment role uses its own provider when set', () => {
  assert.equal(providerFor('assessment', 'groq', 'google', 'anthropic'), 'anthropic')
})

test('the assessment provider does not disturb the other two roles', () => {
  assert.equal(providerFor('drafting', 'groq', 'google', 'anthropic'), 'groq')
  assert.equal(providerFor('ingest', 'groq', 'google', 'anthropic'), 'google')
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test src/main/structured-llm.test.ts`
Expected: FAIL — `providerFor` takes three arguments.

- [x] **Step 3: Write minimal implementation**

In `src/main/structured-llm.ts`, replace `providerFor`:

```ts
/**
 * Which provider serves a role. `''` on a role's own setting means "same as
 * drafting", which is the convention `ingestProvider` established.
 *
 * Three roles now, and the reason is the same each time: one job wants speed,
 * one wants context, one wants to be right about code.
 */
export function providerFor(
  role: 'drafting' | 'ingest' | 'assessment',
  llmProvider: LlmProvider,
  ingestProvider: LlmProvider | '',
  assessmentProvider: LlmProvider | '' = ''
): LlmProvider {
  if (role === 'ingest' && ingestProvider) return ingestProvider
  if (role === 'assessment' && assessmentProvider) return assessmentProvider
  return llmProvider
}
```

Update the existing `clientForSettings` call at line 400 to pass `s.assessmentProvider`.

In `src/shared/types.ts`, add to `HueSettings` after `jobBriefJson`:

```ts
/**
 * Assessment mode: answer coding questions with steps and code instead of a
 * spoken story. Armed, not forced -- Hue still classifies each question.
 *
 * Off by default because arming it changes which provider is billed, and a
 * mode that costs money is one the user should enter on purpose.
 */
assessmentEnabled: boolean
/** Provider for assessment answers. `''` means "same as drafting". */
assessmentProvider: LlmProvider | ''
/** Global trigger that arms/disarms assessment mode. Same encoding as the other hotkeys. */
assessmentHotkey: string
```

And to `DEFAULT_SETTINGS`:

```ts
  assessmentEnabled: false,
  assessmentProvider: '',
  assessmentHotkey: '',
```

- [x] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && node --test src/main/structured-llm.test.ts`
Expected: typecheck clean, tests PASS.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/shared/types.ts src/main/structured-llm.ts src/main/structured-llm.test.ts
git add -A
git commit -m "feat(assessment): settings fields and a third provider role"
```

---

### Task 6: Route a single stream to a different provider

**Files:**

- Modify: `src/shared/types.ts` (`LlmStreamRequest`, line 400)
- Modify: `src/main/ipc.ts:111` (the `hue:llm:start` handler)
- Modify: `src/main/openai-compat.ts` (`startOpenAiCompatStream`, line 210, and its `getSettings()` read at line 253)

**Interfaces:**

- Consumes: `providerFor` from Task 5.
- Produces: `LlmStreamRequest.role?: 'drafting' | 'assessment'`. Task 7 sets it.

This is the plumbing the spec did not account for: `LlmStreamRequest` has no provider field, and `hue:llm:start` reads `getSettings().llmProvider` directly. Each stream starter also reads its own key and model from settings, so the resolved provider must be passed down to the OpenAI-compatible one.

- [x] **Step 1: Add the field**

In `src/shared/types.ts`:

```ts
export interface LlmStreamRequest {
  /** Conversation history (user/assistant turns). */
  messages: LlmMessage[]
  /** Fully-rendered system prompt (built in the renderer from interview context). */
  system: string
  maxTokens?: number
  /**
   * Which provider role serves this one request. Absent means drafting.
   *
   * Per-request rather than read from settings in main, because assessment mode
   * is decided per question: one session alternates between a fast drafting
   * model and a capable assessment one, and the renderer is what knows which
   * kind of question just arrived.
   */
  role?: 'drafting' | 'assessment'
}
```

- [x] **Step 2: Thread it through the dispatch**

In `src/main/ipc.ts`, replace the body of `hue:llm:start`:

```ts
ipcMain.handle('hue:llm:start', (event, streamId: string, req: LlmStreamRequest) => {
  const s = getSettings()
  const provider = providerFor(
    req.role === 'assessment' ? 'assessment' : 'drafting',
    s.llmProvider,
    s.ingestProvider,
    s.assessmentProvider
  )
  if (provider === 'ollama') {
    startOllamaStream(event.sender, streamId, req)
  } else if (isOpenAiCompatProvider(provider)) {
    startOpenAiCompatStream(event.sender, streamId, req, provider)
  } else {
    startLlmStream(event.sender, streamId, req)
  }
  return streamId
```

Add `import { providerFor } from './structured-llm'` to the top of `ipc.ts`.

- [x] **Step 3: Accept the override in the compat starter**

In `src/main/openai-compat.ts`, add a fourth parameter and use it where the provider is currently derived from settings:

```ts
export function startOpenAiCompatStream(
  sender: WebContents,
  streamId: string,
  req: LlmStreamRequest,
  // Explicit rather than re-derived from settings: `hue:llm:start` has already
  // resolved the role for this one request, and reading `llmProvider` again here
  // would silently send an assessment question to the drafting provider.
  provider?: OpenAiCompatProvider
): void {
```

At the `const s = getSettings()` read (line 253), use `provider ?? s.llmProvider` wherever the provider is chosen, and select the key and model fields from that resolved provider via the existing `COMPAT_PROVIDERS` map.

- [x] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, full suite green. There is no unit test for IPC dispatch in this codebase; correctness here is checked by Task 7's routing test and by manual verification in Task 11.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/shared/types.ts src/main/ipc.ts src/main/openai-compat.ts
git add -A
git commit -m "feat(assessment): route one stream to a different provider"
```

---

### Task 7: Pipeline routing

**Files:**

- Modify: `src/renderer/src/lib/pipeline.ts` — `startResponse` (line 858), the two `window.hue.llm.start` calls (749, 864), the speculation gate (line 206), `buildCompanionPrompt` (1260) and its `answerShapeFor` call (1375)
- Test: `src/renderer/src/lib/pipeline.test.ts` if one exists; otherwise extend `src/shared/assessment.test.ts` with the pure selection helper below

**Interfaces:**

- Consumes: `looksLikeCodingQuestion` (Task 1), `ASSESSMENT_SHAPE` (Task 2), `role` on `LlmStreamRequest` (Task 6), `assessmentEnabled` (Task 5).
- Produces: `assessmentRouting(settings, questionText)` — a pure helper so the decision is testable without loading `pipeline.ts`, which imports browser globals and cannot run under `node --test`.

- [x] **Step 1: Write the failing test**

Append to `src/shared/assessment.test.ts`:

```ts
import { assessmentRouting } from './assessment.ts'

const S = { assessmentEnabled: true } as never

test('an armed coding question routes to assessment', () => {
  const r = assessmentRouting(S, 'How would you design an SSR function?')
  assert.equal(r.assessment, true)
  assert.equal(r.speak, false)
  assert.equal(r.speculate, false)
  assert.equal(r.maxTokens, 1500)
})

test('an armed behavioural question does not', () => {
  const r = assessmentRouting(S, 'Tell me about a time you disagreed')
  assert.equal(r.assessment, false)
})

test('a disarmed session never routes to assessment', () => {
  const r = assessmentRouting({ assessmentEnabled: false } as never, 'write a function that sorts')
  assert.equal(r.assessment, false)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/assessment.test.ts`
Expected: FAIL — `assessmentRouting` is not exported.

- [x] **Step 3: Write minimal implementation**

Add to `src/shared/assessment.ts`:

```ts
import type { HueSettings } from './types.ts'

export interface AssessmentRouting {
  assessment: boolean
  speak: boolean
  speculate: boolean
  maxTokens: number
}

/**
 * The routing decision for one question, as a pure function.
 *
 * Separate from `pipeline.ts` because that module imports browser globals and
 * cannot be loaded under `node --test`, which is the same reason
 * `answer-shape.ts` and `memory-policy.ts` live here.
 *
 * A code answer never speaks: the capture path already forces this, and TTS
 * reading a code block aloud is noise at best and audible to the interviewer at
 * worst. It never speculates either: speculation drafts from the interim
 * transcript and discards what turns out wrong, and these are the longest
 * answers routed to the most expensive model.
 */
export function assessmentRouting(s: HueSettings, question: string): AssessmentRouting {
  const assessment = s.assessmentEnabled && looksLikeCodingQuestion(question)
  return {
    assessment,
    // `speak` and `speculate` are permissions, not commands. False on an
    // assessment answer is absolute; true means "no objection from here", and
    // the caller still ANDs with `this.speakResponses`, so a companion-mode
    // session stays silent exactly as it does today.
    speak: !assessment,
    speculate: !assessment,
    maxTokens: assessment ? 1500 : 700
  }
}
```

In `pipeline.ts`:

- At the point a final transcript triggers an answer (line 555 area and line 800), call `assessmentRouting(this.settings, text)` and hold the result on the instance as `this.currentAssessment`.
- Pass `role: this.currentAssessment ? 'assessment' : undefined` in both `window.hue.llm.start` calls.
- Gate speculation: at line 206 the constructor enables speculation for companion mode; additionally skip firing a speculative draft when `looksLikeCodingQuestion(interimText)` is true.
- In `buildCompanionPrompt` (1260), select the shape: `assessment ? ASSESSMENT_SHAPE : answerShapeFor(s.interviewMode)` at line 1375. The prompt is built per response, so thread the flag in as a parameter rather than reading instance state inside a module-level function.

- [x] **Step 4: Run tests**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, suite green.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/shared/assessment.ts src/shared/assessment.test.ts src/renderer/src/lib/pipeline.ts
git add -A
git commit -m "feat(assessment): route coding questions through the assessment path"
```

---

### Task 8: Screen capture routing and the vision fallback

**Files:**

- Modify: `src/renderer/src/lib/pipeline.ts` — `captureScreen` (line 822), `captureInstruction` (line 1109)
- Modify: `src/main/ipc.ts` — expose vision support for the resolved assessment provider
- Test: `src/shared/assessment.test.ts`

**Interfaces:**

- Consumes: `providerSupportsVision` (already exported from `src/main/openai-compat.ts`), Task 7's routing.
- Produces: nothing new.

A screenshot is a coding question by presumption while armed — you only screenshot something you need read carefully — so it does not go through `looksLikeCodingQuestion`. The constraint is vision support.

- [x] **Step 1: Write the failing test**

```ts
test('a capture is an assessment question whenever the mode is armed', () => {
  assert.equal(captureRouting({ assessmentEnabled: true } as never, true).assessment, true)
})

test('a capture falls back when the assessment provider cannot see', () => {
  const r = captureRouting({ assessmentEnabled: true } as never, false)
  assert.equal(r.assessment, false)
  assert.equal(r.fellBack, true)
})

test('a disarmed capture behaves exactly as it does today', () => {
  const r = captureRouting({ assessmentEnabled: false } as never, true)
  assert.equal(r.assessment, false)
  assert.equal(r.fellBack, false)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/assessment.test.ts`
Expected: FAIL — `captureRouting` is not exported.

- [x] **Step 3: Write minimal implementation**

Add to `src/shared/assessment.ts`:

```ts
export interface CaptureRouting {
  assessment: boolean
  /** True when the mode was armed but the provider cannot accept an image. */
  fellBack: boolean
}

/**
 * A screenshot is presumed to be a coding question while the mode is armed --
 * you only screenshot something you need read carefully -- so it skips the
 * classifier. The one gate is vision support.
 *
 * `fellBack` exists so the card can say so. A silent fallback would leave the
 * user believing they were getting the accurate model.
 */
export function captureRouting(s: HueSettings, providerHasVision: boolean): CaptureRouting {
  if (!s.assessmentEnabled) return { assessment: false, fellBack: false }
  return { assessment: providerHasVision, fellBack: !providerHasVision }
}
```

In `ipc.ts`, add a handler returning whether the resolved assessment provider supports vision, and expose it in `preload/index.ts` as `window.hue.llm.assessmentVision()`. In `captureScreen`, call it, apply `captureRouting`, set `role` accordingly, and when `fellBack` is true surface a one-line note through the existing error/status callback rather than silently continuing.

`captureInstruction` gains the assessment shape when routing says so.

- [x] **Step 4: Run tests**

Run: `npm run typecheck && npm test`
Expected: clean and green.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/shared/assessment.ts src/shared/assessment.test.ts src/renderer/src/lib/pipeline.ts src/main/ipc.ts src/preload/index.ts
git add -A
git commit -m "feat(assessment): screen captures route to the assessment provider"
```

---

### Task 9: Render the code beat

**Files:**

- Modify: `src/renderer/src/App.tsx` (the beat renderer around line 239)
- Modify: `src/renderer/src/assets/main.css`

**Interfaces:**

- Consumes: `isCodeBeat`, `BEAT_LABEL_TEXT` (Task 3).
- Produces: nothing.

No syntax highlighting — see Global Constraints. Monospace with the step numbers carrying the structure.

- [x] **Step 1: Add the CSS**

In `src/renderer/src/assets/main.css`, near the other beat rules:

```css
/* A code beat is the one surface in the app that is not read aloud, so it is
   the one place where monospace, preserved whitespace and horizontal scrolling
   are right. `pre-wrap` would reflow the block and break the alignment that
   makes it readable at a glance, so the block scrolls in its own container and
   the page never does. */
.beat-code {
  margin: 6px 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-card-s);
  background: var(--bg-elevated);
  font-family: ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre;
  overflow-x: auto;
  tab-size: 2;
}
```

- [x] **Step 2: Render it**

In the beat renderer in `App.tsx`, branch on `isCodeBeat(beat)` and emit `<pre className="beat-code">{beat.text}</pre>` instead of the prose paragraph path. Keep the margin tag rendering unchanged — `BEAT_LABEL_TEXT.code` already reads "do not read aloud".

- [x] **Step 3: Add the override control**

Below the answer, render a single `link-btn` reading `Answer as code` when the last answer was not an assessment answer, and `Answer normally` when it was. Clicking re-sends the same question through the other path by calling the pipeline's existing re-answer entry point with the routing forced.

This is the escape hatch the classifier's accuracy depends on — see spec §2. It is not optional.

- [x] **Step 4: Verify by rendering**

Run: `npm run build`
Expected: builds clean.

Then verify visually rather than by inspection. Write a throwaway HTML harness that links `base.css` + `main.css` and contains a `.beat-code` block with indented code, and screenshot it with Electron:

```bash
npx electron scratch/shot.cjs preview.html preview.png 1000 700
```

Confirm indentation is preserved, long lines scroll inside the block, and the page itself does not scroll horizontally. Delete the harness afterwards.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/renderer/src/App.tsx src/renderer/src/assets/main.css
git add -A
git commit -m "feat(assessment): render a code beat verbatim"
```

---

### Task 10: The chip and the hotkey

**Files:**

- Modify: `src/renderer/src/App.tsx` (card header)
- Modify: `src/main/hotkeys.ts`
- Modify: `src/main/ipc.ts` (rebind on change, mirroring the existing hotkey block at line ~72)
- Modify: `src/renderer/src/assets/main.css`

**Interfaces:**

- Consumes: `assessmentEnabled`, `assessmentHotkey` (Task 5).
- Produces: nothing.

- [x] **Step 1: Register the hotkey**

In `hotkeys.ts`, add `assessmentHotkey` alongside `summonHotkey`, `startSessionHotkey` and `captureScreenHotkey`, using the identical encoding (accelerator string or `Mouse:<Button>`). On fire, flip `assessmentEnabled` in settings and notify the renderer over a new `hue:assessment:changed` event.

In `ipc.ts`, add `next.assessmentHotkey !== prev.assessmentHotkey` to the existing condition that calls `applyHotkeys()`.

- [x] **Step 2: Add the chip**

In the card header in `App.tsx`, render a small button showing the state:

```tsx
<button
  type="button"
  className={assessmentOn ? 'assess-chip assess-chip--on' : 'assess-chip'}
  aria-pressed={assessmentOn}
  title="Answer coding questions with code and steps"
  onClick={toggleAssessment}
>
  assess
</button>
```

- [x] **Step 3: Style it**

```css
/* Armed state must be visible at a glance: this mode changes what every answer
   looks like and which provider is billed, so it cannot be invisible. */
.assess-chip {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition:
    background 200ms var(--ease-out),
    color 200ms var(--ease-out),
    border-color 200ms var(--ease-out);
}
.assess-chip:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.assess-chip--on {
  background: var(--accent-tint-strong);
  border-color: var(--accent-border);
  color: var(--text);
}
.assess-chip:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 2px;
}
```

- [x] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [x] **Step 5: Commit**

```bash
npx prettier --write src/renderer/src/App.tsx src/main/hotkeys.ts src/main/ipc.ts src/renderer/src/assets/main.css
git add -A
git commit -m "feat(assessment): a visible toggle and a global hotkey"
```

---

### Task 11: Settings UI and manual verification

**Files:**

- Modify: `src/renderer/src/components/Settings.tsx` (Interview category, beside Mode and Answering)
- Modify: `src/renderer/src/lib/settingsNav.ts` (search keywords)
- Test: `src/renderer/src/lib/settingsNav.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

In `settingsNav.test.ts`:

```ts
test('assessment mode is findable by the words people use for it', () => {
  for (const term of ['assessment', 'coding', 'algorithm', 'leetcode']) {
    assert.ok(visibleSections('audio', term).has('assessment'), `no hit for ${term}`)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/renderer/src/lib/settingsNav.test.ts`
Expected: FAIL — no `assessment` section is registered.

- [ ] **Step 3: Implement**

Add to `SETTINGS_SECTIONS` in `settingsNav.ts`:

```ts
  {
    id: 'assessment',
    category: 'interview',
    title: 'Assessment mode',
    keywords: 'coding code algorithm leetcode technical whiteboard hackerrank codepad complexity'
  },
```

Add `'assessment'` to `SectionIconName` in `SectionIcon.tsx` with a glyph (two chevrons, `<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>`), and add a section in `Settings.tsx` under the Interview category holding: the armed checkbox bound to `assessmentEnabled`, the provider select bound to `assessmentProvider` (with an explicit "Same as drafting" option for `''`), and the hotkey field bound to `assessmentHotkey` using the same control the other three hotkeys use.

Wrap the section in `className={sectionClass('assessment')}` like every other section.

- [ ] **Step 4: Run the full suite and verify manually**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: typecheck clean; lint shows only the pre-existing `_omitted` error in `memory-policy.test.ts`; suite green; build clean.

Then verify the whole feature end to end, which no unit test covers:

1. `npm run dev`, open Settings, set an assessment provider with a real key.
2. Arm the chip. Confirm it reads as armed.
3. Speak "how would you implement a debounce function". Confirm: steps appear, a code block appears with indentation intact, nothing is spoken, and the grounding marker reads "general knowledge" rather than a warning.
4. Speak "tell me about a time you disagreed with a colleague". Confirm a normal spoken answer with `## what`.
5. Press the override on that answer. Confirm it re-answers as code.
6. Disarm. Confirm both questions behave as they did before this feature.
7. Set the assessment provider to a text-only one, capture a screen. Confirm the fallback note appears rather than a silent downgrade.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/renderer/src/components/Settings.tsx src/renderer/src/lib/settingsNav.ts src/renderer/src/lib/settingsNav.test.ts src/renderer/src/components/SectionIcon.tsx
git add -A
git commit -m "feat(assessment): settings, search terms, and the armed toggle"
```

---

## After the plan

Assessment mode adds capability, so by `docs/Versioning.md` it is a **numbered** release, not a lettered one: cut it as **1.6** (`package.json` `1.6.0`), commit as `chore: 1.6`, then `npm run build:win`. Bump before building, never after.

Risk 2 in the spec — latency — is still unmeasured. Before tuning anything, add a timing log around the assessment stream and read a real number.
