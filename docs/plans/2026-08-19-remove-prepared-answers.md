# Remove Prepared Answers; Four-Beat Answer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the cue sheet ("prepared answers") subsystem from `hue-desktop` in full, and reshape the generated companion answer into four blank-line-separated beats that render as separate paragraphs.

**Architecture:** Removal proceeds top-down through the dependency graph — renderer UI, then the `useVoiceMode` hook, then the pipeline, then the main process — so every intermediate commit typechecks. One genuinely shared function (`scriptIsExtractive`) is relocated out of `cuesheet.ts` **before** anything is deleted. The four-beat change then lands as a new pure module (`shared/answer-shape.ts`), a pure renderer helper (`lib/paragraphs.ts`), and their two wiring points.

**Tech Stack:** Electron + React + TypeScript, `electron-vite`. Tests are plain `node --test` over `*.test.ts` with `node:assert/strict`. No test framework beyond the Node built-in.

**Spec:** [`docs/specs/2026-08-19-remove-prepared-answers-design.md`](../specs/2026-08-19-remove-prepared-answers-design.md)

## Global Constraints

- **Test command:** `npm test` (`node --test src/**/*.test.ts`). Single file: `node --test src/shared/job-spec.test.ts`. Single test: add `--test-name-pattern="<name>"`.
- **Typecheck:** `npm run typecheck` (runs `typecheck:node` then `typecheck:web`). This is the completeness check for the removal — a missed import is a compile error, not a runtime one. It must pass at the end of every task.
- **Lint:** `npm run lint`.
- **No em dashes or en dashes in any prompt string you add.** `HUMAN_VOICE_GUIDANCE` forbids them in Hue's output, and the comment at `pipeline.ts:1290` records that an exemplar containing a dash teaches the model to use one regardless of the abstract rule. Use commas, colons, or full stops.
- **The four-beat shape applies to `'practice'` interview mode only.** `InterviewMode` is `'practice' | 'star' | 'live'` (`types.ts:28`); `'practice'` is the default. `star` (Situation/Task/Action/Result) and `live` ("brevity over completeness") keep their current instructions verbatim.
- **Never delete files under `sheetsDir()`.** Uploaded sheets are user data. The code stops reading them; nothing removes them.
- **No content-derived React keys.** `main.css:481` records that anything keyed off answer content re-fires on every streamed token and strobes for the length of a long answer. Index keys on a stable list only.
- **Branch:** `remove-prepared-answers`, already created, with the spec committed at `924e662`.

---

### Task 1: Relocate `isVerbatimSpan` out of `cuesheet.ts`

`shared/job-spec.ts` imports `scriptIsExtractive` from `cuesheet.ts` to verify that a parsed job requirement's evidence is really a span of the posting. It has nothing to do with cue sheets. This must move before anything is deleted, and its tests must move with it — otherwise the check could be silently stubbed and no test would notice.

**Files:**
- Modify: `src/shared/job-spec.ts:37` (the import), add the function near the bottom
- Modify: `src/shared/job-spec.test.ts` (add three tests)
- Modify: `src/shared/cuesheet.test.ts:414-429` (remove the three tests and the shared `source` const)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `isVerbatimSpan(span: string, source: string): boolean`, module-private to `job-spec.ts`. Task 6 relies on `cuesheet.ts` having no remaining importers.

- [ ] **Step 1: Write the failing tests**

Add to `src/shared/job-spec.test.ts`. Note these use `verifyRequirement`, the public API, rather than testing the private helper directly — the containment check matters because it gates requirements, and that is what should be pinned.

```typescript
const posting =
  'We are looking for an engineer to own our billing integration. ' +
  'Five years of experience with distributed systems required.'

test('a requirement whose evidence is verbatim in the posting is kept', () => {
  const req = { id: 'billing', text: 'Own billing integration', evidence: 'own our billing integration' }
  assert.deepEqual(verifyRequirement(req, posting), req)
})

test('a requirement whose evidence was composed rather than quoted is dropped', () => {
  const req = { id: 'k8s', text: 'Kubernetes', evidence: 'deep Kubernetes expertise required' }
  assert.equal(verifyRequirement(req, posting), null)
})

test('re-wrapped whitespace and case do not reject real evidence', () => {
  const req = { id: 'exp', text: 'Five years', evidence: 'Five years of\nexperience   with distributed systems' }
  assert.deepEqual(verifyRequirement(req, posting), req)
})
```

- [ ] **Step 2: Run the tests to verify they pass against the current import**

Run: `node --test src/shared/job-spec.test.ts`
Expected: PASS. These describe behaviour that already works via the `cuesheet.ts` import. They are the safety net for the move, not a new feature — this step confirms the net is real before you cut the rope.

- [ ] **Step 3: Move the function into `job-spec.ts`**

Delete the import at line 37 (`import { scriptIsExtractive as isVerbatimSpan } from './cuesheet.ts'`) and add this above `verifyRequirement`:

```typescript
function normaliseSpan(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * The evidence must be a span the employer actually wrote, not prose about it.
 *
 * Containment rather than a judgement call: the only kind of grounding check
 * that cannot itself be wrong. Moved here from the cue sheet module, which was
 * only ever where it happened to be written first.
 */
function isVerbatimSpan(span: string, source: string): boolean {
  const s = normaliseSpan(span)
  return s.length > 0 && normaliseSpan(source).includes(s)
}
```

- [ ] **Step 4: Run the tests to verify they still pass**

Run: `node --test src/shared/job-spec.test.ts`
Expected: PASS, now with no `cuesheet.ts` import in the module.

- [ ] **Step 5: Remove the old tests from `cuesheet.test.ts`**

Delete lines 414-429: the `const source = ...` declaration and the three tests `'an extractive script is accepted'`, `'a script the user never wrote is rejected'`, `'whitespace and case differences do not reject a real extract'`. Leave `scriptIsExtractive` in the import list — `cuesheet.ts` still uses it internally at line 965, and the whole file goes in Task 6.

- [ ] **Step 6: Update the stale comment**

In `src/shared/job-spec.ts:26`, the doc comment says "Same mechanism as `verifyCard` in `./cuesheet.ts`". Replace that sentence with: `Containment is the only kind of grounding check that cannot itself be wrong.`

- [ ] **Step 7: Verify and commit**

```bash
npm test && npm run typecheck
git add src/shared/job-spec.ts src/shared/job-spec.test.ts src/shared/cuesheet.test.ts
git commit -m "refactor: move the verbatim-span check into job-spec"
```

---

### Task 2: Remove the prepared-answer UI

**Files:**
- Modify: `src/renderer/src/App.tsx` (line 20 import, 281 component, 924, 1162, 1325 call sites)
- Modify: `src/renderer/src/components/Settings.tsx` (931-933, 2069-2115, and remaining references)
- Modify: `src/renderer/src/assets/main.css` (line 2 import, rules from 285)

**Interfaces:**
- Consumes: nothing.
- Produces: `App.tsx` and `Settings.tsx` no longer read `voice.cueCard`, `voice.cueSheet`, or `window.hue.cueSheet`. Task 3 depends on this.

- [ ] **Step 1: Remove the three `CueCardBody` call sites in `App.tsx`**

There are **three**, and the one at 924 is easy to miss — the card renders in transcript/bubble mode as well as glance mode.

At line 924 (transcript mode), delete the whole `{voice.cueCard && <CueCardBody ... />}` expression.

At line 1162 (glance mode), the block collapses. Replace the card render, the `voice.cueCard ? ... : ...` label branch, and the `!voice.cueCard` guard on the placeholder with:

```tsx
{latestAnswer ? (
  <div className="glance-text">{latestAnswer.text}</div>
) : (
  <div className="glance-text glance-text--waiting">
    {voice.active
      ? 'Hue’s suggestion will appear here.'
      : 'Start a session — Hue’s suggestion will appear here.'}
  </div>
)}
```

The site at 1325 is not a standalone element — see Step 1b, which must be done with it.

- [ ] **Step 1b: Tear down the split-pane layout**

The cue sheet panel is one half of a resizable split that wraps the entire transcript view. Its container classes `.cuesheet-split` and `.cuesheet-split-pane` are defined in `cuesheet-doc.css`, which Task 6 deletes — so leaving the wrapper divs in place would silently break the transcript layout. This is the part of Task 2 most likely to be underestimated.

Remove all of it:

- `SPLIT_KEY_STEP` (578), `clampSplit` (580), and `SPLIT_DEFAULT_PCT`
- the `splitPct` state (627) and `splitRef`
- the drag handler at 989 that computes `splitPct` from the pointer position
- the `armedSheet` state (666) and whatever effect loads it from settings
- `visibleSheet` (676)
- the `<div className="cuesheet-split" ref={splitRef}>` wrapper (1236) and both `cuesheet-split-pane` children (1238, 1324)
- the divider element with its `aria-valuenow`, `onKeyDown`, and `title="Drag to resize"` (roughly 1295-1323)

The transcript pane returns to being a plain container filling the space. The conditional flex style at 1239 (`visibleSheet ? ... : { flex: '1 1 auto' }`) collapses to the unconditional `'1 1 auto'` branch.

- [ ] **Step 2: Remove the now-unused declarations in `App.tsx`**

Delete the `CueSheetPanel` import (line 20), the `CueCardBody` function (line 281 and its doc comment from 263), the `CueCard`/`CueSheet` type imports, and any `scriptOpen` state that existed only for the card's disclosure toggle (lines around 285-298).

- [ ] **Step 3: Remove the Settings section**

In `src/renderer/src/components/Settings.tsx`:
- Delete the onboarding checklist entry at 931-933 (`title: 'Upload your prepared answers'` and its body). The checklist is an array — removing an entry shifts the indices of everything after it, so check for any hardcoded index or step count referencing it.
- Delete the `<label className="settings-label">Prepared answers</label>` section at 2069 through the end of its containing block at ~2115.
- Delete the remaining references (41 total): upload handlers, `window.hue.cueSheet.*` calls, sheet list state, progress subscription, and the comment at 1184.

- [ ] **Step 4: Remove the CSS**

In `src/renderer/src/assets/main.css`: delete `@import './cuesheet-doc.css';` at line 2, and the prepared-card rules starting at the comment on line 285.

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: PASS. `useVoiceMode` still exports `cueCard`/`cueSheet` and the preload still exposes `window.hue.cueSheet` — both are simply unread now, which is correct at this point in the sequence.

Run: `npm test`
Expected: PASS. No renderer test covers these components.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/components/Settings.tsx src/renderer/src/assets/main.css
git commit -m "feat: remove the prepared answer UI"
```

---

### Task 3: Remove cue sheet state from `useVoiceMode`

**Files:**
- Modify: `src/renderer/src/hooks/useVoiceMode.ts` (line 8 import, 58-70 interface fields, 93-94 state, 124, 240-241, 333-334)

**Interfaces:**
- Consumes: Task 2 (no component reads these fields).
- Produces: the hook's return object no longer carries `cueCard` or `cueSheet`. Task 4 depends on the `onCueCard`/`onCueSheet` callbacks having no subscriber.

- [ ] **Step 1: Delete the state and its wiring**

Remove, in this order:
- Line 8: `import type { CueCard, CueSheet } from '@shared/cuesheet'`
- Lines 58-70: the `cueCard` and `cueSheet` fields and their doc comments from the returned interface
- Lines 93-94: the two `useState` declarations
- Line 124: the `void pipelineRef.current?.armCueSheet()` call, and the settings-change effect wrapping it if that call was its only body (check the comment at 121, which explains the effect exists *because* of cue sheets)
- Lines 240-241: `onCueCard: setCueCard,` and `onCueSheet: setCueSheet`
- Lines 333-334: `cueCard,` and `cueSheet,` from the returned object

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/hooks/useVoiceMode.ts
git commit -m "feat: drop cue sheet state from useVoiceMode"
```

---

### Task 4: Remove the latch and gate machinery from the pipeline

This is the subtlest task. The latch logic is interleaved with the speculation scheduler's commit/regenerate handling, and the endpoint-then-generate recovery living alongside it is what stands between the user and a blank screen when speculation produced nothing. Do not disturb it.

**Files:**
- Modify: `src/renderer/src/lib/pipeline.ts` (lines 14-21, 60-76, 201-203, 264-265, 646-696, 722-790, 919-961, 1213-1222, 1267-1268, 1392-1409)

**Interfaces:**
- Consumes: Task 3 (no subscriber to the callbacks).
- Produces: `buildSystemPrompt(s: HueSettings): string` and `buildCompanionPrompt(s: HueSettings): string` — both lose their `cueSheet` and `latchedCard` parameters. Task 9 modifies `buildCompanionPrompt`.

- [ ] **Step 1: Understand why `gateCommands` collapses to identity**

Before editing, read `cuesheet.ts:618-707`. Every branch that drops a command is guarded by a cue sheet condition:

- `fire` is dropped only when `decision.suppress`, which `decide()` sources solely from `this.matcher.suppresses(...)`
- `regenerate` is dropped only when `state.cardId !== null`
- `commit` is dropped only when `decision.latch !== null`
- `reset` and `abort` always pass through

With no matcher, `suppress` is permanently `false` and `cardId`/`latch` permanently `null`. Every command passes. So `gateCommands` is provably the identity function here, and `resetScheduler` exists only to repair the scheduler after *this function* dropped a command it was tracking. No drops means nothing to repair. **All three of `resetScheduler`, `regenerateForLatch`, and `latchCleared` are deletions, not behaviours to reimplement.**

- [ ] **Step 2: Delete the imports and callback declarations**

Remove the `from '../../../shared/cuesheet'` import block (14-21), and the `onCueCard` (60-65) and `onCueSheet` (70-76) callback declarations with their doc comments.

- [ ] **Step 3: Delete the instance state and its lifecycle**

Remove `private armedSheet` (201), `private latch = newLatchState()` (202-203), `private matcher` (wherever declared), the `await this.armCueSheet()` and `this.latch = newLatchState()` in `start()` (264-265), the whole `armCueSheet()` method (646-667), the whole `decide()` method (669-681), and the whole `latchedCard()` method (919-926).

- [ ] **Step 4: Collapse the interim command path**

In `applyInterimCommands` (683-700), delete the `decide()` call, the `gateCommands` call, the `if (gated.resetScheduler)` line, the `commands = gated.commands` reassignment, and the `if (gated.latchCleared)` block with its long comment. The loop now iterates the `commands` parameter directly.

- [ ] **Step 5: Collapse the final command path**

In the final path (722-790), delete `previousLatch`, the `gateCommands` call and its `resetScheduler` handling, the `if (decision.latch !== null) / else if (previousLatch !== null)` block with both `onCueCard` calls (730-751), and the `if (gated.regenerateForLatch)` block (785). Commands pass through directly.

**Leave the endpoint-then-generate recovery intact.** It is the `fire`-at-final path, and it is not cue sheet logic.

- [ ] **Step 6: Clean the reset path and the prompt call**

At 956-961, delete the `this.latch = newLatchState()` and `this.callbacks.onCueCard?.(null)` lines, keeping the surrounding per-question reset.

At 937, `buildSystemPrompt(this.settings, this.armedSheet, this.latchedCard())` becomes `buildSystemPrompt(this.settings)`.

- [ ] **Step 7: Simplify the prompt builders**

`buildSystemPrompt` (1212-1222) and `buildCompanionPrompt` (1266-1268) each drop their `cueSheet` and `latchedCard` parameters. In `buildCompanionPrompt`, delete the `cueBlock` construction and its long comment (1392-1409).

Also update the comment at 1216 ("Prepared answers go only to the companion prompt...") — the reason it gives no longer exists. Replace the paragraph with a plain statement that interviewer mode gets a different prompt because Hue is asking rather than answering.

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS. `cuesheet.ts` and its tests still exist and still pass on their own; nothing imports them from the renderer any more.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/lib/pipeline.ts
git commit -m "feat: remove cue card latching from the pipeline"
```

---

### Task 5: Remove the main-process surface and the persisted setting

**Files:**
- Modify: `src/main/ipc.ts:29,32,252-271`
- Modify: `src/preload/index.ts:23,105-118`
- Modify: `src/shared/types.ts:247,293`
- Modify: `src/main/settings-migrations.ts:15-19`
- Modify: `src/main/settings-migrations.test.ts`

**Interfaces:**
- Consumes: Task 4 (nothing in the renderer calls `window.hue.cueSheet`).
- Produces: `RETIRED_SETTING_KEYS` gains `'selectedCueSheetId'`. `HueSettings` no longer has that field.

- [ ] **Step 1: Write the failing migration test**

Add to `src/main/settings-migrations.test.ts`, following the shape of the existing retired-key tests in that file:

```typescript
test('a settings file carrying a selected cue sheet loads without it', () => {
  const onDisk = { ...DEFAULT_SETTINGS, selectedCueSheetId: 'sheet-abc123' } as unknown as HueSettings
  const migrated = migrateSettings(onDisk) as unknown as Record<string, unknown>
  assert.equal('selectedCueSheetId' in migrated, false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/main/settings-migrations.test.ts --test-name-pattern="selected cue sheet"`
Expected: FAIL — the key survives, because `migrateSettings` only strips keys listed in `RETIRED_SETTING_KEYS`.

- [ ] **Step 3: Retire the key**

In `src/main/settings-migrations.ts`, add to the array:

```typescript
export const RETIRED_SETTING_KEYS = [
  'ingestBaseUrl',
  'ingestAccountId',
  'ingestAccountToken',
  'selectedCueSheetId'
] as const
```

This is required, not tidiness: `readFromDisk` merges as `{ ...DEFAULT_SETTINGS, ...raw }` and `updateSettings` writes every key back, so a key removed from the defaults still survives from disk and is re-persisted on every settings change.

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test src/main/settings-migrations.test.ts --test-name-pattern="selected cue sheet"`
Expected: PASS.

- [ ] **Step 5: Remove the field, the IPC handlers, and the preload API**

- `src/shared/types.ts`: delete `selectedCueSheetId: string` (247) and `selectedCueSheetId: ''` (293).
- `src/main/ipc.ts`: delete the imports at 29 and 32, and the four handlers plus the progress send at 252-271 (`hue:cuesheet:ingest`, `:list`, `:select`, `:delete`).
- `src/preload/index.ts`: delete the `CueSheet` type import (23) and the whole `cueSheet: { ... }` API object (105-118), including the `hue:cuesheet:progress` subscription.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

```bash
git add src/shared/types.ts src/main/ipc.ts src/preload/index.ts src/main/settings-migrations.ts src/main/settings-migrations.test.ts
git commit -m "feat: retire the cue sheet IPC surface and setting"
```

---

### Task 6: Delete the files

Nothing imports these any more, which the typechecks in Tasks 1-5 have already proven.

**Files:**
- Delete: eleven files (below)
- Modify: `package.json` (the `eval:cuesheet` script)
- Modify: `src/shared/memory-policy.ts:6`, `src/main/usage-store.ts:16,35`, `src/main/structured-llm.ts:395`, `src/main/ingest.ts:20`
- Modify: `docs/specs/2026-08-11-cue-sheet-design.md`, `docs/plans/2026-08-11-cue-sheet.md`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: no `cuesheet` identifier anywhere in `src/`.

- [ ] **Step 1: Delete the files**

```bash
git rm src/shared/cuesheet.ts src/shared/cuesheet.test.ts \
       src/shared/cuesheet-corpus.ts src/shared/cuesheet-corpus.test.ts \
       src/main/cuesheet-ingest.ts src/main/cuesheet-ingest.test.ts \
       src/main/cuesheet-eval.test.ts \
       src/main/cuesheet-store.ts src/main/cuesheet-store.test.ts \
       src/renderer/src/components/CueSheetPanel.tsx \
       src/renderer/src/assets/cuesheet-doc.css
```

- [ ] **Step 2: Remove the npm script**

`package.json` has `"eval:cuesheet": "HUE_EVAL=1 node --test src/main/cuesheet-eval.test.ts"`, which now points at a deleted file. Delete that line. Leave `eval:resume`.

- [ ] **Step 3: Reword the comments that cite `cuesheet.ts` as a precedent**

These are doc comments pointing readers at a module that no longer exists. Each names a design principle that is still true — keep the principle, change the pointer.

- `src/shared/memory-policy.ts:6` — "Same discipline as `speculation.ts` and `cuesheet.ts`": drop the second name, keep `speculation.ts`.
- `src/main/usage-store.ts:16` and `:35` — both describe how `cuesheet-store.ts` reaches Electron through a lazy `require` to stay testable under plain `node --test`. Restate the technique directly rather than by reference, since there is no longer a module to point at.
- `src/main/structured-llm.ts:395` — "`cuesheet-ingest.ts` defers its own imports": point at `job-spec-ingest.ts`, which does the same at line 161 (`await import('./structured-llm.ts')`).
- `src/main/ingest.ts:20` — "the same privacy property `cuesheet-ingest.ts` already had": state the property directly.

- [ ] **Step 4: Note the removal in the old docs**

Do not delete them; they record a design that was built, measured against a 111-case corpus, and removed, and that history has value. Add as the second line of each of `docs/specs/2026-08-11-cue-sheet-design.md` and `docs/plans/2026-08-11-cue-sheet.md`:

```markdown
> **Removed 2026-08-19.** This feature no longer exists. See [Remove prepared answers](../specs/2026-08-19-remove-prepared-answers-design.md).
```

Adjust the relative path for the file in `docs/plans/`.

- [ ] **Step 5: Verify the removal is complete**

```bash
npm run typecheck && npm test && npm run lint
grep -ril "cuesheet\|cue sheet\|cue card\|prepared answer" src/
```

Expected: typecheck, tests, and lint all pass; the grep returns **nothing**. A hit in `src/` means a reference survived.

Note: files under `sheetsDir()` in the user data directory are deliberately left alone. Do not add a cleanup step.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: delete the cue sheet subsystem"
```

---

### Task 7: The `paragraphs` helper

Blank lines are invisible today: `.glance-text` has no `white-space: pre-wrap`, so HTML collapses them and the four-beat prompt would have no visible effect at all. This is the piece that makes the change real.

**Files:**
- Create: `src/renderer/src/lib/paragraphs.ts`
- Test: `src/renderer/src/lib/paragraphs.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `paragraphs(text: string): string[]`. Task 8 consumes it.

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paragraphs } from './paragraphs.ts'

test('text with no blank line is a single paragraph', () => {
  assert.deepEqual(paragraphs('I use Postman constantly.'), ['I use Postman constantly.'])
})

test('blank lines split the text into beats', () => {
  const answer = 'Beat one.\n\nBeat two.\n\nBeat three.\n\nBeat four.'
  assert.deepEqual(paragraphs(answer), ['Beat one.', 'Beat two.', 'Beat three.', 'Beat four.'])
})

test('a single newline stays inside one paragraph', () => {
  assert.deepEqual(paragraphs('one\ntwo'), ['one\ntwo'])
})

test('leading and trailing blank lines produce no empty paragraphs', () => {
  assert.deepEqual(paragraphs('\n\n  one  \n\n\n  two \n\n'), ['one', 'two'])
})

test('a blank line of spaces still splits', () => {
  assert.deepEqual(paragraphs('one\n   \ntwo'), ['one', 'two'])
})

test('empty text yields no paragraphs', () => {
  assert.deepEqual(paragraphs(''), [])
  assert.deepEqual(paragraphs('   \n  '), [])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/renderer/src/lib/paragraphs.test.ts`
Expected: FAIL — cannot resolve `./paragraphs.ts`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Split an answer into the beats the model separated with blank lines.
 *
 * The glance surface is read aloud, live, with the reader glancing down
 * between sentences. Blank lines are how the answer gives the eye somewhere to
 * land, and HTML collapses them, so the split has to happen here.
 *
 * Recomputed on every render rather than memoised: the answer streams, so a
 * cache would be invalidated on every token anyway, and this is a regex over a
 * few hundred characters.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test src/renderer/src/lib/paragraphs.test.ts`
Expected: PASS, all six tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/paragraphs.ts src/renderer/src/lib/paragraphs.test.ts
git commit -m "feat: add the paragraphs helper"
```

---

### Task 8: Render the beats as paragraphs

**Files:**
- Modify: `src/renderer/src/App.tsx` (the glance block at ~1162 after Task 2, and the transcript answer bubble)
- Modify: `src/renderer/src/assets/main.css` (after the `.glance-text` rule ending ~495)

**Interfaces:**
- Consumes: `paragraphs(text: string): string[]` from Task 7.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Render paragraphs in the glance block**

Import the helper, then replace the single-`div` render from Task 2 Step 1:

```tsx
{latestAnswer ? (
  <div className="glance-text">
    {paragraphs(latestAnswer.text).map((block, i) => (
      <p key={i}>{block}</p>
    ))}
  </div>
) : (
  <div className="glance-text glance-text--waiting">
    {voice.active
      ? 'Hue’s suggestion will appear here.'
      : 'Start a session — Hue’s suggestion will appear here.'}
  </div>
)}
```

The index key is deliberate. `main.css:481` records that a key derived from content re-fires on every streamed token and strobes for the length of a long answer. The list only grows at the end, so index keys are stable here.

- [ ] **Step 2: Render paragraphs in the transcript bubble**

Apply the same `paragraphs(...).map(...)` treatment to the assistant answer text in the transcript view. Without it the transcript shows a wall of text with the blank lines collapsed, which is the exact problem this change exists to fix, just on the other surface.

- [ ] **Step 3: Add the spacing rule**

In `main.css`, after the `.glance-text` block:

```css
/*
 * The beats of an answer, spaced so the eye can find its place again between
 * spoken sentences. Margin only between blocks, never before the first or
 * after the last: the receipt overlaps into the padding under the last line,
 * and a trailing margin would push it off.
 */
.glance-text p {
  margin: 0;
}

.glance-text p + p {
  margin-top: calc(var(--glance-size) * var(--glance-leading) * 0.55);
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run lint`
Expected: PASS.

Then check it by eye: `npm run dev`, start a session, and confirm a multi-beat answer renders as separated blocks, that the text still grows in place while streaming without flicker, and that the grounding receipt still sits correctly under the last line.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/assets/main.css
git commit -m "feat: render answer beats as separate paragraphs"
```

---

### Task 9: The four-beat prompt

`pipeline.ts` has no test file and imports browser globals, so `buildCompanionPrompt` cannot be exercised under `node --test`. The mode-shape strings therefore move into a pure shared module, following the pattern `job-spec.ts` and `memory-policy.ts` already set. This is what makes the rule testable rather than hoped-for.

**Files:**
- Create: `src/shared/answer-shape.ts`
- Test: `src/shared/answer-shape.test.ts`
- Modify: `src/renderer/src/lib/pipeline.ts` (the format instruction at ~1284 and the `interviewMode` switch at the end of `buildCompanionPrompt`)

**Interfaces:**
- Consumes: nothing.
- Produces: `answerShapeFor(mode: InterviewMode): string` and the exported constant `FOUR_BEAT_SHAPE: string`. `InterviewMode` is `'practice' | 'star' | 'live'` (`types.ts:28`) — the default mode's literal is **`'practice'`**, not `'default'`.

- [ ] **Step 1: Write the failing test**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerShapeFor, FOUR_BEAT_SHAPE } from './answer-shape.ts'

test('practice mode gets the four beats', () => {
  assert.equal(answerShapeFor('practice'), FOUR_BEAT_SHAPE)
})

test('star mode keeps STAR and never mentions beats', () => {
  const shape = answerShapeFor('star')
  assert.match(shape, /Situation, Task, Action, Result/)
  assert.doesNotMatch(shape, /beat/i)
})

test('live mode stays terse and never mentions beats', () => {
  const shape = answerShapeFor('live')
  assert.match(shape, /Brevity over completeness/)
  assert.doesNotMatch(shape, /beat/i)
})

// HUMAN_VOICE_GUIDANCE forbids dashes in Hue's output, and pipeline.ts:1290
// records that a dash anywhere in the prompt teaches the model to use one no
// matter what the abstract rule says. That is how em dashes got into the
// answers once before, so it is pinned rather than trusted to review.
test('no shape instruction contains an em dash or an en dash', () => {
  for (const mode of ['practice', 'star', 'live'] as const) {
    assert.doesNotMatch(answerShapeFor(mode), /[—–]/, `${mode} shape contains a dash`)
  }
})

test('the four beats ask for blank-line separation and forbid labels', () => {
  assert.match(FOUR_BEAT_SHAPE, /blank line/)
  assert.match(FOUR_BEAT_SHAPE, /no headings, no labels/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/shared/answer-shape.test.ts`
Expected: FAIL — cannot resolve `./answer-shape.ts`.

- [ ] **Step 3: Write the module**

```typescript
import type { InterviewMode } from './types.ts'

/**
 * The shape of a companion answer, per interview mode.
 *
 * Pure and separate from `pipeline.ts` so it can be tested: the pipeline
 * imports browser globals and cannot be loaded under plain `node --test`, which
 * left the prompt's most load-bearing rules unpinned. Same arrangement as
 * `job-spec.ts` and `memory-policy.ts`.
 *
 * No em dashes or en dashes anywhere in this file. `HUMAN_VOICE_GUIDANCE`
 * forbids them in Hue's output, and a dash in the instruction that teaches the
 * shape teaches the dash along with it.
 */

/**
 * Four beats, each its own paragraph.
 *
 * The glance surface is read aloud while the interviewer is watching, so the
 * reader looks down for a fraction of a second and needs to find their place
 * again. An unbroken paragraph gives the eye nothing to land on. The beats are
 * a delivery aid, not an essay structure, which is why nothing announces them.
 */
export const FOUR_BEAT_SHAPE =
  'Shape the answer as four short beats, each its own paragraph separated by a blank line. ' +
  'Beat one opens with the habit, the claim, or the direct response, and must stand alone as a ' +
  'complete answer if the user says nothing else. Beat two proves it with one real, specific ' +
  'example, named concretely rather than described in general terms. Beat three says what that ' +
  'taught the user or what it let them see. Beat four closes on the impact it had, in terms of ' +
  'what it was worth rather than what was built. ' +
  'Keep each beat to one or two sentences. Write them as plain speakable prose in the first ' +
  'person: no headings, no labels, no numbering, no bullet points, and never a signposting word ' +
  'like "first" or "finally" announcing the structure. The blank lines are there so the user can ' +
  'find their place at a glance while reading aloud, so the four beats must still read as one ' +
  'continuous answer when spoken start to finish.'

const STAR_SHAPE =
  'Structure the answer using the STAR method (Situation, Task, Action, Result).'

const LIVE_SHAPE =
  'Give a tight, direct answer the user can say immediately. Brevity over completeness.'

export function answerShapeFor(mode: InterviewMode): string {
  switch (mode) {
    case 'star':
      return STAR_SHAPE
    case 'live':
      return LIVE_SHAPE
    default:
      return FOUR_BEAT_SHAPE
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test src/shared/answer-shape.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Wire it into `buildCompanionPrompt`**

Replace the whole `switch (s.interviewMode) { ... }` block at the end of `buildCompanionPrompt` with:

```typescript
parts.push(answerShapeFor(s.interviewMode))
```

and add `import { answerShapeFor } from '../../../shared/answer-shape'` alongside the other shared imports.

- [ ] **Step 6: Relax the universal format instruction**

The instruction at ~1284 currently demands a single paragraph, which now contradicts the default mode's shape. Replace that string with one that keeps the parts that apply to every mode and drops the paragraph count:

```typescript
'Write the answer as plain speakable prose the user can say start to finish: no headings, no ' +
  'labels, no "Example:" prefix, no bullet points, no numbering. Weave one concrete, real-life ' +
  'example directly into the answer so it backs up the point as part of the flow, the way a ' +
  'person naturally drops in a specific moment while speaking.',
```

Leave the "Lead with the answer" instruction at ~1280 untouched. Beat one already is a standalone response, so the two agree.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test && npm run lint`
Expected: PASS.

Then check the real output: `npm run dev`, default mode, and ask a question that invites a story. Confirm the answer arrives as four separated beats, that beat one works as an answer on its own, and that no em dashes appear. Switch to `live` mode and confirm it still returns one terse block.

- [ ] **Step 8: Commit**

```bash
git add src/shared/answer-shape.ts src/shared/answer-shape.test.ts src/renderer/src/lib/pipeline.ts
git commit -m "feat: give the companion answer four beats"
```

---

### Task 10: Final verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Full suite**

```bash
npm run typecheck && npm test && npm run lint
```

Expected: all pass.

- [ ] **Step 2: Confirm nothing survived**

```bash
grep -ril "cuesheet\|cue sheet\|cue card\|prepared answer" src/ package.json
```

Expected: no output.

- [ ] **Step 3: Confirm the settings file heals**

Launch the app once (`npm run dev`), change any setting to force a write, then check the settings file in the Electron `userData` directory no longer contains `selectedCueSheetId`.

- [ ] **Step 4: Confirm the user's uploaded sheets are still on disk**

The sheets directory must be untouched. If it is gone, something added a cleanup step that this plan explicitly forbids; restore it and remove that code.

- [ ] **Step 5: Review the diff**

```bash
git diff main...HEAD --stat
```

Expected: eleven files deleted, roughly a dozen modified, three created (`answer-shape.ts`, `answer-shape.test.ts`, `paragraphs.ts` plus its test).

---

## Notes for the executor

**The one that can fail silently.** Task 1. Every other part of the removal is caught by the typechecker. If `isVerbatimSpan` is stubbed, inlined wrongly, or its tests dropped instead of moved, job postings quietly stop having their evidence verified and nothing fails. Do Task 1 first and do not skip its Step 2.

**The one that is fiddly.** Task 4. The latch logic sits inside the speculation scheduler's command handling, and the endpoint-then-generate recovery next to it is what prevents a blank screen. Read Step 1 before touching anything.

**The one that is bigger than it looks.** Task 2, Step 1b. The cue sheet panel is half a resizable split-pane wrapping the whole transcript view, and its container CSS lives in the file Task 6 deletes. Remove the panel without removing the wrappers and the transcript layout breaks with no compile error.

**The one that is tedious.** Task 2, Step 3. Forty-one references in a 2458-line file, and the onboarding checklist is index-sensitive.

**Three discrepancies against the spec, resolved here.**

1. The spec described `App.tsx` as three `CueCardBody` sites plus a panel route. It is also the entire split-pane apparatus — `splitPct`, `clampSplit`, `SPLIT_KEY_STEP`, `splitRef`, the pointer drag handler, the keyboard-resizable divider, `armedSheet`, and `visibleSheet`. Task 2 Step 1b covers it.
2. The spec did not mention `package.json`'s `eval:cuesheet` script, which points at a deleted test file. Task 6 Step 2 removes it.
3. The spec assumed the four-beat instruction could be asserted against `buildCompanionPrompt` directly. It cannot — `pipeline.ts` has no test file and imports browser globals — which is why Task 9 introduces `shared/answer-shape.ts`.
