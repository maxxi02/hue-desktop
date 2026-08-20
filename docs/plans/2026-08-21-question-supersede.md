# Question Supersede Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the interviewer resumes talking after Hue has started answering, merge the new speech into the question already asked and replace the answer, instead of answering twice.

**Architecture:** `EndpointBuffer` (`src/shared/endpointing.ts`) currently forgets a question the moment it ships it. It gains a *settled* state — the shipped text, when it shipped, and how many times it has been replaced — so a final arriving inside a supersede window prepends the settled text back into `segments` and re-enters the existing 700ms hold. Both ship points then report `supersedes: boolean`, which the renderer pipeline uses to replace the previous turn in `messages` rather than append to it.

**Tech Stack:** TypeScript, Electron + electron-vite, React renderer, `node --test` with `node:assert/strict`. No new dependencies.

**Spec:** [`docs/specs/2026-08-21-question-supersede-design.md`](../specs/2026-08-21-question-supersede-design.md)

## Global Constraints

- **No new dependencies.** Everything here is standard library plus what is already installed.
- **`src/shared/` modules stay pure.** No timers, no I/O, no browser globals, no clock reads. `now` is passed in by the caller. This is what lets the whole behaviour matrix run under `node --test` against a fake clock, and it is the stated discipline of `speculation.ts` and `endpointing.ts`.
- **Test command:** `npm test` (which is `node --test src/**/*.test.ts`). Test files import source with an explicit `.ts` extension, e.g. `from './endpointing.ts'`.
- **Code style:** no semicolons, single quotes, 2-space indent. `npm run format` (prettier) and `npm run lint` (eslint) must both pass.
- **Typecheck:** `npm run typecheck` runs both the node and web projects. Both must pass.
- **Companion mode only.** Every behaviour in this plan is gated on `settings.hueMode === 'companion'`. Interviewer mode constructs no `EndpointBuffer` and must be entirely unaffected.
- **Window values, verbatim from the spec:** `supersedeMs: 4000` on system loopback, `1500` on microphone, `maxSupersedes: 2`, existing `holdMs: 700` and `maxHeldSegments: 3` unchanged.
- **Continuation markers, verbatim from the spec:** `and`, `also`, `or`, `plus`, `specifically`, `in particular`, `for example`.

---

### Task 1: `EndpointBuffer` gains a settled state

The core of the feature, and the only task with real behavioural weight. Everything else is wiring.

**Files:**
- Modify: `src/shared/endpointing.ts`
- Test: `src/shared/endpointing.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface EndpointConfig` gains `supersedeMs: number` and `maxSupersedes: number`
  - `interface CompletedQuestion { text: string; supersedes: boolean }`
  - `type HoldDecision = { kind: 'hold'; until: number } | { kind: 'complete'; text: string; supersedes: boolean }`
  - `EndpointBuffer.onSegmentFinal(text: string, now: number): HoldDecision`
  - `EndpointBuffer.onHoldExpired(now: number): CompletedQuestion | null` — note this **now uses** its `now` parameter, so the existing `eslint-disable-next-line @typescript-eslint/no-unused-vars` above it must be deleted.

**Note on existing tests:** four tests in `endpointing.test.ts` assert the old return shapes with `deepEqual` and will fail until updated. That is expected and handled in Step 1 — it is the compiler and test suite telling you every call site of the changed shape.

- [ ] **Step 1: Update the four existing tests for the new return shape**

These are shape-only edits. Do not change what they assert behaviourally.

In `src/shared/endpointing.test.ts`:

```ts
test('a lone segment completes when the hold expires', () => {
  const buf = new EndpointBuffer()
  const decision = buf.onSegmentFinal('what is your greatest weakness?', 0)
  assert.deepEqual(decision, { kind: 'hold', until: DEFAULT_ENDPOINT_CONFIG.holdMs })
  assert.deepEqual(buf.onHoldExpired(DEFAULT_ENDPOINT_CONFIG.holdMs), {
    text: 'what is your greatest weakness?',
    supersedes: false
  })
})

// The defect this module exists for. One sentence, one pause, two VAD segments.
test('the screenshot case reassembles into one question', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('Walk me through your brass.', 0)
  assert.equal(buf.onSpeechStart(400), true)
  buf.onSegmentFinal('when you are testing a new endpoint for the first time.', 2500)
  assert.deepEqual(buf.onHoldExpired(3200), {
    text: 'Walk me through your brass. when you are testing a new endpoint for the first time.',
    supersedes: false
  })
})

test('the segment cap completes rather than holding again', () => {
  const buf = new EndpointBuffer({ maxHeldSegments: 2 })
  assert.equal(buf.onSegmentFinal('one', 0).kind, 'hold')
  buf.onSpeechStart(100)
  const decision = buf.onSegmentFinal('two', 500)
  assert.deepEqual(decision, { kind: 'complete', text: 'one two', supersedes: false })
  // Completing clears the buffer: the next question starts empty.
  assert.equal(buf.heldText, '')
})

test('an empty segment does not extend the hold with blank text', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('a real question here', 0)
  buf.onSpeechStart(200)
  buf.onSegmentFinal('   ', 900)
  assert.deepEqual(buf.onHoldExpired(1600), {
    text: 'a real question here',
    supersedes: false
  })
})
```

- [ ] **Step 2: Write the failing tests for supersede**

Append to `src/shared/endpointing.test.ts`:

```ts
// The defect this task exists for. The hold expired, the question shipped and
// was answered, and only then did the interviewer finish the sentence.
test('a final inside the supersede window replaces the shipped question', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('can you please', 0)
  assert.deepEqual(buf.onHoldExpired(700), {
    text: 'can you please',
    supersedes: false
  })

  // 1.4s later — well past holdMs, well inside supersedeMs.
  buf.onSegmentFinal('introduce yourself', 2100)
  assert.deepEqual(buf.onHoldExpired(2800), {
    text: 'can you please introduce yourself',
    supersedes: true
  })
})

test('a final past the supersede window is a new question', () => {
  const buf = new EndpointBuffer({ supersedeMs: 1500 })
  buf.onSegmentFinal('what is your greatest weakness?', 0)
  buf.onHoldExpired(700)

  buf.onSegmentFinal('tell me about your last role', 5000)
  assert.deepEqual(buf.onHoldExpired(5700), {
    text: 'tell me about your last role',
    supersedes: false
  })
})

test('supersedeMs of zero disables replacement entirely', () => {
  const buf = new EndpointBuffer({ supersedeMs: 0 })
  buf.onSegmentFinal('can you please', 0)
  buf.onHoldExpired(700)
  buf.onSegmentFinal('introduce yourself', 800)
  assert.deepEqual(buf.onHoldExpired(1500), {
    text: 'introduce yourself',
    supersedes: false
  })
})

// A continuation can itself be split. Re-entering the ordinary hold is what
// makes this work without a second merging path.
test('a continuation that is itself split merges both halves', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('can you please', 0)
  buf.onHoldExpired(700)

  buf.onSegmentFinal('introduce yourself', 1500)
  assert.equal(buf.onSpeechStart(1800), true)
  buf.onSegmentFinal('and your background', 2200)
  assert.deepEqual(buf.onHoldExpired(2900), {
    text: 'can you please introduce yourself and your background',
    supersedes: true
  })
})

test('the supersede cap stops replacing and starts a new question', () => {
  const buf = new EndpointBuffer({ maxSupersedes: 1 })
  buf.onSegmentFinal('first', 0)
  buf.onHoldExpired(700)

  buf.onSegmentFinal('second', 1000)
  assert.deepEqual(buf.onHoldExpired(1700), { text: 'first second', supersedes: true })

  // The cap is spent. The next final starts a turn of its own rather than
  // being dropped or endlessly appended.
  buf.onSegmentFinal('third', 2000)
  assert.deepEqual(buf.onHoldExpired(2700), { text: 'third', supersedes: false })
})

test('the supersede count resets when a genuinely new question begins', () => {
  const buf = new EndpointBuffer({ maxSupersedes: 1, supersedeMs: 1500 })
  buf.onSegmentFinal('first', 0)
  buf.onHoldExpired(700)
  buf.onSegmentFinal('second', 1000)
  assert.equal(buf.onHoldExpired(1700)?.supersedes, true)

  // Far past the window: a new question, which restores the full budget.
  buf.onSegmentFinal('a brand new question', 20000)
  assert.equal(buf.onHoldExpired(20700)?.supersedes, false)
  buf.onSegmentFinal('with a continuation', 21200)
  assert.deepEqual(buf.onHoldExpired(21900), {
    text: 'a brand new question with a continuation',
    supersedes: true
  })
})

test('the segment cap ships a supersede with the flag set', () => {
  const buf = new EndpointBuffer({ maxHeldSegments: 2 })
  buf.onSegmentFinal('can you please', 0)
  buf.onHoldExpired(700)
  // Prepending the settled text fills the first slot, so this second segment
  // hits the cap and ships immediately.
  const decision = buf.onSegmentFinal('introduce yourself', 1200)
  assert.deepEqual(decision, {
    kind: 'complete',
    text: 'can you please introduce yourself',
    supersedes: true
  })
})

test('reset drops the settled question too', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('can you please', 0)
  buf.onHoldExpired(700)
  buf.reset()
  buf.onSegmentFinal('introduce yourself', 1000)
  assert.deepEqual(buf.onHoldExpired(1700), {
    text: 'introduce yourself',
    supersedes: false
  })
})

test('a blank final does not open a supersede', () => {
  const buf = new EndpointBuffer()
  buf.onSegmentFinal('can you please', 0)
  buf.onHoldExpired(700)
  buf.onSegmentFinal('   ', 1000)
  // Nothing was added, so nothing is held and nothing ships.
  assert.equal(buf.onHoldExpired(1700), null)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. The shape tests fail on `deepEqual` (missing `supersedes` key); the new tests fail because `supersedeMs` / `maxSupersedes` are not valid config keys and no replacement behaviour exists.

- [ ] **Step 4: Extend the config and result types**

In `src/shared/endpointing.ts`, replace the `EndpointConfig` interface, its default, and `HoldDecision`:

```ts
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
  /**
   * After a question ships, a final arriving within this of it is the back half
   * of that question rather than a new one — even though an answer is already
   * on screen. The answer is replaced rather than added to.
   *
   * This is a *later* deadline than `holdMs`, not a longer one: `holdMs` is dead
   * time before anything is shown and is expensive, while this window is spent
   * with an answer already on screen and costs only a regeneration. Set to 0 to
   * disable replacement.
   */
  supersedeMs: number
  /**
   * How many times one question may be replaced before the next final starts a
   * turn of its own.
   *
   * Each replacement throws away a partial generation. This bounds that waste,
   * for the same reason `maxHeldSegments` bounds the wait.
   */
  maxSupersedes: number
}

export const DEFAULT_ENDPOINT_CONFIG: EndpointConfig = {
  holdMs: 700,
  maxHeldSegments: 3,
  supersedeMs: 4000,
  maxSupersedes: 2
}

/** A question that is over, and whether it replaces the one before it. */
export interface CompletedQuestion {
  text: string
  /**
   * True when this question absorbed one that was already shipped and answered.
   * The caller replaces the previous turn rather than appending a new one.
   */
  supersedes: boolean
}

export type HoldDecision =
  /** Wait until `until`. If nothing resumes by then, the question is over. */
  | { kind: 'hold'; until: number }
  /** Ship this now. Only returned when the segment cap is reached. */
  | ({ kind: 'complete' } & CompletedQuestion)
```

- [ ] **Step 5: Add the settled state and the ship path**

In `src/shared/endpointing.ts`, replace the class body's fields and its three entry points. Keep `heldText` and the existing doc comments unchanged except where noted.

```ts
export class EndpointBuffer {
  private readonly config: EndpointConfig
  private segments: string[] = []
  private lastSegmentEndedAt = 0

  /** The question last shipped, still replaceable until the window closes. */
  private settledText = ''
  private settledAt = 0
  /** Replacements spent on the settled question. Reset when a new one begins. */
  private supersedeCount = 0
  /** True when what is currently held began as a replacement of `settledText`. */
  private replacing = false

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
   *
   * A non-blank final arriving while nothing is held but a question is still
   * settled is the case this module was extended for: the hold already expired
   * and that question was already answered, and this is the rest of it. The
   * settled text goes back into `segments` and the ordinary hold runs again, so
   * a continuation that is itself split needs no separate path.
   */
  onSegmentFinal(text: string, now: number): HoldDecision {
    const trimmed = text.trim()

    if (trimmed.length > 0 && this.segments.length === 0 && this.canSupersede(now)) {
      this.segments.push(this.settledText)
      this.replacing = true
      this.supersedeCount += 1
      this.settledText = ''
      this.settledAt = 0
    }

    if (trimmed.length > 0) this.segments.push(trimmed)
    this.lastSegmentEndedAt = now

    if (this.segments.length >= this.config.maxHeldSegments) {
      return { kind: 'complete', ...this.ship(now) }
    }
    return { kind: 'hold', until: now + this.config.holdMs }
  }

  /**
   * Speech resumed. True when it continues the held question.
   *
   * The caller cancels its pending hold timer on true, and treats false as the
   * ordinary start of a new utterance. A settled question has no pending timer
   * to cancel, so this stays false during the supersede window — the merge
   * happens in `onSegmentFinal`, once there is text to merge.
   */
  onSpeechStart(now: number): boolean {
    if (this.segments.length === 0) return false
    return now - this.lastSegmentEndedAt < this.config.holdMs
  }

  /** The hold deadline passed. Returns the assembled question, or null if none. */
  onHoldExpired(now: number): CompletedQuestion | null {
    if (this.segments.length === 0) return null
    return this.ship(now)
  }

  reset(): void {
    this.segments = []
    this.lastSegmentEndedAt = 0
    this.settledText = ''
    this.settledAt = 0
    this.supersedeCount = 0
    this.replacing = false
  }

  /**
   * Whether a final arriving now continues the question already shipped.
   *
   * Timing only. Punctuation cannot carry this decision — Whisper stamps a
   * confident full stop onto fragments — and the structure of an interview does
   * the work instead: after the interviewer genuinely finishes, the candidate
   * talks.
   */
  private canSupersede(now: number): boolean {
    if (this.settledText.length === 0) return false
    if (this.supersedeCount >= this.config.maxSupersedes) return false
    return now - this.settledAt < this.config.supersedeMs
  }

  /**
   * Hand the assembled question to the caller and become settled on it.
   *
   * The buffer no longer forgets what it shipped: it stays replaceable until
   * `supersedeMs` passes or the cap is spent, at which point the settled state
   * is cleared so the next final starts a turn of its own.
   */
  private ship(now: number): CompletedQuestion {
    const text = this.heldText
    const supersedes = this.replacing

    this.segments = []
    this.lastSegmentEndedAt = 0
    this.replacing = false
    if (!supersedes) this.supersedeCount = 0

    if (this.supersedeCount >= this.config.maxSupersedes) {
      this.settledText = ''
      this.settledAt = 0
      this.supersedeCount = 0
    } else {
      this.settledText = text
      this.settledAt = now
    }

    return { text, supersedes }
  }
}
```

Also delete the now-stale `eslint-disable-next-line @typescript-eslint/no-unused-vars` comment that sat above the old `onHoldExpired`, and update the module's header comment by appending this paragraph after the existing one about the hold being free:

```
 * A question is not forgotten when it ships. The hold covers a pause inside a
 * sentence; it cannot cover one long enough that an answer is already on screen.
 * For that the buffer stays *settled* on what it shipped, and a final arriving
 * inside `supersedeMs` folds back into it and replaces the answer rather than
 * adding a second one. Waiting longer would tax every question in the session;
 * replacing taxes only the questions that were actually interrupted.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all of `endpointing.test.ts` green.

- [ ] **Step 7: Typecheck, lint, format**

Run: `npm run typecheck && npm run lint && npm run format`
Expected: all clean. `pipeline.ts` still compiles because it reads only `.text` off the result; the added `supersedes` key is additive.

- [ ] **Step 8: Commit**

```bash
git add src/shared/endpointing.ts src/shared/endpointing.test.ts
git commit -m "feat(endpointing): keep a question replaceable after it ships"
```

---

### Task 2: Continuation markers widen the window

**Files:**
- Modify: `src/shared/endpointing.ts`
- Test: `src/shared/endpointing.test.ts`

**Interfaces:**
- Consumes: `EndpointConfig.supersedeMs`, `EndpointBuffer.canSupersede` from Task 1.
- Produces: `EndpointConfig` gains `markerSupersedeMs: number` (default `4000`). No new exported symbols — the marker list stays module-private.

Why this exists: on a room mic the window is narrow because the user's own voice shares the channel. A segment that *opens with a continuation marker* is evidence of continuation that does not depend on punctuation, so it earns the wider window even there. It can only widen a window, never reject a merge that timing accepted — a false positive costs one wasted regeneration, a false negative costs nothing at all.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/endpointing.test.ts`:

```ts
// On a room mic the window is narrow because the user's own voice is in the
// same channel. An opening continuation marker is evidence that survives that.
test('a continuation marker widens a narrow window', () => {
  const buf = new EndpointBuffer({ supersedeMs: 1500, markerSupersedeMs: 4000 })
  buf.onSegmentFinal('tell me about your last role', 0)
  buf.onHoldExpired(700)

  // 3s: past supersedeMs, inside markerSupersedeMs.
  buf.onSegmentFinal('and what you shipped there', 3000)
  assert.deepEqual(buf.onHoldExpired(3700), {
    text: 'tell me about your last role and what you shipped there',
    supersedes: true
  })
})

test('a marker cannot widen the window past its own limit', () => {
  const buf = new EndpointBuffer({ supersedeMs: 1500, markerSupersedeMs: 4000 })
  buf.onSegmentFinal('tell me about your last role', 0)
  buf.onHoldExpired(700)
  buf.onSegmentFinal('and what you shipped there', 9000)
  assert.deepEqual(buf.onHoldExpired(9700), {
    text: 'and what you shipped there',
    supersedes: false
  })
})

test('a non-marker segment keeps the narrow window', () => {
  const buf = new EndpointBuffer({ supersedeMs: 1500, markerSupersedeMs: 4000 })
  buf.onSegmentFinal('tell me about your last role', 0)
  buf.onHoldExpired(700)
  buf.onSegmentFinal('what is your notice period', 3000)
  assert.deepEqual(buf.onHoldExpired(3700), {
    text: 'what is your notice period',
    supersedes: false
  })
})

// "android" starts with "and". Matching must be on words, not characters.
test('a word that merely starts with a marker is not a marker', () => {
  const buf = new EndpointBuffer({ supersedeMs: 1500, markerSupersedeMs: 4000 })
  buf.onSegmentFinal('what have you used', 0)
  buf.onHoldExpired(700)
  buf.onSegmentFinal('android tooling mostly', 3000)
  assert.deepEqual(buf.onHoldExpired(3700), {
    text: 'android tooling mostly',
    supersedes: false
  })
})

test('a two-word marker is matched as a phrase', () => {
  const buf = new EndpointBuffer({ supersedeMs: 1500, markerSupersedeMs: 4000 })
  buf.onSegmentFinal('walk me through your testing', 0)
  buf.onHoldExpired(700)
  buf.onSegmentFinal('for example on a new endpoint', 3000)
  assert.deepEqual(buf.onHoldExpired(3700), {
    text: 'walk me through your testing for example on a new endpoint',
    supersedes: true
  })
})

test('markers are matched regardless of case and leading punctuation', () => {
  const buf = new EndpointBuffer({ supersedeMs: 1500, markerSupersedeMs: 4000 })
  buf.onSegmentFinal('tell me about your last role', 0)
  buf.onHoldExpired(700)
  buf.onSegmentFinal('... And what you shipped there', 3000)
  assert.equal(buf.onHoldExpired(3700)?.supersedes, true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `markerSupersedeMs` is not a valid config key, and the marker cases currently fall outside the 1500ms window.

- [ ] **Step 3: Add the marker list and the widened window**

In `src/shared/endpointing.ts`, add the config field to `EndpointConfig` (after `supersedeMs`):

```ts
  /**
   * The window used instead of `supersedeMs` when the resuming segment opens
   * with a continuation marker.
   *
   * Only ever widens. A marker is evidence that the interviewer is still adding
   * to the question, and unlike punctuation it does not depend on Whisper's
   * sentence boundaries being right.
   */
  markerSupersedeMs: number
```

Add to `DEFAULT_ENDPOINT_CONFIG`, after `supersedeMs: 4000`:

```ts
  markerSupersedeMs: 4000,
```

Add near the top of the module, below the config default:

```ts
/**
 * Openings that mean the interviewer is still adding to the question.
 *
 * Deliberately short and deliberately one-directional: these widen the
 * supersede window, never narrow it, so a word missing from this list costs
 * nothing that timing was not already deciding.
 */
const CONTINUATION_MARKERS = [
  'and',
  'also',
  'or',
  'plus',
  'specifically',
  'in particular',
  'for example'
]

const LEADING_NON_WORD = /^[^\p{L}\p{N}]+/u

/**
 * Whether `text` opens with a continuation marker.
 *
 * Word-boundary matching, not `startsWith`: "android tooling" opens with the
 * letters of "and" and is not a continuation of anything.
 */
function opensWithContinuationMarker(text: string): boolean {
  const normalised = text.toLowerCase().replace(LEADING_NON_WORD, '')
  return CONTINUATION_MARKERS.some(
    (marker) =>
      normalised === marker ||
      normalised.startsWith(marker + ' ')
  )
}
```

- [ ] **Step 4: Consult the marker from the supersede gate**

`canSupersede` needs the text to size its window, so give it the parameter and update its one call site in `onSegmentFinal` from `this.canSupersede(now)` to `this.canSupersede(trimmed, now)`:

```ts
  private canSupersede(text: string, now: number): boolean {
    if (this.settledText.length === 0) return false
    if (this.supersedeCount >= this.config.maxSupersedes) return false
    // Zero means the feature is off, and a marker must not switch it back on.
    if (this.config.supersedeMs <= 0) return false
    const window = opensWithContinuationMarker(text)
      ? Math.max(this.config.supersedeMs, this.config.markerSupersedeMs)
      : this.config.supersedeMs
    return now - this.settledAt < window
  }
```

Two details worth not losing:

`Math.max` rather than a plain swap, so the marker can only ever widen — a caller that configures `supersedeMs` above `markerSupersedeMs` does not accidentally get a *narrower* window for the stronger signal.

The `supersedeMs <= 0` guard comes before the marker check on purpose. Task 1 documents `0` as "disable replacement", and without this guard a segment opening with "and" would be widened to `markerSupersedeMs` and replace a turn in a configuration that asked for no replacement at all. `Math.max(0, 4000)` is 4000.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, including every test from Task 1.

- [ ] **Step 6: Typecheck, lint, format, commit**

```bash
npm run typecheck && npm run lint && npm run format
git add src/shared/endpointing.ts src/shared/endpointing.test.ts
git commit -m "feat(endpointing): continuation markers widen the supersede window"
```

---

### Task 3: `dropSupersededTurn` — the history rewrite, as a pure function

**Files:**
- Create: `src/shared/question-turns.ts`
- Test: `src/shared/question-turns.test.ts`

**Interfaces:**
- Consumes: `LlmMessage` from `src/shared/types.ts`.
- Produces: `export function dropSupersededTurn(messages: readonly LlmMessage[]): LlmMessage[]`

Why a separate module rather than a method on the pipeline: `pipeline.ts` is a 1380-line renderer file that needs `window.hue`, a VAD, and IPC to instantiate, so nothing in it is unit-testable. This is the one piece of the wiring with real logic in it, and the spec's testing section calls for asserting it directly. Extracting it follows the pattern `endpointing.ts` and `speculation.ts` already set: rules live in `src/shared/`, pure and tested; `pipeline.ts` only wires them together.

- [ ] **Step 1: Write the failing tests**

Create `src/shared/question-turns.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropSupersededTurn } from './question-turns.ts'
import type { LlmMessage } from './types.ts'

// A supersede while the answer was still streaming. completeTurn never ran, so
// only the fragment is in history.
test('drops a trailing user turn that was never answered', () => {
  const messages: LlmMessage[] = [{ role: 'user', content: 'can you please' }]
  assert.deepEqual(dropSupersededTurn(messages), [])
})

// A supersede after the answer finished. completeTurn pushed the assistant
// reply on top of the fragment, so both go.
test('drops a trailing answered turn, question and answer together', () => {
  const messages: LlmMessage[] = [
    { role: 'user', content: 'tell me about yourself' },
    { role: 'assistant', content: 'I lead platform work.' },
    { role: 'user', content: 'can you please' },
    { role: 'assistant', content: 'Sure — what would you like to know?' }
  ]
  assert.deepEqual(dropSupersededTurn(messages), [
    { role: 'user', content: 'tell me about yourself' },
    { role: 'assistant', content: 'I lead platform work.' }
  ])
})

test('leaves earlier turns untouched', () => {
  const messages: LlmMessage[] = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' }
  ]
  assert.deepEqual(dropSupersededTurn(messages), [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' }
  ])
})

test('an empty history is returned unchanged', () => {
  assert.deepEqual(dropSupersededTurn([]), [])
})

// Defensive: an assistant turn with no user turn under it should not eat into
// whatever came before.
test('a lone trailing assistant turn drops only itself', () => {
  const messages: LlmMessage[] = [{ role: 'assistant', content: 'orphaned' }]
  assert.deepEqual(dropSupersededTurn(messages), [])
})

test('does not mutate the input', () => {
  const messages: LlmMessage[] = [{ role: 'user', content: 'can you please' }]
  dropSupersededTurn(messages)
  assert.equal(messages.length, 1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with a module-not-found error for `./question-turns.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/question-turns.ts`:

```ts
/**
 * Removing a turn that turned out to be half a question.
 *
 * When the interviewer keeps talking after Hue has started answering, the
 * fragment already in history is not a turn that happened — it is the front half
 * of the turn happening now. Leaving it there and appending the merged question
 * would show the model the same question twice, once truncated, and it answers
 * accordingly: the on-screen defect, relocated into the context window.
 *
 * Pure and clock-free for the reason `endpointing.ts` gives: `pipeline.ts` needs
 * a VAD and IPC to exist at all, so any logic left inside it is logic no test
 * ever reaches.
 */

import type { LlmMessage } from './types'

/**
 * Drop the most recent question and its answer, if it has one.
 *
 * `completeTurn` is the only place an assistant turn enters history, so a
 * supersede arriving mid-stream finds just the fragment, and one arriving after
 * the answer finished finds the answer sitting on top of it. Both shapes are
 * handled by peeling the assistant turn first, if present, then the user turn.
 */
export function dropSupersededTurn(messages: readonly LlmMessage[]): LlmMessage[] {
  const kept = [...messages]
  if (kept.at(-1)?.role === 'assistant') kept.pop()
  if (kept.at(-1)?.role === 'user') kept.pop()
  return kept
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, format, commit**

```bash
npm run typecheck && npm run lint && npm run format
git add src/shared/question-turns.ts src/shared/question-turns.test.ts
git commit -m "feat(shared): add dropSupersededTurn for replacing a half-question"
```

---

### Task 4: Wire supersede through the pipeline

The wiring task. No new logic — every decision was made in Tasks 1–3; this connects them.

**Files:**
- Modify: `src/renderer/src/lib/pipeline.ts`

**Interfaces:**
- Consumes: `CompletedQuestion`, `EndpointConfig.supersedeMs` (Task 1); `dropSupersededTurn` (Task 3).
- Produces: `resolveQuestion(text: string, supersedes: boolean): void` and `private pushQuestion(text: string): void`, used by nothing outside this file.

**The critical detail:** there are **four** places the resolve path pushes a user turn — `pipeline.ts:566` (plain), `:721` (regenerate/fire), `:799` (commit with a lost stream), `:804` (ordinary commit). All four must honour the flag. Threading a parameter through four call sites is how one gets missed, so they all route through one helper reading one field.

- [ ] **Step 1: Add the import and the flag field**

At the top of `src/renderer/src/lib/pipeline.ts`, beside the existing `EndpointBuffer` import on line 10:

```ts
import { dropSupersededTurn } from '../../../shared/question-turns'
```

Beside the `endpoint` / `holdTimer` fields (around line 187):

```ts
  /**
   * Set for the duration of one `resolveQuestion` call when the question being
   * resolved replaces the previous turn rather than following it.
   *
   * A field rather than a parameter because four separate paths out of
   * `resolveQuestion` push the user turn — the plain path, regenerate/fire, and
   * both commit paths — and a parameter threaded through all four is a parameter
   * that gets missed on one of them.
   */
  private supersedesPrevious = false
```

- [ ] **Step 2: Size the supersede window by audio source**

Replace line 212:

```ts
    if (settings.hueMode === 'companion') this.endpoint = new EndpointBuffer()
```

with:

```ts
    if (settings.hueMode === 'companion') {
      // How wide the replacement window can safely be is decided entirely by
      // who can be heard. `speakerOfIncomingSpeech` labels all companion-mode
      // audio 'interviewer', which system loopback makes true by construction
      // and a room mic only assumes: a room mic also hears the user reading the
      // answer aloud, and merging that into the question would be worse than
      // the defect this fixes. So the mic window closes while the user still
      // cannot plausibly have started reading.
      this.endpoint = new EndpointBuffer({
        supersedeMs: settings.audioSource === 'system' ? 4000 : 1500
      })
    }
```

- [ ] **Step 3: Route every user-turn push through one helper**

Add this method directly above `resolveQuestion`:

```ts
  /**
   * Append the question about to be answered, replacing the previous turn when
   * this one supersedes it.
   *
   * Every path out of `resolveQuestion` that starts a generation goes through
   * here, so the replacement cannot be honoured on some of them and not others.
   */
  private pushQuestion(text: string): void {
    if (this.supersedesPrevious) {
      this.supersedesPrevious = false
      this.messages = dropSupersededTurn(this.messages)
    }
    this.messages.push({ role: 'user', content: text })
  }
```

Now replace the four pushes. Each is currently the identical line `this.messages.push({ role: 'user', content: <x> })`; they differ only in the variable pushed.

At `pipeline.ts:566`, in `resolveQuestion`:

```ts
    this.pushQuestion(text)
    this.startResponse({ speak: this.speakResponses, maxTokens: 700 })
```

At `pipeline.ts:721`, in `applyFinalCommands` under `case 'regenerate': case 'fire':`:

```ts
          this.pushQuestion(finalText)
          this.startResponse({ speak: this.speakResponses, maxTokens: 700 })
```

At `pipeline.ts:799`, in `commitSpeculation` under the `streamId === null` branch:

```ts
      this.pushQuestion(finalText)
      this.startResponse({ speak: this.speakResponses, maxTokens: 700 })
      return
```

At `pipeline.ts:804`, in `commitSpeculation` on the ordinary path:

```ts
    this.pushQuestion(finalText)
```

- [ ] **Step 4: Take the flag in `resolveQuestion` and drop the stale answer**

Replace the signature and opening of `resolveQuestion`:

```ts
  /**
   * The question is genuinely over: generate against it.
   *
   * Split out of `onSpeechEnd` so the endpoint hold can call it later, once it
   * knows no continuation is coming.
   *
   * `supersedes` means this question absorbed one that was already shipped and
   * answered, so the answer on screen belongs to half a question and has to go.
   */
  private resolveQuestion(text: string, supersedes: boolean): void {
    this.supersedesPrevious = supersedes
    if (supersedes) {
      // The answer being replaced may still be streaming — in which case the
      // barge-in branch of onSpeechStart already aborted it — or may have
      // finished on its own, in which case nothing has. Aborting unconditionally
      // covers the second case and is a no-op in the first.
      //
      // This also discards any draft fired on the continuation alone, which
      // costs nothing real: that draft's fire text is a *suffix* of the merged
      // question, so commits() would take the F1 path and refuse it anyway.
      this.abortResponse()
    }

    if (this.scheduler) {
```

The rest of the method is unchanged.

- [ ] **Step 5: Update the three `resolveQuestion` call sites**

At `pipeline.ts:297` in `onVADMisfire`, the `held` value now carries the flag:

```ts
        if (held) {
          this.resolveQuestion(held.text, held.supersedes)
          return
        }
```

In `onSpeechEnd`, the endpoint block:

```ts
    if (this.endpoint) {
      const decision = this.endpoint.onSegmentFinal(text, Date.now())
      this.clearHoldTimer()
      if (decision.kind === 'complete') {
        this.resolveQuestion(decision.text, decision.supersedes)
        return
      }
      this.holdTimer = setTimeout(
        () => {
          this.holdTimer = null
          const done = this.endpoint?.onHoldExpired(Date.now())
          if (done) this.resolveQuestion(done.text, done.supersedes)
        },
        Math.max(0, decision.until - Date.now())
      )
      return
    }

    this.resolveQuestion(text, false)
```

- [ ] **Step 6: Stop a supersede from straddling a screen capture**

`captureScreen` pushes a user turn holding an image and records its index in `pendingCaptureIndex`. A later supersede popping that turn would leave the index pointing at the wrong message, and `completeTurn` would strip the image from a message that never had one. The settled question is stale the moment a capture happens anyway, so clear it.

In `captureScreen`, immediately after `this.abortResponse()` (around line 827):

```ts
    this.abortResponse()
    // A capture is a new turn, so nothing before it stays replaceable. Without
    // this, a supersede arriving after the capture would pop the capture's own
    // message and leave pendingCaptureIndex dangling.
    this.endpoint?.reset()
```

- [ ] **Step 7: Verify the whole suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint && npm run format`
Expected: all pass. The typechecker is the real gate here — it should confirm there is no remaining call to `resolveQuestion` with one argument, and no remaining raw `messages.push({ role: 'user' … })` in the resolve path. Grep to be sure:

Run: `grep -n "messages.push({ role: 'user'" src/renderer/src/lib/pipeline.ts`
Expected: exactly two hits — `captureScreen` (an image turn, not a question) and `kickoffInterview` (interviewer mode, which has no `EndpointBuffer`). If a third appears, it is a resolve path that was missed.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/lib/pipeline.ts
git commit -m "feat(pipeline): replace the previous turn when a question supersedes it"
```

---

### Task 5: Show the assembled question, not the last fragment

A bug that predates this work and is fixed by the mechanism Task 4 already needed. `pipeline.ts:488` emits `onUserTranscript` with the **raw segment**, before the endpoint decision is made, so an ordinary two-segment join sends the model the whole question and shows the user only its last fragment.

**Files:**
- Modify: `src/renderer/src/lib/pipeline.ts`

**Interfaces:**
- Consumes: `resolveQuestion` from Task 4.
- Produces: `private emitAssembledQuestion(text: string): void`.

- [ ] **Step 1: Add fields remembering what was last shown**

Beside `supersedesPrevious` from Task 4:

```ts
  /** The question text last sent to the UI, so an assembled one is not re-sent identically. */
  private lastEmittedQuestion = ''
  /** ASR provenance of the most recent segment, reused when re-emitting an assembled question. */
  private lastTranscriptMeta: { tier: ResolvedTier; latencyMs: number } | null = null
```

No import changes are needed: `ResolvedTier` is already imported at `pipeline.ts:23` as part of the type-only `@shared/types` block, because it appears in the `onUserTranscript` callback signature at line 37.

- [ ] **Step 2: Record provenance on each segment**

In `onSpeechEnd`, replace line 488:

```ts
      if (text) this.callbacks.onUserTranscript?.(text, res.tier, res.latencyMs)
```

with:

```ts
      if (text) {
        // Emitted per segment, not per question, so words appear on screen while
        // the interviewer is still speaking. The assembled question replaces this
        // at resolve time if the two differ.
        this.lastTranscriptMeta = { tier: res.tier, latencyMs: res.latencyMs }
        this.lastEmittedQuestion = text
        this.callbacks.onUserTranscript?.(text, res.tier, res.latencyMs)
      }
```

- [ ] **Step 3: Re-emit the assembled question at resolve time**

Add this method beside `pushQuestion`:

```ts
  /**
   * Put the whole question on screen once it is known.
   *
   * Two cases, one mechanism. A question joined across a pause has only ever
   * shown its last fragment — the per-segment emit above fires before the
   * endpoint decides anything, so the model has been getting the whole question
   * and the user has been reading the tail of it. And a superseded question
   * needs the stale answer cleared, which `onUserTranscript` does on the
   * renderer side (`useVoiceMode.ts:185`) as part of accepting a new question.
   *
   * Silent when the question is a single segment, which is the common case.
   */
  private emitAssembledQuestion(text: string): void {
    if (text === this.lastEmittedQuestion) return
    const meta = this.lastTranscriptMeta
    if (!meta) return
    this.lastEmittedQuestion = text
    this.callbacks.onUserTranscript?.(text, meta.tier, meta.latencyMs)
  }
```

Call it in `resolveQuestion`, immediately after the `supersedes` abort block added in Task 4 and before the `if (this.scheduler)` branch:

```ts
    this.emitAssembledQuestion(text)

    if (this.scheduler) {
```

- [ ] **Step 4: Clear the memory when the session clears**

In the `clear()` path (around line 440), beside the existing `this.endpoint?.reset()`:

```ts
    this.lastEmittedQuestion = ''
    this.lastTranscriptMeta = null
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run lint && npm run format`
Expected: all pass. There is no unit test for this step — `pipeline.ts` is not instantiable outside Electron — so the behavioural check is the manual one in Task 6, which covers it explicitly.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/pipeline.ts
git commit -m "fix(pipeline): show the assembled question instead of its last fragment"
```

---

### Task 6: Verify in the running app

The pure modules are tested; the wiring is not, because nothing in `pipeline.ts` is instantiable outside Electron. This task is where the wiring gets checked, and it is not optional — Tasks 4 and 5 have no automated coverage at all.

**Files:** none modified. If a defect is found, fix it in the task that owns the code and re-run this one.

- [ ] **Step 1: Full suite and build**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all four clean. `build` runs `typecheck` again and then `electron-vite build`; it catches renderer-only breakage the node typecheck misses.

- [ ] **Step 2: Launch**

Run: `npm run dev`

Set the session to **companion** mode, audio source **microphone**, and start a session.

- [ ] **Step 3: The reported case**

Speak into the mic, as the interviewer: **"Can you please…"** — then stop, wait for Hue's answer to *start appearing*, then within about a second say **"…introduce yourself."**

Expected:
- The question on screen reads **"can you please introduce yourself"** — the whole thing, not just the tail.
- Exactly **one** answer is on screen when it settles, and it addresses being asked to introduce yourself.
- The first partial answer is gone rather than sitting above the second.

- [ ] **Step 4: A genuinely new question is not swallowed**

Ask a question, let the answer finish, wait a good five seconds, then ask a clearly unrelated one.

Expected: two separate turns. The second question replaces the first *on screen* (the UI has always shown one turn at a time) but its answer addresses only the second question, with no trace of the first merged into it.

- [ ] **Step 5: The ordinary join still works, and now displays correctly**

Speak one sentence with a deliberate breath in the middle — the `holdMs` case, e.g. **"Walk me through your testing … when you hit a new endpoint."**

Expected: one answer, and the question on screen shows **both halves**. This is the Task 5 fix; before it, this displayed only "when you hit a new endpoint."

- [ ] **Step 6: Interviewer mode is untouched**

Switch to interviewer mode and run a short exchange.

Expected: identical to before this branch. Hue asks the opening question, your answers are not merged into anything, and nothing is replaced. No `EndpointBuffer` is constructed in this mode, so any change in behaviour here means something leaked outside the companion gate.

- [ ] **Step 7: Commit anything the smoke test forced**

If Steps 3–6 were clean, there is nothing to commit and the branch is done. If a fix was needed, commit it against the task that owns the file:

```bash
git add -A
git commit -m "fix(pipeline): <what the smoke test caught>"
```

---

## Notes for the reviewer

Two things in the spec are deliberately **not** implemented here, and neither is an oversight:

1. **No visible marker on a supersede.** The replacement is silent. Spec open question 2 argues both sides; it is left out under YAGNI and is the first thing to add if the replacement reads as disorienting in real use.
2. **No summarisation of the merged question.** The merge is plain concatenation. Spec section 4 gives the reasoning: a summariser is a lossy step whose job is to discard detail before the answering model ever sees it.

The window constants (`4000` / `1500` / `700`) are first estimates resting on an unmeasured distribution, exactly as `holdMs: 700` was when the preceding spec shipped. Segment-gap logging is the instrument all three want, and it is not in scope here.
