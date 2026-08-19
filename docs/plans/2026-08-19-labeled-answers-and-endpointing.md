# Labelled answers and endpointing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Hue answering half a question, and give the answer labelled sections with a real-life scenario as its second half.

**Architecture:** Two new pure modules in `src/shared/` — `endpointing.ts` holds a finished VAD segment briefly and merges a continuation, and `answer-beats.ts` parses labelled sections out of a streaming answer. Both follow the discipline `speculation.ts` sets: no timers, no I/O, no browser globals, `now` passed in, so the whole behaviour matrix runs under `node --test`. The system prompt is restructured from one run-on paragraph into named sections so the output contract stops losing to a contradicting rule buried beside it.

**Tech Stack:** TypeScript, Electron, React, `node:test` + `node:assert/strict`, onnxruntime-web (Silero VAD), Whisper.

**Spec:** [`docs/specs/2026-08-19-labeled-answers-and-endpointing-design.md`](../specs/2026-08-19-labeled-answers-and-endpointing-design.md)

## Global Constraints

- **This project is not under version control.** There is no `.git` anywhere up the tree. Every task therefore ends in a **Checkpoint** step (typecheck + tests) rather than a commit. If you want commits, run Task 0 first; it is optional and nothing else depends on it.
- **Run all commands from `hue-desktop/`**, not the repo root.
- Full test suite: `npm test` (which is `node --test src/**/*.test.ts`).
- Single file: `node --test src/shared/<name>.test.ts`.
- Typecheck: `npm run typecheck` (runs both the node and web projects).
- Tests import with an explicit `.ts` extension: `from './endpointing.ts'`. Match the existing files exactly.
- Modules in `src/shared/` **must not import browser or Electron globals.** They are loaded by plain `node --test`, which is the entire reason they live there.
- **No em dashes or en dashes in `src/shared/answer-shape.ts`.** `answer-shape.test.ts` enforces this and the file's own header explains why it has been got wrong before. Use a comma, a colon, or a full stop.
- Do not change `redemptionMs`, `minSpeechMs`, or `preSpeechPadMs` in `pipeline.ts`. The spec explains why endpointing replaces tuning them.
- Do not change `minWords` or `stableMs` in `speculation.ts`. Task 9 adds the instrument that should precede any such change.

---

### Task 0 (optional): Put the project under version control

Skip this entirely if you do not want git. Nothing later depends on it.

**Files:**
- Create: `.git/` (via `git init`), at the repo root `C:\dev-projects\hue-ai-companion`

- [ ] **Step 1: Confirm there is no repo already**

Run: `git rev-parse --is-inside-work-tree`
Expected: `fatal: not a git repository`

- [ ] **Step 2: Check the ignore file covers secrets before anything is staged**

Run: `cat ../.gitignore`
Expected: it must list `node_modules` and `.env`. **`groq-apikey.txt` at the repo root holds a live API key in plaintext — it must be ignored before the first commit, and the key should be rotated regardless.** If the file is not listed, add it:

```bash
echo "groq-apikey.txt" >> ../.gitignore
```

- [ ] **Step 3: Initialise and make the baseline commit**

```bash
git -C .. init
git -C .. add -A
git -C .. status --short | head -30
```

Read that output before committing. If `groq-apikey.txt` or any `node_modules` path appears, stop and fix `.gitignore` first.

```bash
git -C .. commit -m "chore: baseline before labelled answers and endpointing work"
```

- [ ] **Step 4: Checkpoint**

Run: `git -C .. log --oneline -1`
Expected: one commit.

---

### Task 1: `endpointing.ts` — hold a final and merge a continuation

The core repair. A VAD segment ending is no longer the end of the question.

**Files:**
- Create: `src/shared/endpointing.ts`
- Test: `src/shared/endpointing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface EndpointConfig { holdMs: number; maxHeldSegments: number }`
  - `const DEFAULT_ENDPOINT_CONFIG: EndpointConfig` (`holdMs: 700`, `maxHeldSegments: 3`)
  - `type HoldDecision = { kind: 'hold'; until: number } | { kind: 'complete'; text: string }`
  - `class EndpointBuffer` with:
    - `constructor(config?: Partial<EndpointConfig>)`
    - `onSegmentFinal(text: string, now: number): HoldDecision`
    - `onSpeechStart(now: number): boolean` — true when this is a continuation of a held question
    - `onHoldExpired(now: number): { text: string } | null`
    - `reset(): void`
    - `get heldText(): string`

- [ ] **Step 1: Write the failing test**

Create `src/shared/endpointing.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EndpointBuffer, DEFAULT_ENDPOINT_CONFIG } from './endpointing.ts'

test('a lone segment completes when the hold expires', () => {
  const buf = new EndpointBuffer()
  const decision = buf.onSegmentFinal('what is your greatest weakness?', 0)
  assert.deepEqual(decision, { kind: 'hold', until: DEFAULT_ENDPOINT_CONFIG.holdMs })
  assert.deepEqual(buf.onHoldExpired(DEFAULT_ENDPOINT_CONFIG.holdMs), {
    text: 'what is your greatest weakness?'
  })
})

// The defect this module exists for. One sentence, one pause, two VAD segments.
test('the screenshot case reassembles into one question', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('Walk me through your brass.', 0)
  assert.equal(buf.onSpeechStart(400), true)
  buf.onSegmentFinal('when you are testing a new endpoint for the first time.', 2500)
  assert.deepEqual(buf.onHoldExpired(3200), {
    text: 'Walk me through your brass. when you are testing a new endpoint for the first time.'
  })
})

test('speech after the hold has passed is not a continuation', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('tell me about a time you disagreed with your manager.', 0)
  assert.equal(buf.onSpeechStart(1500), false)
})

test('nothing held means nothing to complete', () => {
  const buf = new EndpointBuffer()
  assert.equal(buf.onHoldExpired(5000), null)
})

// A talkative interviewer must not defer the answer without bound, for the same
// reason INTERIM_MAX_SAMPLES exists in the pipeline.
test('the segment cap completes rather than holding again', () => {
  const buf = new EndpointBuffer({ maxHeldSegments: 2 })
  assert.equal(buf.onSegmentFinal('one', 0).kind, 'hold')
  buf.onSpeechStart(100)
  const decision = buf.onSegmentFinal('two', 500)
  assert.deepEqual(decision, { kind: 'complete', text: 'one two' })
  // Completing clears the buffer: the next question starts empty.
  assert.equal(buf.heldText, '')
})

test('reset drops a held question', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('half a question', 0)
  buf.reset()
  assert.equal(buf.onHoldExpired(700), null)
})

test('an empty segment does not extend the hold with blank text', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('a real question here', 0)
  buf.onSpeechStart(200)
  buf.onSegmentFinal('   ', 900)
  assert.deepEqual(buf.onHoldExpired(1600), { text: 'a real question here' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/endpointing.test.ts`
Expected: FAIL — `Cannot find module './endpointing.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/endpointing.ts`:

```ts
/**
 * When is a question actually over?
 *
 * The VAD answers "when the speaker stops for `redemptionMs`", and that answer
 * is wrong in the one case that matters most. An interviewer asking "walk me
 * through your brass tacks, when you are testing a new endpoint for the first
 * time" pauses in the middle of the sentence. The VAD closes the segment on the
 * breath, Hue answers the five-word fragment, and the second half arrives as a
 * separate question. Both answers are wrong and the user reads one of them
 * aloud.
 *
 * So a finished segment is held rather than shipped. If speech resumes inside
 * the hold, it is the back half of the same question and the two are joined.
 *
 * The gate is timing, not grammar, because the structure of an interview does
 * the work: after the interviewer genuinely finishes, the *candidate* talks.
 * Interviewer speech resuming a few hundred milliseconds later is essentially
 * never a new question. Punctuation cannot carry this decision. Whisper stamps a
 * confident full stop onto fragments, and "Walk me through your brass." has one.
 *
 * The hold costs no perceived latency when speculation is on, because the draft
 * is already in flight and still valid throughout it. That is the point:
 * speculation is not only a latency win, it is what buys the budget to endpoint
 * accurately.
 *
 * Pure, for the same reason `speculation.ts` is pure. No timers, no I/O, no
 * clock reads. `now` is passed in; the caller owns the timer.
 */

export interface EndpointConfig {
  /** Speech resuming within this of the last segment's end continues the question. */
  holdMs: number
  /**
   * Segments that may be joined into one question.
   *
   * A VAD segment is normally a sentence, but nothing guarantees it. An
   * interviewer who talks continuously, or line noise that keeps re-opening the
   * gate, would otherwise defer the answer indefinitely.
   */
  maxHeldSegments: number
}

export const DEFAULT_ENDPOINT_CONFIG: EndpointConfig = {
  holdMs: 700,
  maxHeldSegments: 3
}

export type HoldDecision =
  /** Wait until `until`. If nothing resumes by then, the question is over. */
  | { kind: 'hold'; until: number }
  /** Ship this now. Only returned when the segment cap is reached. */
  | { kind: 'complete'; text: string }

export class EndpointBuffer {
  private readonly config: EndpointConfig
  private segments: string[] = []
  private lastSegmentEndedAt = 0

  constructor(config: Partial<EndpointConfig> = {}) {
    this.config = { ...DEFAULT_ENDPOINT_CONFIG, ...config }
  }

  /** The question assembled so far. Empty when nothing is held. */
  get heldText(): string {
    return this.segments.join(' ')
  }

  /**
   * A VAD segment produced a final transcript.
   *
   * Blank finals are dropped rather than joined: Whisper emits one for the
   * breath that ends a question, and joining it would pad the question with
   * whitespace for nothing. The hold is still extended, because the breath is
   * exactly the moment a continuation is about to arrive.
   */
  onSegmentFinal(text: string, now: number): HoldDecision {
    const trimmed = text.trim()
    if (trimmed.length > 0) this.segments.push(trimmed)
    this.lastSegmentEndedAt = now

    if (this.segments.length >= this.config.maxHeldSegments) {
      const assembled = this.heldText
      this.reset()
      return { kind: 'complete', text: assembled }
    }
    return { kind: 'hold', until: now + this.config.holdMs }
  }

  /**
   * Speech resumed. True when it continues the held question.
   *
   * The caller cancels its pending hold timer on true, and treats false as the
   * ordinary start of a new utterance.
   */
  onSpeechStart(now: number): boolean {
    if (this.segments.length === 0) return false
    return now - this.lastSegmentEndedAt < this.config.holdMs
  }

  /** The hold deadline passed. Returns the assembled question, or null if none. */
  onHoldExpired(_now: number): { text: string } | null {
    if (this.segments.length === 0) return null
    const assembled = this.heldText
    this.reset()
    return { text: assembled }
  }

  reset(): void {
    this.segments = []
    this.lastSegmentEndedAt = 0
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/shared/endpointing.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, whole suite green. (If Task 0 was run: `git -C .. add -A && git -C .. commit -m "feat(endpointing): hold a final and merge a continuation"`)

---

### Task 2: A length-ratio floor on `commits()`

Latent today. Task 3 makes it fire routinely, so it is fixed before the wiring lands.

**Files:**
- Modify: `src/shared/speculation.ts` (the `commits()` function, near the end of the file)
- Test: `src/shared/speculation.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `export const MAX_PREFIX_GROWTH = 1.75` from `speculation.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/shared/speculation.test.ts`:

```ts
import { MAX_PREFIX_GROWTH } from './speculation.ts'

// The exact case the endpoint hold produces. A draft fired on a five-word
// fragment must not commit against the fourteen-word question it turned out to
// be the opening of: that is the product's worst failure (confidently rendering
// the answer to a question nobody asked) reached through the commit gate.
test('a prefix that tripled in length does not commit', () => {
  const h = harness()
  fireOn(h, 'walk me through your brass')
  const commands = h.scheduler.onFinal(
    'walk me through your brass tacks when you are testing a new endpoint for the first time',
    'interviewer',
    h.clock.now
  )
  assert.equal(commands[0]?.kind, 'regenerate')
})

// The regression the prefix rule was written to prevent must stay prevented:
// token F1 scores this pair 0.84 purely because the final is longer, which is a
// length penalty dressed up as a similarity score.
test('a prefix that added a few trailing words still commits', () => {
  const h = harness()
  fireOn(h, 'tell me about a time you disagreed with your manager')
  const commands = h.scheduler.onFinal(
    'tell me about a time you disagreed with your manager on something',
    'interviewer',
    h.clock.now
  )
  assert.equal(commands[0]?.kind, 'commit')
})

test('the growth ceiling is the documented one', () => {
  assert.equal(MAX_PREFIX_GROWTH, 1.75)
})
```

**Note for the implementer:** `harness()` and `fireOn()` are the existing helpers in this file. Read the top of `speculation.test.ts` first and use its established fixture shape; if `fireOn` does not exist under that name, drive the scheduler through `onInterim` + `onTick` the way the neighbouring tests do, advancing the clock past `stableMs` (400 ms) so the fire actually triggers.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/speculation.test.ts`
Expected: FAIL — the tripled-prefix case returns `commit`, and `MAX_PREFIX_GROWTH` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/shared/speculation.ts`, add the constant above `commits()`:

```ts
/**
 * How much longer than the fire text a prefix-extended final may be and still
 * commit.
 *
 * The prefix rule below exists because token F1 penalises a final that merely
 * got longer: "tell me about a time you disagreed with your manager" extended by
 * two words scores 0.84 and would be thrown away though the draft answers it
 * perfectly. That reasoning holds for a few trailing words and collapses at
 * scale. A draft fired on "walk me through your brass" is a clean prefix of
 * "walk me through your brass tacks when you are testing a new endpoint for the
 * first time" and answers an entirely different question.
 *
 * Beyond this ratio the pair falls through to F1, which refuses and regenerates.
 */
export const MAX_PREFIX_GROWTH = 1.75
```

Then change the prefix branch of `commits()`:

```ts
function commits(firedOn: string, final: string, threshold: number): boolean {
  const fired = tokens(firedOn)
  const ended = tokens(final)
  if (
    fired.length > 0 &&
    ended.length >= fired.length &&
    ended.length <= fired.length * MAX_PREFIX_GROWTH
  ) {
    let prefix = true
    for (let i = 0; i < fired.length; i++) {
      if (ended[i] !== fired[i]) {
        prefix = false
        break
      }
    }
    if (prefix) return true
  }
  return tokenF1(firedOn, final) >= threshold
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/shared/speculation.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: green. (Commit: `fix(speculation): do not commit a prefix that tripled in length`)

---

### Task 3: Wire endpointing into the pipeline

**Files:**
- Modify: `src/renderer/src/lib/pipeline.ts` — imports, fields, `onSpeechStart`, `onSpeechEnd`, `stop`, `clearHistory`, and the `onVADMisfire` handler in `startCapture`

**Interfaces:**
- Consumes: `EndpointBuffer`, `DEFAULT_ENDPOINT_CONFIG` from Task 1.
- Produces: no new exports. `VoicePipeline` behaviour only.

There is no unit test for this task: `pipeline.ts` imports browser globals and cannot load under `node --test`, which is the stated reason the logic lives in `shared/` at all. Task 1 is where the behaviour is pinned. Verification here is typecheck plus the manual session in Step 5.

- [ ] **Step 1: Add the import and the fields**

At the top of `pipeline.ts`, beside the existing `speculation` import:

```ts
import { EndpointBuffer } from '../../../shared/endpointing'
```

Add fields next to the speculation ones (near `private specText = ''`):

```ts
  /**
   * Holds a finished segment briefly so a mid-sentence pause cannot split one
   * question into two. Only constructed in companion mode, where the incoming
   * voice is the interviewer's; in interviewer mode the incoming voice is the
   * user answering and there is no question to assemble.
   */
  private endpoint: EndpointBuffer | null = null
  /** The pending hold. Cleared by a continuation, by expiry, and by teardown. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null
```

In the constructor, beside the scheduler construction:

```ts
    if (settings.hueMode === 'companion') this.endpoint = new EndpointBuffer()
```

- [ ] **Step 2: Cancel the hold when speech resumes**

Replace `onSpeechStart`:

```ts
  private onSpeechStart(): void {
    // Barge-in: the user started talking over the assistant.
    if (this.state === 'thinking' || this.state === 'speaking') {
      this.abortResponse()
    }
    // Speech inside the hold is the back half of the question already held, not
    // a new one. Cancel the pending expiry and let the segment accumulate.
    if (this.endpoint?.onSpeechStart(Date.now())) this.clearHoldTimer()
    this.beginSegment()
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
  }
```

- [ ] **Step 3: Route the final through the buffer**

In `onSpeechEnd`, replace the block that currently begins `if (this.scheduler) {` with a call into the buffer. The filler gate and everything above it stays exactly as it is:

```ts
    // The question may not be over. Hold this segment; if speech resumes inside
    // the hold, onSpeechStart cancels the expiry and the next final joins it.
    if (this.endpoint) {
      const decision = this.endpoint.onSegmentFinal(text, Date.now())
      this.clearHoldTimer()
      if (decision.kind === 'complete') {
        this.resolveQuestion(decision.text)
        return
      }
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null
        const done = this.endpoint?.onHoldExpired(Date.now())
        if (done) this.resolveQuestion(done.text)
      }, decision.until - Date.now())
      return
    }

    this.resolveQuestion(text)
  }

  /**
   * The question is genuinely over. Everything that used to sit at the bottom of
   * onSpeechEnd, moved here so the hold can call it later.
   */
  private resolveQuestion(text: string): void {
    if (this.scheduler) {
      const commands = this.scheduler.onFinal(text, this.speakerOfIncomingSpeech(), Date.now())
      if (commands.length > 0) {
        this.applyFinalCommands(commands, text)
        return
      }
      // Empty means the scheduler declined the turn entirely (self speech). It
      // cannot happen while the scheduler is companion-only, but falling through
      // to the plain path is the safe reading if that ever changes: a question
      // answered late beats a question dropped.
    }

    this.messages.push({ role: 'user', content: text })
    this.startResponse({ speak: this.speakResponses, maxTokens: 500 })
  }
```

- [ ] **Step 4: Tear the hold down everywhere the session does**

A pending timer that outlives its session fires an answer into a stopped pipeline. Add `this.clearHoldTimer()` and `this.endpoint?.reset()` to each of:

- `stop()` — beside the existing `this.scheduler?.reset()`
- `clearHistory()` — beside the existing `this.scheduler?.reset()`
- `releaseAfterFailedStart()` — beside the existing `this.endSegment()`
- the `onVADMisfire` handler in `startCapture()` — beside `this.scheduler?.reset()`

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: clean.

Then run the app and confirm the repaired behaviour by hand, because this is the one task whose deliverable is not unit-testable:

Run: `npm run dev`

With companion mode and a microphone source, say — as one sentence with a clear pause in the middle — *"walk me through your brass tacks ... when you are testing a new endpoint for the first time"*. Expected: **one** transcript line containing the whole sentence, and **one** answer. Before this task it produced two of each.

Then turn **speculative drafting off** in settings and repeat. Expected: identical merging behaviour, just slower to answer. The endpoint buffer is independent of the scheduler, and a session with speculation off must not regress — that is the configuration every existing install is in until Task 8 runs.

- [ ] **Step 6: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: green. (Commit: `feat(pipeline): hold a final so a pause cannot split a question`)

---

### Task 4: The labelled answer shape

**Files:**
- Modify: `src/shared/answer-shape.ts`
- Modify: `src/shared/answer-shape.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const LABELLED_SHAPE: string` from `answer-shape.ts`. `FOUR_BEAT_SHAPE` is **removed**; `answerShapeFor('practice')` now returns `LABELLED_SHAPE`.

**Remember the constraint:** no em dashes or en dashes anywhere in `answer-shape.ts`.

- [ ] **Step 1: Write the failing test**

In `src/shared/answer-shape.test.ts`, replace the `'practice mode gets the four beats'` test and update the import. Leave the star, live, and dash tests in place — the dash test must now cover the new string, which it does automatically if it iterates the module's exports; if it names `FOUR_BEAT_SHAPE` explicitly, change that reference to `LABELLED_SHAPE`.

```ts
import { answerShapeFor, LABELLED_SHAPE } from './answer-shape.ts'

test('practice mode gets the labelled sections', () => {
  assert.equal(answerShapeFor('practice'), LABELLED_SHAPE)
})

test('the shape names every marker the parser accepts, and no others', () => {
  for (const label of ['## what', '## why', '## how', '## when', '## scenario']) {
    assert.ok(LABELLED_SHAPE.includes(label), `missing ${label}`)
  }
})

// The scenario half must be optional in the prompt itself, or a model with an
// empty story bank is under standing instructions to invent one to fill it.
test('the shape permits omitting the scenario when no story fits', () => {
  assert.match(LABELLED_SHAPE, /omit the "## scenario" section entirely/)
})

test('the shape caps the length, because the surface is read at a glance', () => {
  assert.match(LABELLED_SHAPE, /120 words/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/answer-shape.test.ts`
Expected: FAIL — `LABELLED_SHAPE` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/shared/answer-shape.ts`, delete `FOUR_BEAT_SHAPE` and its doc comment, and add:

```ts
/**
 * Labelled sections, and a real scenario as the second half.
 *
 * The glance surface is read aloud while the interviewer watches, so the user
 * looks down for a fraction of a second and has to find their place again. The
 * markers give the eye something to land on, and they are stripped by
 * `answer-beats.ts` before anything reaches the screen: what the user reads
 * aloud is the prose under them, never the marker itself. Same contract
 * `story_id` already keeps.
 *
 * The scenario is deliberately optional. A mandatory half is a standing
 * instruction to invent one when the story bank has nothing that fits, which is
 * the exact failure the grounding rules exist to prevent.
 *
 * No em dashes or en dashes in this string. See the header of this file.
 */
export const LABELLED_SHAPE =
  'Write the answer in labelled sections. Each section begins with a marker alone on its own ' +
  'line: "## what", "## why", "## how", "## when", or "## scenario". Use only those five ' +
  'markers, and choose the two or three that genuinely fit the question rather than using all ' +
  'of them. ' +
  'Under each marker write one or two sentences of plain speakable prose in the first person. ' +
  'The app strips the markers before the user sees the answer, so never mention them in the ' +
  'prose and never write a heading, a label, a number, or a bullet of your own. ' +
  'The first section must stand alone as a complete answer if the user says nothing else. ' +
  'Close with "## scenario": one real, specific moment from the background below, named ' +
  'concretely rather than described in general terms. Size the answer so the scenario is about ' +
  'half of it and the sections above are the other half. ' +
  'If no story in the background genuinely fits the question, omit the "## scenario" section ' +
  'entirely and let the answer be the sections above. Never invent a scenario to fill the ' +
  'space, and never bend a story that does not apply. ' +
  'Keep the whole answer under about 120 words. It is read aloud at a glance, and a longer ' +
  'answer is one the user cannot find their place in.'
```

Update `answerShapeFor` so `default:` returns `LABELLED_SHAPE`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/shared/answer-shape.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: green. `pipeline.ts` imports `answerShapeFor`, not `FOUR_BEAT_SHAPE`, so removing the old constant does not break it. If typecheck says otherwise, fix the reference it names. (Commit: `feat(answer-shape): labelled sections with an optional scenario half`)

---

### Task 5: Restructure the system prompt into sections

The cause of the screenshot defects, and the reason Task 4 alone would not have fixed them.

**Files:**
- Modify: `src/renderer/src/lib/pipeline.ts` — `buildCompanionPrompt` (around lines 1076-1216)

**Interfaces:**
- Consumes: `answerShapeFor` (Task 4).
- Produces: no new exports.

- [ ] **Step 1: Delete the contradiction**

Find the part that currently reads:

> 'Write the answer as plain speakable prose the user can say start to finish: no headings, no labels, no "Example:" prefix, no bullet points, and no numbering. Weave one concrete, real-life example directly into the answer so it backs up the point as part of the flow, the way a person naturally drops in a specific moment while speaking.'

**Delete it in full.** Every clause of it now lives in `LABELLED_SHAPE`, and its "as part of the flow" wording is what beat the four-beat instruction: the model was told to weave into one flow and to write separate blocks, in the same paragraph, and it chose flow.

- [ ] **Step 2: Group the remaining parts into named sections**

Replace the flat `parts` array and its `parts.join(' ')` with named groups. Keep the wording of every surviving instruction verbatim — this task changes structure and ordering, not content.

```ts
/**
 * The system prompt, in sections.
 *
 * It used to be `parts.join(' ')`: roughly 1200 words of rules fused into one
 * undifferentiated paragraph, with the shape instruction appended last. Two of
 * those rules contradicted each other (weave the example into the flow, versus
 * write separate blocks) and the model resolved it toward flow, so the answer
 * arrived as an unbroken wall. The never-ask-for-clarification rule and the
 * length rule were buried in the same paragraph and were ignored in the same
 * response.
 *
 * `answer-shape.ts` states the underlying principle in its own header: a
 * concrete instruction outweighs an abstract one, so a prompt that argues with
 * itself resolves unpredictably. Sections are how the output contract stops
 * competing with a rule that happens to sit beside it.
 *
 * Section headers use `=== NAME ===` rather than `##` deliberately. `##` is the
 * answer's own marker syntax, and the prompt must not teach a second meaning for
 * it in the same breath as defining the first.
 */
function section(title: string, parts: Array<string | null>): string | null {
  const body = parts.filter((p): p is string => p !== null && p.length > 0)
  if (body.length === 0) return null
  return `=== ${title} ===\n${body.join('\n\n')}`
}

function buildCompanionPrompt(s: HueSettings): string {
  const bundle = parseProfileBundle(s.profileBundleJson)
  const job = jobContext(s)
  const brief = parseJobBrief(s.jobBriefJson)
  const briefBlock = brief ? jobBriefPromptBlock(brief) : ''

  const sections = [
    section('ROLE', [
      /* the existing "You are Hue, a real-time interview companion..." part */,
      /* the existing "Lead with the answer..." part */,
      /* the existing "The question is transcribed by speech recognition..." part */
    ]),
    section('VOICE', [
      /* "Make it sound like the user thinking out loud..." */,
      /* "Match the answer to the kind of question..." */,
      /* "Definition questions..." */,
      /* "Say I, not a vague we..." */,
      /* "Make it a strong answer, not just a complete one..." */,
      /* "Skip interview clichés..." */,
      HUMAN_VOICE_GUIDANCE
    ]),
    section('HONESTY', [
      /* "When the question targets something the user may not know..." */,
      /* "Never invent specific facts the user has not given you..." */,
      /* "Never overstate how long the user has worked..." */
    ]),
    section('BACKGROUND', backgroundParts(s, bundle)),
    section('ROLE BEING INTERVIEWED FOR', [
      s.jobTitle ? `The user is interviewing for the role: ${s.jobTitle}.` : null,
      job ? /* the existing "A job posting for this role follows..." part */ : null,
      job,
      briefBlock || null
    ]),
    // Last, and alone in its section. This is the contract the response is
    // judged against, and the evidence says it loses when it shares a paragraph.
    section('OUTPUT CONTRACT', [answerShapeFor(s.interviewMode)])
  ]

  return sections.filter((s): s is string => s !== null).join('\n\n')
}
```

**Implementer note:** the `/* ... */` markers above name the existing strings by their opening words. Move each one across verbatim from the current `parts` array. Do not reword them. `backgroundParts(s, bundle)` is a small helper holding the existing bundle / `resumeSummary` branch, including the two `story_id` instructions, extracted unchanged so `buildCompanionPrompt` stays readable.

**Ordering is load-bearing and must be preserved:** the job posting block must still come *after* the background, because its never-claim rule says a requirement may only be spoken as experience "if it also appears in the candidate's background above". Placed first, "above" resolves to nothing. The brief comes after the posting because it names story ids defined in the background block.

- [ ] **Step 3: Lift the buried rules into the output contract**

The screenshots show two rules being ignored. Both are currently mid-paragraph. Add them to the `OUTPUT CONTRACT` section, before the shape:

```ts
    section('OUTPUT CONTRACT', [
      'Never ask the interviewer for clarification and never say you are unsure what they meant. ' +
        'The user cannot relay a clarifying question mid-call, and an answer that opens by ' +
        'admitting confusion makes the user look lost rather than you. If the transcript is a ' +
        'fragment or is garbled, answer the most likely intended question directly and confidently.',
      answerShapeFor(s.interviewMode)
    ])
```

The length rule now lives in `LABELLED_SHAPE` (Task 4) and needs no second home. Remove the "roughly three to five sentences" clause from the ROLE part when you move it across, so the two do not disagree about length.

- [ ] **Step 4: Verify by inspection**

Run: `npm run typecheck`
Expected: clean.

`buildCompanionPrompt` is not exported and `pipeline.ts` cannot load under `node --test`, so inspect the result in the app. Run `npm run dev`, and in the devtools console confirm the built system prompt:

- shows `=== ROLE ===`, `=== VOICE ===`, `=== HONESTY ===`, `=== BACKGROUND ===`, `=== ROLE BEING INTERVIEWED FOR ===`, `=== OUTPUT CONTRACT ===`, in that order
- contains no "as part of the flow" text anywhere
- contains no "three to five sentences" text anywhere
- ends with the output contract, with nothing after it

Also confirm `=== BACKGROUND ===` appears **before** `=== ROLE BEING INTERVIEWED FOR ===`. The posting's never-claim rule says a requirement may only be spoken as experience "if it also appears in the candidate's background above"; reversed, "above" resolves to nothing and the guard becomes decoration.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: green. (Commit: `refactor(prompt): sections, and delete the flow-versus-blocks contradiction`)

---

### Task 6: `answer-beats.ts` — the streaming-safe parser

**Files:**
- Create: `src/shared/answer-beats.ts`
- Test: `src/shared/answer-beats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type BeatLabel = 'what' | 'why' | 'how' | 'when' | 'scenario'`
  - `const BEAT_LABELS: readonly BeatLabel[]`
  - `interface Beat { label: BeatLabel | null; text: string }`
  - `function parseBeats(raw: string): Beat[]`

- [ ] **Step 1: Write the failing test**

Create `src/shared/answer-beats.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBeats, BEAT_LABELS } from './answer-beats.ts'

test('labelled sections become labelled beats', () => {
  const answer = '## what\nI own the deploy pipeline.\n\n## why\nWe lost a day a week.'
  assert.deepEqual(parseBeats(answer), [
    { label: 'what', text: 'I own the deploy pipeline.' },
    { label: 'why', text: 'We lost a day a week.' }
  ])
})

test('an unmarked answer degrades to unlabelled beats', () => {
  assert.deepEqual(parseBeats('One block.\n\nAnother block.'), [
    { label: null, text: 'One block.' },
    { label: null, text: 'Another block.' }
  ])
})

test('an unknown marker stays prose', () => {
  const beats = parseBeats('## verdict\nSomething.')
  assert.equal(beats.length, 1)
  assert.equal(beats[0].label, null)
  assert.match(beats[0].text, /verdict/)
})

// The prompt mandates [company] and [X]% placeholders. A parser that ate them
// would silently drop the start of a beat.
test('bracket placeholders are never mistaken for markers', () => {
  const beats = parseBeats('## scenario\n[company] cut load time by [X]%.')
  assert.deepEqual(beats, [{ label: 'scenario', text: '[company] cut load time by [X]%.' }])
})

// The invariant that matters most. The answer streams token by token, and no
// prefix of a marker may ever flash on screen as prose before it resolves.
test('no prefix of a streaming answer ever renders a partial marker', () => {
  const full = '## what\nI own the pipeline.\n\n## scenario\nAt Solarworks I cut it to six minutes.'
  for (let i = 1; i <= full.length; i++) {
    for (const beat of parseBeats(full.slice(0, i))) {
      assert.doesNotMatch(beat.text, /^#/, `partial marker leaked at ${i}: ${beat.text}`)
      assert.doesNotMatch(beat.text, /^#{1,2}\s*(w|s|h)/i, `partial marker leaked at ${i}`)
    }
  }
})

test('a completed beat still renders while the next marker is arriving', () => {
  const beats = parseBeats('## what\nI own the pipeline.\n\n##')
  assert.deepEqual(beats, [{ label: 'what', text: 'I own the pipeline.' }])
})

test('blank input is no beats', () => {
  assert.deepEqual(parseBeats(''), [])
  assert.deepEqual(parseBeats('   \n  '), [])
})

test('the vocabulary is exactly the five the prompt names', () => {
  assert.deepEqual([...BEAT_LABELS], ['what', 'why', 'how', 'when', 'scenario'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/shared/answer-beats.test.ts`
Expected: FAIL — `Cannot find module './answer-beats.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/answer-beats.ts`:

```ts
/**
 * Split a labelled answer into the beats the model marked.
 *
 * The markers are app chrome: `LABELLED_SHAPE` tells the model to write
 * "## what" on a line of its own, and this strips it into a tag the card renders
 * in the margin. What the user reads aloud is the prose underneath, never the
 * marker. Same contract `story_id` keeps, for the same reason: the surface is
 * read aloud under pressure and anything on it that is not speakable is a
 * hazard.
 *
 * Supersedes `paragraphs()` on the answer card. That function stays for the
 * transcript pane, which has no markers.
 *
 * **Streaming safety is the whole difficulty here.** The answer arrives token by
 * token, so at some instant the buffer ends in "#", then "##", then "## wh". If
 * any of those render as prose the card flashes garbage into the middle of a
 * sentence the user is reading aloud. A trailing line that could still become a
 * marker is therefore withheld until its newline lands.
 *
 * Recomputed on every render rather than memoised, exactly as `paragraphs()` is:
 * the answer streams, so a cache would be invalidated on every token anyway.
 */

export type BeatLabel = 'what' | 'why' | 'how' | 'when' | 'scenario'

/** The closed vocabulary. Anything else on a marker-shaped line stays prose. */
export const BEAT_LABELS: readonly BeatLabel[] = ['what', 'why', 'how', 'when', 'scenario']

export interface Beat {
  /** null when the model wrote no marker, or wrote one outside the vocabulary. */
  label: BeatLabel | null
  text: string
}

/** A marker: one or two hashes, one vocabulary word, nothing else on the line. */
const MARKER = /^#{1,2}[ \t]*([a-z]+)[ \t]*$/i

/** A line that is not yet a marker but could still become one. */
const PARTIAL_MARKER = /^#{1,2}[ \t]*[a-z]*$/i

function isLabel(word: string): word is BeatLabel {
  return (BEAT_LABELS as readonly string[]).includes(word)
}

/**
 * Drop a trailing line that has not finished arriving and might be a marker.
 *
 * Only the last line can be incomplete, and only when the buffer does not end in
 * a newline. Everything before it is settled.
 */
function withholdPartialMarker(raw: string): string {
  if (raw.endsWith('\n')) return raw
  const cut = raw.lastIndexOf('\n')
  const tail = raw.slice(cut + 1).trimStart()
  if (tail.length === 0 || tail[0] !== '#') return raw
  return PARTIAL_MARKER.test(tail) ? raw.slice(0, cut + 1) : raw
}

export function parseBeats(raw: string): Beat[] {
  const text = withholdPartialMarker(raw)
  const beats: Beat[] = []
  let label: BeatLabel | null = null
  let buffer: string[] = []

  const flush = (): void => {
    const body = buffer.join('\n').trim()
    if (body.length > 0) beats.push({ label, text: body })
    buffer = []
  }

  for (const line of text.split('\n')) {
    const match = MARKER.exec(line.trim())
    const word = match ? match[1].toLowerCase() : null
    if (word !== null && isLabel(word)) {
      flush()
      label = word
      continue
    }
    // A blank line separates beats only while the answer is unlabelled. Once a
    // marker has been seen, the markers own the boundaries and a blank line is
    // just spacing inside a beat.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/shared/answer-beats.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: green. (Commit: `feat(answer-beats): streaming-safe parser for labelled sections`)

---

### Task 7: Render labelled beats on the glance card

**Files:**
- Modify: `src/renderer/src/App.tsx:5` (import) and `:978` (the answer card block)
- Modify: `src/renderer/src/assets/main.css` (after the existing `.glance-text p + p` rule, around line 500)

**Interfaces:**
- Consumes: `parseBeats`, `Beat` from Task 6.
- Produces: no new exports.

- [ ] **Step 1: Swap the import**

At `App.tsx:5`, keep `paragraphs` (the transcript at `:1060` still uses it) and add:

```ts
import { paragraphs } from './lib/paragraphs'
import { parseBeats } from '@shared/answer-beats'
```

- [ ] **Step 2: Render the beats with their labels**

Replace the block at `App.tsx:978`:

```tsx
                {/* Index keys, deliberately. A key derived from the text would
                    change on every streamed token and re-mount the whole answer
                    dozens of times a second; see the note on .glance-text in
                    main.css. The list only ever grows at its end. */}
                {parseBeats(latestAnswer.text).map((beat, i) => (
                  <div
                    className={beat.label === 'scenario' ? 'beat beat--scenario' : 'beat'}
                    key={i}
                  >
                    {beat.label && <span className="beat-label">{beat.label}</span>}
                    <p>{beat.text}</p>
                  </div>
                ))}
```

The `beat--scenario` class is what draws the seam between the two halves. `:has()`
cannot select on text content, so the split has to be decided here, where the
label is already known.

- [ ] **Step 3: Style the label margin**

Append to `main.css` after the `.glance-text p + p` rule:

```css
/*
 * A beat and its label.
 *
 * The label is app chrome, never part of what the user says: the model writes
 * "## what" and answer-beats.ts strips it to this tag. It sits in the margin so
 * the eye can find the section it left off in without the label ever entering
 * the line of prose being read aloud.
 */
.beat {
  display: grid;
  grid-template-columns: 4.5ch 1fr;
  column-gap: 1ch;
}

.beat + .beat {
  margin-top: calc(var(--glance-size) * var(--glance-leading) * 0.55);
}

/*
 * Muted, small, and set on the first line's baseline. It must be findable at a
 * glance and must never compete with the prose for attention: the user is
 * reading the prose aloud and the label is only a landmark.
 */
.beat-label {
  font-size: 0.5em;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  /* Nudge onto the first line's optical baseline rather than its box top. */
  padding-top: 0.55em;
  user-select: none;
}

/*
 * The scenario is the other half of the answer, so it gets a rule above it
 * rather than only a wider gap. This is the seam the user's eye jumps to when
 * they have finished the direct answer and want the story.
 */
.beat--scenario {
  margin-top: calc(var(--glance-size) * var(--glance-leading) * 0.8);
  padding-top: calc(var(--glance-size) * var(--glance-leading) * 0.5);
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
```

Check what the border token is actually called in this stylesheet before using `--border`; grep for `--border` in `main.css` and `base.css` and use the real name, or the literal `rgba(255, 255, 255, 0.12)` if there is none.

- [ ] **Step 4: Verify in the app**

Run: `npm run dev`

Expected: an answer renders with `WHAT` / `WHY` style tags in the left margin and a ruled `SCENARIO` block below. Watch a full answer stream in and confirm **no `#` character ever appears** in the prose, even for a frame. That is the invariant Task 6 Step 1 pins in a unit test; this is the visual confirmation.

- [ ] **Step 5: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: green. (Commit: `feat(glance): render labelled beats with a scenario half`)

---

### Task 8: Latency defaults, the migration, and the wasted IPC hop

**Files:**
- Modify: `src/shared/types.ts` — `HueSettings`, `DEFAULT_SETTINGS`
- Modify: `src/main/settings-migrations.ts` — `migrateSettings`
- Test: `src/main/settings-migrations.test.ts` (append)
- Modify: `src/renderer/src/lib/transcription.ts` — `transcribe`
- Modify: `src/renderer/src/lib/pipeline.ts` — the four `maxTokens: 500` call sites

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HueSettings` gains `speculationOptInApplied: boolean`
  - `transcribe(audio: Float32Array, settings: HueSettings): Promise<TranscriptionResult>` — **signature change**, the settings are now passed in

- [ ] **Step 1: Write the failing migration test**

Append to `src/main/settings-migrations.test.ts`:

```ts
// Flipping the default is not enough on its own: settings.ts merges a saved file
// *over* DEFAULT_SETTINGS, so an existing install would keep speculation off
// forever. The same reasoning the retired-keys migration is built on.
test('an existing install is opted into speculative drafting once', () => {
  const before = {
    ...DEFAULT_SETTINGS,
    speculativeDrafting: false,
    speculationOptInApplied: false
  }
  const after = migrateSettings(before)
  assert.equal(after.speculativeDrafting, true)
  assert.equal(after.speculationOptInApplied, true)
})

// A user who turns it back off must stay off. Without the marker key the
// migration would re-enable it on every launch.
test('a user who turned it off is not re-flipped', () => {
  const before = {
    ...DEFAULT_SETTINGS,
    speculativeDrafting: false,
    speculationOptInApplied: true
  }
  assert.equal(migrateSettings(before).speculativeDrafting, false)
})
```

Add `DEFAULT_SETTINGS` to that file's imports if it is not there already.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/main/settings-migrations.test.ts`
Expected: FAIL — `speculationOptInApplied` does not exist.

- [ ] **Step 3: Add the setting, the default, and the migration**

In `src/shared/types.ts`, add to `HueSettings`:

```ts
  /**
   * Whether the one-time speculative-drafting opt-in has run.
   *
   * Speculation ships on, but a default cannot reach an install that already has
   * a settings file: `settings.ts` merges the saved file over DEFAULT_SETTINGS.
   * The migration flips it once and records that here, so a user who turns it
   * back off is not overruled on the next launch.
   */
  speculationOptInApplied: boolean
```

In `DEFAULT_SETTINGS`, change `speculativeDrafting` and add the marker:

```ts
  speculativeDrafting: true,
  speculationOptInApplied: true,
```

`true` for a fresh install: there is nothing to opt in, so the opt-in is already spent.

Also change the model default:

```ts
  model: 'claude-sonnet-5',
```

**Do not migrate the model.** An existing install keeps whatever it has. Swapping a user's model silently is a quality change made without their consent, and unlike speculation it is not a strict improvement.

In `src/main/settings-migrations.ts`, extend `migrateSettings`. Note the current early return on `stale.length === 0` — the opt-in has to run whether or not there were retired keys:

```ts
export function migrateSettings(settings: HueSettings): HueSettings {
  const record = settings as unknown as Record<string, unknown>
  const next = { ...record }

  for (const key of RETIRED_SETTING_KEYS) delete next[key]

  // One-time speculation opt-in. See HueSettings.speculationOptInApplied.
  if (next.speculationOptInApplied !== true) {
    next.speculativeDrafting = true
    next.speculationOptInApplied = true
  }

  return next as unknown as HueSettings
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/main/settings-migrations.test.ts`
Expected: PASS, including the pre-existing retired-keys tests.

- [ ] **Step 5: Drop the IPC hop from the ASR hot path**

In `src/renderer/src/lib/transcription.ts`, `transcribe` currently opens with `const settings = await window.hue.settings.get()` — an IPC round trip on the latency path for state the caller already holds. Change the signature:

```ts
/**
 * Unified entry point. Picks the best available ASR tier and transcribes.
 *
 * Settings are passed in rather than fetched. This runs the instant the
 * interviewer stops talking, and an IPC round trip here bought nothing: the
 * pipeline already holds the same object in `this.settings`.
 */
export async function transcribe(
  audio: Float32Array,
  settings: HueSettings
): Promise<TranscriptionResult> {
  const tier = resolveTier(settings)
  const t0 = performance.now()
  const text = tier === 'cloud' ? await transcribeCloud(audio) : await transcribeOnDevice(audio)
  return { text, tier, latencyMs: Math.round(performance.now() - t0) }
}
```

In `pipeline.ts`, `onSpeechEnd` calls it as `await transcribe(audio)`. Change to `await transcribe(audio, this.settings)`.

Run: `npm run typecheck`
Expected: clean. If it names another `transcribe(` call site, pass the settings there too.

- [ ] **Step 6: Raise the answer token ceiling**

The scenario half needs room. In `pipeline.ts` change `maxTokens: 500` to `maxTokens: 700` at all four sites: the two `startResponse` calls in `resolveQuestion` and `applyFinalCommands`, the one in `commitSpeculation`'s neighbourhood, and the one in `startSpeculation`.

Leave the `maxTokens: 1024` screen-capture call alone; it is a different surface.

Run: `grep -n "maxTokens: 500" src/renderer/src/lib/pipeline.ts`
Expected: no output.

- [ ] **Step 7: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: green. (Commit: `feat(settings): speculation on by default, sonnet default, drop ASR IPC hop`)

---

### Task 9: Surface the speculation hit rate, and diagnose the grounding chip

Two instruments. Neither changes behaviour, and both answer questions the spec leaves open.

**Files:**
- Modify: `src/renderer/src/lib/pipeline.ts` — `stop()`, and the `applyFinalCommands` commit path

**Interfaces:**
- Consumes: `SpeculationMetrics` (already exported by `speculation.ts`).
- Produces: no new exports.

- [ ] **Step 1: Log the metrics at session end**

`SpeculationMetrics.hitRate` is computed and never read. Its own comment says to tune the thresholds against that number rather than against intuition, so it has to be visible before Task 8's defaults change anything about how often speculation runs.

In `stop()`, before `this.scheduler?.reset()`:

```ts
    if (this.scheduler) {
      const m = this.scheduler.metrics
      console.info(
        `[speculation] questions=${m.questions} fired=${m.fired} committed=${m.committed} ` +
          `aborted=${m.aborted} hitRate=${(m.hitRate * 100).toFixed(0)}% ` +
          `firesPerQuestion=${m.firesPerQuestion.toFixed(2)}`
      )
    }
```

- [ ] **Step 2: Log why grounding resolved as it did**

Spec open question 1: the chip said "Not anchored to your history" on answers that drew on the user's real background. Two possible causes need different fixes, and one line distinguishes them.

In `onAssistantComplete`'s handling — find where `grounding` is resolved in `pipeline.ts` — add:

```ts
    // Diagnosing the "not anchored" chip firing on real history. A bundle absent
    // means the prompt never asked for a story_id and the chip can never say
    // anything else; a bundle present with a null id means the model omitted the
    // citation line, which is an output-contract problem instead.
    console.info(
      `[grounding] bundle=${parseProfileBundle(this.settings.profileBundleJson) ? 'present' : 'absent'} ` +
        `resolved=${grounding ? JSON.stringify(grounding) : 'null'}`
    )
```

- [ ] **Step 3: Run a real session and read both lines**

Run: `npm run dev`

Ask three or four questions aloud, then end the session. In devtools console, expect one `[grounding]` line per answer and one `[speculation]` line at the end.

**Record the answers to the spec's open questions:**

- If `bundle=absent`: the user has no `ProfileBundle` installed. The chip is showing "not anchored" on every answer the app will ever give, which is alarm fatigue by construction. The fix is the resume ingest path, not the prompt. **Report this and stop** — it is outside this plan's scope and needs its own decision.
- If `bundle=present` and `resolved` shows a null story id: the model is omitting the citation line, and the fix belongs in the `OUTPUT CONTRACT` section from Task 5.
- If `hitRate` is below 55%: the spec's own threshold for "the trigger is too eager". Report the number. Do not tune `minWords` or `stableMs` in this plan.

- [ ] **Step 4: Checkpoint**

Run: `npm run typecheck && npm test`
Expected: green. (Commit: `chore: log speculation metrics and grounding resolution`)

---

## Done when

- One sentence with a pause in it produces one transcript line and one answer.
- A draft fired on a fragment does not commit against the full question.
- Answers render as labelled beats with a scenario half, and no `#` ever reaches the screen.
- The system prompt has no self-contradiction about flow versus blocks.
- `npm run typecheck && npm test` is green.
- The two open questions in the spec have recorded answers from Task 9.

## Deliberately not in this plan

- **Porting `endpointing.ts` and `answer-beats.ts` to Kotlin.** They join `speculation.ts` as shared rules `hue-mobile` mirrors, and until they are ported a mirrored session renders differently on the phone. `speculation.ts` states the inherited rule: when a rule changes here, change it there.
- **Tuning `minWords` / `stableMs`.** Task 9 ships the instrument. Tune after there is data.
- **Fixing the grounding chip.** Task 9 diagnoses it. The fix depends on which cause it turns out to be.
