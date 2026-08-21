# Gap Coverage Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a résumé-mined tag from suppressing the gap question it cannot honestly answer, and give an existing bundle a way to get its questions without a full re-mine.

**Architecture:** `findGaps` becomes source-aware — the four `HIGH_RISK_COMPETENCIES` are covered only by a `source: 'gap-answer'` story — and takes the existing gaps so a competency already asked about is never asked again. A new `rescanGaps` entry point runs that check plus the single existing gap-scan model call against a stored bundle, then reseals it.

**Tech Stack:** TypeScript, Electron main/preload/renderer, `node --test` with `node:assert/strict`. No new dependencies.

**Spec:** [`docs/specs/2026-08-21-gap-coverage-depth-design.md`](../specs/2026-08-21-gap-coverage-depth-design.md)

## Global Constraints

- **No new dependencies.**
- **Test command:** `npm test` (`node --test src/**/*.test.ts`). Test files import source with an explicit `.ts` extension; source files import without one.
- **Code style:** no semicolons, single quotes, 2-space indent. `npm run format` and `npm run lint` must pass.
- **Typecheck:** `npm run typecheck` covers node and web. Both must pass.
- **The bundle schema does not change.** `Gap`, `Story`, `ProfileBundle` keep their current shapes. Only which gaps get generated changes.
- **High-risk competencies, verbatim from `profile.ts`:** `failure`, `conflict`, `ambiguity`, `influence-without-authority`.
- **Existing constants unchanged:** `MAX_GAP_QUESTIONS = 8`, `STEP_TOKENS.gapScan = 1_000`, `BUNDLE_VERSION = 1`.
- **Every bundle mutation reseals.** `sealBundle` recomputes the content hash, which is a cache key elsewhere; a changed bank with an unchanged hash goes quietly stale.

---

### Task 1: `findGaps` measures depth, not presence

The whole behavioural change. `findGaps` is pure and already exported, so it carries all the test weight.

**Files:**
- Modify: `src/main/resume-pipeline.ts` (`findGaps`, around line 370)
- Test: `src/main/resume-pipeline.test.ts`

**Interfaces:**
- Consumes: `Competency`, `HIGH_RISK_COMPETENCIES`, `COMPETENCIES` from `src/shared/profile.ts`; `Story`, `Gap` from `src/main/resume-types.ts`.
- Produces: `export function findGaps(stories: Story[], existingGaps: Gap[] = []): Competency[]`

**Note on the existing tests:** **four** encode the old rule and will fail. The spec said two; it undercounted. All four are handled in Step 3, and two of them test a state this change makes unreachable, so they are replaced rather than adjusted.

- [ ] **Step 1: Write the failing tests for source-aware coverage**

Append to `src/main/resume-pipeline.test.ts`:

```ts
// A resume structurally cannot evidence conflict, so a conflict tag that came
// from one is exactly the signal that must not silence the question.
test('a resume-sourced story does not cover a high-risk competency', () => {
  const stories = normaliseStories({ stories: [story('c1', null, ['conflict'])] })
  assert.ok(findGaps(stories).includes('conflict'))
})

test('a gap-answer story does cover a high-risk competency', () => {
  const stories = normaliseStories({ stories: [story('c1', null, ['conflict'])] }, 'gap-answer')
  assert.ok(!findGaps(stories).includes('conflict'))
})

test('an ordinary competency is still covered by a resume story', () => {
  const stories = normaliseStories({ stories: [story('s1', null, ['scaling'])] })
  assert.ok(!findGaps(stories).includes('scaling'))
})

// The reported bundle, reduced to a fixture: every tag present, all from the
// resume, so exactly the four high-risk competencies come back.
test('a resume covering every competency still yields the four high-risk gaps', () => {
  const stories = normaliseStories({
    stories: COMPETENCIES.map((c, i) => story(`s${i}`, null, [c]))
  })
  assert.deepEqual(findGaps(stories).sort(), [
    'ambiguity',
    'conflict',
    'failure',
    'influence-without-authority'
  ])
})

test('high-risk competencies still sort first', () => {
  const stories = normaliseStories({ stories: [story('s1', null, ['scaling'])] })
  const gaps = findGaps(stories)
  const firstOrdinary = gaps.findIndex((c) => !HIGH_RISK_COMPETENCIES.includes(c))
  const lastRisky = gaps.reduce((last, c, i) => (HIGH_RISK_COMPETENCIES.includes(c) ? i : last), -1)
  assert.ok(lastRisky < firstOrdinary)
})
```

Add `HIGH_RISK_COMPETENCIES` to the existing `../shared/profile.ts` import block at the top of the test file, beside `COMPETENCIES`.

- [ ] **Step 2: Write the failing tests for existing-gap exclusion**

Each status is excluded for a different reason, so each gets its own test.

```ts
function gap(competency: string, status: 'open' | 'answered' | 'skipped'): Gap {
  return {
    id: `gap-${competency}`,
    competency: competency as Competency,
    question: `Tell me about ${competency}.`,
    status,
    storyId: null
  }
}

// The load-bearing case: "I don't have one" is an answer, and re-asking would
// punish the honest response with repetition.
test('a skipped competency is never asked again', () => {
  const stories = normaliseStories({ stories: [story('s1', null, ['scaling'])] })
  assert.ok(!findGaps(stories, [gap('conflict', 'skipped')]).includes('conflict'))
})

// The easy one to miss: an open gap means the question is already on screen and
// unanswered, so the competency is genuinely still uncovered and would be
// returned again — appending a second open question for it on every rescan.
test('a competency with an open gap is not duplicated', () => {
  const stories = normaliseStories({ stories: [story('s1', null, ['scaling'])] })
  assert.ok(!findGaps(stories, [gap('conflict', 'open')]).includes('conflict'))
})

test('an answered competency is not asked again', () => {
  const stories = normaliseStories({ stories: [story('s1', null, ['scaling'])] })
  assert.ok(!findGaps(stories, [gap('conflict', 'answered')]).includes('conflict'))
})

test('existing gaps default to none, so the ingest path is unchanged', () => {
  const stories = normaliseStories({ stories: [story('s1', null, ['scaling'])] })
  assert.deepEqual(findGaps(stories), findGaps(stories, []))
})
```

Add `type Gap` and `type Competency` to the test file's imports from `./resume-types.ts` (a new import line — the test file does not currently import from that module).

- [ ] **Step 3: Update the four tests that encode the old rule**

All four currently pass and must change. Work through them in file order.

**First, extend the shared `GAP_QUESTIONS` fixture** (line 127). Two entries are needed: `influence-without-authority`, so a full-coverage résumé can yield all four high-risk gaps, and an ordinary *covered* competency to keep the discard behaviour under test. The existing `conflict` entry's comment — "Covered already — must be discarded rather than take a slot" — is now false, because a résumé conflict tag no longer covers conflict. Move that role to `scaling`, which `MINED` genuinely covers:

```ts
const GAP_QUESTIONS = {
  questions: [
    {
      competency: 'failure',
      question: "Tell me about a project that didn't ship — what happened?"
    },
    {
      competency: 'ambiguity',
      question: 'When did you have to start work with the goal still unclear?'
    },
    { competency: 'deadline-pressure', question: 'When did a date force a hard call?' },
    // No longer covered by the resume tag alone, so this one is now kept.
    { competency: 'conflict', question: 'Tell me about a disagreement.' },
    {
      competency: 'influence-without-authority',
      question: 'When did you change minds without being in charge?'
    },
    // Covered by a resume story, and ordinary rather than high-risk — so this is
    // the one that must be discarded rather than take a slot.
    { competency: 'scaling', question: 'When did you scale something?' }
  ]
}
```

**Test 1** (line 252) asserts conflict is covered because the mined fixture has a résumé-sourced conflict story. Under the new rule it is a gap, and the name stops being accurate — it is no longer a set difference:

```ts
test('gaps put the invention-prone competencies first, and resume tags do not cover them', () => {
  const stories = normaliseStories(MINED)
  const gaps = findGaps(stories)

  // MINED has a conflict story, but it came from the resume — which is exactly
  // the tag this rule stopped trusting.
  assert.ok(gaps.includes('conflict'))
  assert.ok(gaps.includes('failure'))
  // failure / conflict / ambiguity / influence-without-authority are what a
  // model invents when the resume has none, so they get asked first.
  assert.ok(HIGH_RISK_COMPETENCIES.includes(gaps[0]))
})
```

**Test 2**, `'gap questions are capped and never ask about a covered competency'` (line 263), asserts the produced gaps are exactly `['failure', 'ambiguity', 'deadline-pressure']` — conflict having been discarded as covered.

Work out the new expectation from the fixture rather than trusting this line: `MINED`'s three stories carry `conflict`, `influence-without-authority`, `scaling`, `technical-tradeoff`, `mentorship`, `leadership`, all résumé-sourced. So the four ordinary tags are covered, the two high-risk ones are not, and `findGaps` returns the missing eight with high-risk first. `buildGaps` then keeps the `GAP_QUESTIONS` entries whose competency is in that set, **in fixture order**, and drops `scaling`:

```ts
  assert.deepEqual(
    bundle.gaps.map((g) => g.competency),
    ['failure', 'ambiguity', 'deadline-pressure', 'conflict', 'influence-without-authority']
  )
```

The `scaling` entry being absent is what the test's name is about, and it is now carried by a competency that is genuinely covered rather than one that only looked covered.

**Test 3**, `'the gap scan is skipped entirely when the bank covers everything'` (line 273), and **Test 4**, `'a bank with no gaps never reports a gap scan it did not run'` (line 524), both check the same state by different routes, and that state is now unreachable. Take them together.

Both feed a fixture to `runIngest` as scripted *story-mining* output. Everything mined that way goes through `normaliseStories(mined)`, which stamps `source: 'resume'` unconditionally (`resume-pipeline.ts:313`). There is therefore no fixture that makes either test pass any more: a résumé ingest **cannot** produce a bundle with zero gaps, because the high-risk four are coverable only by `gap-answer` stories, and those exist only after a user answers a question.

That is not a problem to work around — it is the change's most important consequence, and it deserves to be the assertion. **Delete Test 3 outright** (Test 4's replacement below covers the same ground with a stronger claim), and replace Test 4 with:

```ts
// The high-risk four are coverable only by a gap answer, and a gap answer can
// only exist after an ingest. So the scan always has something to ask about,
// however complete the resume looks. This is the point of the rule, stated as a
// test: the four questions a resume cannot answer are always asked.
test('a resume ingest always runs the gap scan, however well covered it looks', async () => {
  const seen: string[] = []
  const full = {
    stories: COMPETENCIES.map((c, i) => ({
      id: `story-${i}`,
      roleId: 'acme-robotics',
      competencies: [c],
      situation: 'Cut p99 checkout latency by 40% at Acme Robotics.',
      task: 'Replace the synchronous pricing call.',
      action: 'Introduced a cache.',
      result: 'Latency fell by 40%.',
      metrics: []
    }))
  }
  const { bundle } = await runIngest(RESUME, scripted({ 'story mining': full }), {
    now: FIXED_NOW,
    onPhase: (p) => seen.push(p)
  })

  assert.ok(seen.includes('gap-scan'))
  assert.deepEqual(
    bundle.gaps.map((g) => g.competency).sort(),
    ['ambiguity', 'conflict', 'failure', 'influence-without-authority']
  )
})
```

This depends on the extended `GAP_QUESTIONS` from the top of this step: `buildGaps` drops any question whose competency is not in `missing`, so without the `influence-without-authority` entry the bundle yields three gaps and this assertion fails.

The branch those two deleted tests protected — never calling the model, and never reporting a phase, when nothing is missing — keeps its coverage in Task 2's `'rescan makes no model call when nothing is missing'`, which reaches the same early return through `rescanGaps`. That is now the only route to it, which is correct: it is the only route that exists.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test src/main/resume-pipeline.test.ts`
Expected: FAIL — the new source-aware tests fail because coverage is still presence-based, and `findGaps` rejects a second argument.

- [ ] **Step 5: Implement source-aware coverage**

Replace `findGaps` in `src/main/resume-pipeline.ts`:

```ts
/**
 * Competencies with no evidence worth trusting behind them.
 *
 * Deterministic rather than a model call: it is a set difference, and asking a
 * model to compute one is both slower and less reliable than computing it.
 *
 * The difference is taken over *trustworthy* evidence, not over tags. For the
 * high-risk competencies only a `gap-answer` story counts, because `profile.ts`
 * defines those four as ones "a resume essentially never evidences on its own" —
 * so a tag on a resume-mined story is precisely the signal that should not
 * silence the question. Observed on a real bundle: one resume-sourced `conflict`
 * story in twenty suppressed the conflict question permanently, and the bank had
 * nothing real behind it at interview time.
 *
 * `existingGaps` excludes anything already asked, whatever its status. `skipped`
 * is the load-bearing case — it is the only thing that makes "I don't have one"
 * permanent. `open` matters too: the question is already on screen and the
 * competency is still uncovered, so without this a rescan appends a duplicate
 * every time. `answered` is belt-and-braces, since its story covers the
 * competency anyway.
 *
 * High-risk competencies sort first — they are where the model would otherwise
 * invent, which is the failure the gap scan exists to prevent.
 */
export function findGaps(stories: Story[], existingGaps: Gap[] = []): Competency[] {
  const covered = new Set<Competency>()
  for (const story of stories) {
    const trustworthy = story.source === 'gap-answer'
    for (const tag of story.competencies) {
      if (trustworthy || !HIGH_RISK_COMPETENCIES.includes(tag)) covered.add(tag)
    }
  }

  const asked = new Set<Competency>(existingGaps.map((g) => g.competency))
  const missing = COMPETENCIES.filter((c) => !covered.has(c) && !asked.has(c))
  const risky = missing.filter((c) => HIGH_RISK_COMPETENCIES.includes(c))
  const rest = missing.filter((c) => !HIGH_RISK_COMPETENCIES.includes(c))
  return [...risky, ...rest]
}
```

Add `HIGH_RISK_COMPETENCIES` to the existing `../shared/profile.ts` import in `resume-pipeline.ts` if it is not already there, and `Gap` to the `./resume-types.ts` import if not already there (it is used elsewhere in the file, so it likely is).

Delete the stray orphaned doc comment that currently sits above `overusedTags` — the "Competencies with no story behind them" block was left behind when `findGaps` moved, and it now describes neither function.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test src/main/resume-pipeline.test.ts`
Expected: PASS, including the two rewritten tests.

- [ ] **Step 7: Verify, format, commit**

```bash
npm test
npm run typecheck
npx prettier --write src/main/resume-pipeline.ts src/main/resume-pipeline.test.ts
npx eslint src/main/resume-pipeline.ts src/main/resume-pipeline.test.ts
git add src/main/resume-pipeline.ts src/main/resume-pipeline.test.ts
git commit -m "fix(gap-scan): a resume tag no longer covers a high-risk competency"
```

---

### Task 2: `rescanGaps` regenerates questions without re-mining

**Files:**
- Modify: `src/main/resume-pipeline.ts` (`buildGaps`, and a new exported function near `answerGap` around line 521)
- Test: `src/main/resume-pipeline.test.ts`

**Interfaces:**
- Consumes: `findGaps(stories, existingGaps)` from Task 1; `LlmClient` from `./structured-llm.ts`; `sealBundle` from `./resume-profile.ts`.
- Produces: `export async function rescanGaps(bundle: ProfileBundle, llm: LlmClient, opts: IngestOptions = {}): Promise<ProfileBundle>`
- Changes: `buildGaps(questions: unknown, missing: Competency[], taken: Set<string> = new Set()): Gap[]` — a third parameter, defaulted so the ingest call site is unchanged.

**The id-collision detail:** `buildGaps` mints ids as `gap-${competency}` against a `taken` set that is local to the call. On a rescan, the bundle may already hold `gap-conflict`. Without seeding `taken` with the existing ids, the new gap gets the same id as the old one — and `gapCursor.ts` tracks the on-screen question *by id*, so two gaps sharing one id makes the pane render the wrong question. This is why `buildGaps` grows a parameter.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/resume-pipeline.test.ts`:

```ts
const RESCAN_QUESTIONS = {
  questions: [
    { competency: 'failure', question: 'Tell me about a project that did not work out.' },
    { competency: 'conflict', question: 'Describe a disagreement with a colleague.' },
    { competency: 'ambiguity', question: 'When were the requirements unclear?' },
    {
      competency: 'influence-without-authority',
      question: 'When did you change minds without being in charge?'
    }
  ]
}

function bundleWith(stories: Story[], gaps: Gap[]): ProfileBundle {
  return sealBundle(
    { version: 1, profile: normaliseProfile(EXTRACTED), stories, gaps },
    '2026-08-09T12:00:00.000Z'
  )
}

test('rescan adds the high-risk questions a resume-only bank is missing', async () => {
  const stories = normaliseStories({
    stories: COMPETENCIES.map((c, i) => story(`s${i}`, null, [c]))
  })
  const before = bundleWith(stories, [])
  const llm = fakeLlm({ 'gap scan': RESCAN_QUESTIONS })

  const after = await rescanGaps(before, llm, { now: FIXED_NOW })

  assert.deepEqual(
    after.gaps.map((g) => g.competency).sort(),
    ['ambiguity', 'conflict', 'failure', 'influence-without-authority']
  )
  assert.ok(after.gaps.every((g) => g.status === 'open'))
})

test('rescan leaves the story bank untouched', async () => {
  const stories = normaliseStories({
    stories: COMPETENCIES.map((c, i) => story(`s${i}`, null, [c]))
  })
  const before = bundleWith(stories, [])
  const after = await rescanGaps(before, fakeLlm({ 'gap scan': RESCAN_QUESTIONS }), {
    now: FIXED_NOW
  })
  assert.deepEqual(after.stories, before.stories)
})

test('rescan preserves answered and skipped gaps with their status and story', async () => {
  const stories = normaliseStories({
    stories: COMPETENCIES.map((c, i) => story(`s${i}`, null, [c]))
  })
  const kept: Gap[] = [
    { ...gap('failure', 'answered'), storyId: 'story-from-answer' },
    gap('conflict', 'skipped')
  ]
  const before = bundleWith(stories, kept)

  const after = await rescanGaps(before, fakeLlm({ 'gap scan': RESCAN_QUESTIONS }), {
    now: FIXED_NOW
  })

  const failure = after.gaps.find((g) => g.competency === 'failure')
  assert.equal(failure?.status, 'answered')
  assert.equal(failure?.storyId, 'story-from-answer')
  assert.equal(after.gaps.find((g) => g.competency === 'conflict')?.status, 'skipped')
  // Only the two that were never asked get added.
  assert.equal(after.gaps.length, 4)
})

// The assertion that would have caught the open-gap duplication.
test('rescan is idempotent', async () => {
  const stories = normaliseStories({
    stories: COMPETENCIES.map((c, i) => story(`s${i}`, null, [c]))
  })
  const once = await rescanGaps(bundleWith(stories, []), fakeLlm({ 'gap scan': RESCAN_QUESTIONS }), {
    now: FIXED_NOW
  })
  // A second pass has nothing missing, so it must not call the model at all —
  // fakeLlm throws on any unscripted label, and there are none scripted here.
  const twice = await rescanGaps(once, fakeLlm({}), { now: FIXED_NOW })
  assert.deepEqual(twice.gaps, once.gaps)
  assert.equal(twice.hash, once.hash)
})

test('rescan makes no model call when nothing is missing', async () => {
  const stories = normaliseStories(
    { stories: COMPETENCIES.map((c, i) => story(`s${i}`, null, [c])) },
    'gap-answer'
  )
  const before = bundleWith(stories, [])
  const llm = fakeLlm({})
  const after = await rescanGaps(before, llm, { now: FIXED_NOW })
  assert.equal(llm.calls.length, 0)
  assert.equal(after.hash, before.hash)
})

test('a rescanned gap never reuses an existing gap id', async () => {
  const stories = normaliseStories({
    stories: COMPETENCIES.map((c, i) => story(`s${i}`, null, [c]))
  })
  // An id shaped exactly like the one buildGaps would mint for `failure`.
  const before = bundleWith(stories, [gap('failure', 'skipped')])
  const after = await rescanGaps(before, fakeLlm({ 'gap scan': RESCAN_QUESTIONS }), {
    now: FIXED_NOW
  })
  assert.equal(new Set(after.gaps.map((g) => g.id)).size, after.gaps.length)
})

test('rescan reseals, so a changed bank changes the hash', async () => {
  const stories = normaliseStories({
    stories: COMPETENCIES.map((c, i) => story(`s${i}`, null, [c]))
  })
  const before = bundleWith(stories, [])
  const after = await rescanGaps(before, fakeLlm({ 'gap scan': RESCAN_QUESTIONS }), {
    now: FIXED_NOW
  })
  assert.notEqual(after.hash, before.hash)
})
```

Add to the test file's imports: `rescanGaps` from `./resume-pipeline.ts`, `sealBundle` from `./resume-profile.ts`, and `type Story` from `./resume-types.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/main/resume-pipeline.test.ts`
Expected: FAIL — `rescanGaps` is not exported.

- [ ] **Step 3: Let `buildGaps` accept ids that are already spoken for**

In `src/main/resume-pipeline.ts`, change the signature and drop the local `taken`:

```ts
function buildGaps(
  questions: unknown,
  missing: Competency[],
  taken: Set<string> = new Set()
): Gap[] {
```

and delete the line `const taken = new Set<string>()` from its body. The ingest call site passes nothing and behaves exactly as before.

- [ ] **Step 4: Write `rescanGaps`**

Add to `src/main/resume-pipeline.ts`, beside `answerGap`:

```ts
/**
 * Regenerate the gap questions for a bundle that already exists.
 *
 * The gap scan otherwise runs only inside `runIngest`, so a change to what
 * counts as coverage reaches an existing user only if they re-upload their
 * resume — a full re-mine, a minute of wall time, and the whole bank replaced.
 * This runs the scan alone: one model call, the stories untouched.
 *
 * Existing gaps are carried through unchanged rather than regenerated. An
 * answered gap has a story behind it and a skipped one is a decision the user
 * made; both are facts, not proposals, and rebuilding them would discard the
 * only record that they happened.
 */
export async function rescanGaps(
  bundle: ProfileBundle,
  llm: LlmClient,
  opts: IngestOptions = {}
): Promise<ProfileBundle> {
  const now = opts.now ?? (() => new Date())
  const missing = findGaps(bundle.stories, bundle.gaps)
  if (missing.length === 0) return bundle

  const wanted = missing.slice(0, Math.max(0, MAX_GAP_QUESTIONS - bundle.gaps.length))
  if (wanted.length === 0) return bundle

  const fresh = buildGaps(
    await llm.structured<unknown>({
      label: 'gap scan',
      maxTokens: STEP_TOKENS.gapScan,
      system: GAP_SYSTEM,
      schema: GAP_QUESTIONS_SCHEMA,
      user:
        `Roles:\n${JSON.stringify(bundle.profile.roles, null, 2)}\n\n` +
        `Competencies with no story: ${wanted.join(', ')}`,
      effort: 'medium'
    }),
    wanted,
    // Seeded with the ids already in the bundle: `buildGaps` mints
    // `gap-${competency}`, and the pane tracks the question on screen by id, so
    // a collision would render the wrong question.
    new Set(bundle.gaps.map((g) => g.id))
  )

  return sealBundle(
    {
      version: bundle.version,
      profile: bundle.profile,
      stories: bundle.stories,
      gaps: [...bundle.gaps, ...fresh]
    },
    now().toISOString()
  )
}
```

The `MAX_GAP_QUESTIONS - bundle.gaps.length` budget keeps the cap meaning what it says across repeated rescans: eight questions total for the bundle, not eight per scan.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test src/main/resume-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify, format, commit**

```bash
npm test
npm run typecheck
npx prettier --write src/main/resume-pipeline.ts src/main/resume-pipeline.test.ts
npx eslint src/main/resume-pipeline.ts src/main/resume-pipeline.test.ts
git add src/main/resume-pipeline.ts src/main/resume-pipeline.test.ts
git commit -m "feat(gap-scan): add rescanGaps for bundles that already exist"
```

---

### Task 3: Wire rescan through the main process

Wiring only. No logic, and nothing here is unit-testable — `ingest.ts` reaches settings and a live LLM client.

**Files:**
- Modify: `src/main/ingest.ts` (beside `skipProfileGap`, around line 159)
- Modify: `src/main/ipc.ts` (beside the gap handlers, around line 242)
- Modify: `src/preload/index.ts` (the `profile` block, around line 72)
- Modify: `src/preload/index.d.ts` (the matching type declaration)

**Interfaces:**
- Consumes: `rescanGaps(bundle, llm, opts)` from Task 2.
- Produces: `rescanProfileGaps(): Promise<ProfileBundle>` in `ingest.ts`; IPC channel `hue:profile:rescan-gaps`; `window.hue.profile.rescanGaps(): Promise<ProfileBundle>`.

- [ ] **Step 1: Add `rescanProfileGaps` to `ingest.ts`**

This mirrors `answerProfileGap` exactly, including the cast and the comment explaining it. Add after `skipProfileGap`:

```ts
/**
 * Re-run the gap scan against the stored bundle.
 *
 * Separate from `ingestResume` because the expensive part of ingest is mining,
 * and nothing about the stories needs to change for the questions to.
 */
export async function rescanProfileGaps(): Promise<ProfileBundle> {
  const bundle = await currentBundle()
  if (!bundle) throw new Error('No profile is linked yet.')

  const llm = await clientForSettings('ingest')
  // The renderer's bundle type is the wide one (competencies as strings, because
  // it is parsed from user-editable JSON); the pipeline works in the narrow one.
  // Safe because `rescanGaps` re-normalises every competency it emits against
  // COMPETENCIES via buildGaps.
  const next = (await rescanGaps(
    bundle as unknown as Parameters<typeof rescanGaps>[0],
    llm
  )) as unknown as ProfileBundle

  const { updateSettings } = await settingsModule()
  updateSettings({ profileBundleJson: JSON.stringify(next) })
  return next
}
```

Add `rescanGaps` to the existing import from `./resume-pipeline.ts` at the top of `ingest.ts`.

- [ ] **Step 2: Add the IPC handler**

In `src/main/ipc.ts`, after the `hue:profile:skip-gap` handler:

```ts
  // Regenerating questions is deliberately a separate channel from ingest: it
  // costs one model call rather than a full re-mine, and it must not be reachable
  // by a path that would replace the story bank.
  ipcMain.handle('hue:profile:rescan-gaps', () => rescanProfileGaps())
```

Add `rescanProfileGaps` to the existing import from `./ingest.ts` in `ipc.ts`.

- [ ] **Step 3: Expose it on the preload surface**

In `src/preload/index.ts`, inside the `profile` block after `skipGap`:

```ts
    /**
     * Re-run the gap scan against the stored bundle. One model call, a few
     * seconds; the story bank is not touched.
     */
    rescanGaps: (): Promise<ProfileBundle> => ipcRenderer.invoke('hue:profile:rescan-gaps')
```

Mirror the declaration in `src/preload/index.d.ts` alongside the other `profile` members. Read that file first — match whatever shape it already uses for `skipGap`, which has the same `Promise<ProfileBundle>` return type.

- [ ] **Step 4: Verify**

```bash
npm run typecheck
npm test
npx prettier --write src/main/ingest.ts src/main/ipc.ts src/preload/index.ts src/preload/index.d.ts
npx eslint src/main/ingest.ts src/main/ipc.ts src/preload/index.ts src/preload/index.d.ts
```

Expected: all clean. The typecheck is the real gate — it verifies the preload declaration matches the implementation, which is the mistake this task can actually make.

- [ ] **Step 5: Commit**

```bash
git add src/main/ingest.ts src/main/ipc.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(profile): expose a rescan-gaps channel"
```

---

### Task 4: The Settings button, and a gap pane that does not grow

**Files:**
- Modify: `src/renderer/src/components/Settings.tsx` (handler beside `onRefreshProfile` around line 1034; button beside "Reload profile" around line 1929; the gap question block above it)

**Interfaces:**
- Consumes: `window.hue.profile.rescanGaps()` from Task 3.

**On the pane not growing.** The gap UI is already one question at a time — `gapCursor.ts` tracks the on-screen question by id, with Back/Next and an "N of M" counter, and it tracks by id rather than index precisely so that answering one does not silently skip the next. So there is no stacked list to shorten.

What does grow is the pane itself, and the answer box is not the culprit — the textarea is already fixed at `rows={3}` (line 1876). Three things are unbounded:

- **The question text** (line 1873, `<div style={{ fontSize: 13 }}>{currentGap.question}</div>`) is model-written against a 400-character clamp, so a wordy one pushes everything below it down.
- **The rejection note** (line 1884) appears and disappears, moving the buttons under the user's cursor between attempts.
- **`gap-dots`** (line 1864) renders one dot per gap. Four dots is a progress indicator; twelve wraps to a second row and shifts the whole pane, and that is exactly where the JD-driven questions take this.

The fix is fixed room, not smaller content: the pane should be the same height on question 1 of 4 as on question 9 of 12.

- [ ] **Step 1: Add the handler**

Beside `onRefreshProfile`:

```ts
  const onRescanGaps = async (): Promise<void> => {
    setResumeStatus('Looking for gaps…')
    try {
      const bundle = await window.hue.profile.rescanGaps()
      set('profileBundleJson', JSON.stringify(bundle))
      const open = bundle.gaps.filter((g) => g.status === 'open').length
      setResumeStatus(
        open === 0 ? 'No new questions — your bank covers every competency.' : `${open} question${open === 1 ? '' : 's'} to answer.`
      )
    } catch (err) {
      setResumeStatus(err instanceof Error ? err.message : 'Rescan failed.')
    }
  }
```

The try/catch is not decoration: the IPC handler throws when no profile is linked and when the ingest provider has no API key, and an unhandled rejection here leaves the pane stuck on "Looking for gaps…" forever.

- [ ] **Step 2: Add the button**

In the row that holds "Reload profile" and "Delete my profile", as the first entry:

```tsx
                    <button type="button" className="link-btn" onClick={onRescanGaps}>
                      Rescan for questions
                    </button>
```

- [ ] **Step 3: Fix the message that made this invisible**

The pane currently renders `Gap scan complete.` whenever no gaps are open (around line 1925). For this user that message has been showing over a bank that was never scanned at all, which is why the missing questions never looked like a problem. Replace it:

```tsx
                    <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
                      No open questions. Rescan if you have added stories or want the
                      high-risk competencies checked again.
                    </div>
```

- [ ] **Step 4: Give the question fixed room**

Add to `src/renderer/src/assets/main.css`, beside the existing `.gap-nav` rule (line 1068):

```css
/*
 * The question is model-written and clamped only at 400 characters, and it sits
 * inside a Settings pane that is already long. Fixed room with its own scroll
 * keeps every control below it in the same place from one question to the next —
 * the buttons must not move under the cursor because question 3 is wordier than
 * question 2.
 */
.gap-question {
  font-size: 13px;
  line-height: 1.5;
  max-height: 4.5em;
  overflow-y: auto;
}

/*
 * Same reason, for the note that appears when an answer is rejected: it must not
 * shift the buttons between attempts.
 */
.gap-note {
  display: block;
  min-height: 2.4em;
  color: var(--text-muted);
  font-size: 12px;
}
```

Then use them. Replace the question div (line 1873):

```tsx
                      <div className="gap-question">{currentGap.question}</div>
```

And replace the conditional note block (line 1884) with an unconditional one, so the space is reserved whether or not there is a note to show:

```tsx
                      <span className="gap-note">{gapNotes[currentGap.id] ?? ''}</span>
```

- [ ] **Step 5: Stop the progress dots from wrapping**

`gap-dots` renders `gapTotal` dots. Past a handful they stop being countable at a glance and start wrapping, which moves everything below them. The count beside them already says the same thing exactly, so drop the dots when there are too many to read:

```tsx
                        {gapTotal <= 8 && (
                          <span className="gap-dots">
                            {Array.from({ length: gapTotal }, (_, i) => (
                              <span
                                key={i}
                                className={i < gapNumberShown ? 'gap-dot gap-dot-filled' : 'gap-dot'}
                              />
                            ))}
                          </span>
                        )}
```

Eight matches `MAX_GAP_QUESTIONS`, so today's ceiling always shows dots and only a future spec that raises the cap turns them off.

- [ ] **Step 6: Verify**

```bash
npm run typecheck
npx prettier --write src/renderer/src/components/Settings.tsx src/renderer/src/assets/main.css
npx eslint src/renderer/src/components/Settings.tsx
npm run build
```

Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/Settings.tsx src/renderer/src/assets/main.css
git commit -m "feat(settings): add a rescan action and stop the gap pane resizing"
```

---

### Task 5: Verify against the real bundle

Tasks 3 and 4 have no automated coverage, and this task is also the only proof the change does what the spec claims for the actual reported bundle. It needs a real API key and spends one model call.

**Files:** none modified. Fix defects in the task that owns the code, then re-run.

- [ ] **Step 1: Full gate**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all clean.

- [ ] **Step 2: Confirm the starting state**

```bash
node -e "
const fs=require('fs'),path=require('path');
const s=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'hue-desktop','hue-settings.json'),'utf8'));
const b=JSON.parse(s.profileBundleJson);
console.log('stories:',b.stories.length,'gaps:',b.gaps.length,'hash:',b.hash.slice(0,12));
"
```

Expected: `stories: 20 gaps: 0`. Note the hash — Step 4 compares against it.

- [ ] **Step 3: Rescan**

Run `npm run dev`, open Settings → the profile pane, press **Rescan for questions**.

Expected: the status line goes to "Looking for gaps…" and then reports **4 questions to answer**. The gap pane shows the first of them, and it should be a real question about failure, conflict, ambiguity, or influencing without authority — phrased against your Solarworks role, since the scan is given `profile.roles`.

- [ ] **Step 4: Confirm the bundle changed correctly**

Re-run the Step 2 command.

Expected: `stories: 20` (unchanged — the bank was not re-mined), `gaps: 4`, and a **different** hash.

- [ ] **Step 5: Check the pane does not resize**

With four questions on screen, press **Next** and **Back** through all of them.

Expected: the Back / "I don't have one" / Next row stays in exactly the same place on every question, however long the question text is. Then type a deliberately unusable answer ("no") and submit it — the rejection note appears **without** moving the buttons.

- [ ] **Step 6: Answer one and skip one**

Answer one gap question with a real story. Expect the count to drop and a story to be added (`stories: 21`).

Then skip a different one. Then press **Rescan for questions** again.

Expected: **no new questions appear** and the skipped one does not come back. This is the idempotency and skip-permanence check, and it is the one most likely to be wrong in a way the unit tests missed, because it crosses the real settings round-trip.

- [ ] **Step 7: Commit anything the smoke test forced**

If Steps 3–5 were clean there is nothing to commit. Otherwise:

```bash
git add -A
git commit -m "fix(gap-scan): <what the smoke test caught>"
```

---

## Notes for the reviewer

**Deliberately not done here**, per the spec:

- **No numeric depth threshold.** `deadline-pressure` and `mentorship` sit at 1/20 in the reported bundle and stay covered, because a résumé genuinely can evidence them. Adding them would need an arbitrary number, and the spec's whole argument is that the principle beats the number. Spec open question 2.
- **Nothing about the job description.** `jobDescription` holds 4005 characters while `jobSpecJson` and `jobBriefJson` are empty, so the JD reaches neither the gap scan nor the answer prompt. That is the next spec and the blocker for JD-driven questions.

**The consequence to watch:** every résumé ingest from now on always produces the four high-risk questions, even for a candidate whose résumé does discuss a failure. That is intended, but it is a permanent four-question tax at first setup.
