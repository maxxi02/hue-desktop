# Coverage is depth, not presence — design

**Date:** 2026-08-21
**Scope:** `hue-desktop` only. One pure function changes meaning, one new pipeline
entry point, one IPC channel, one button. No change to the bundle schema.
**Follows:** [2026-08-19 Labelled answers and endpointing](./2026-08-19-labeled-answers-and-endpointing-design.md),
whose open question 1 — why the grounding chip fires on answers drawn from real
history — this spec answers.

## The problem

The complaint was that Hue answers from its own general knowledge and hedges when
it should be specific. The cause is not the prompt. It is that the gap scan has
never asked this user a single question.

Measured from the installed bundle (`profileBundleJson`, 20 stories, 1 role, all
`source: 'resume'`):

```
 1/20    5%  conflict                      ← high-risk
 2/20   10%  failure                       ← high-risk
 2/20   10%  ambiguity                     ← high-risk
 4/20   20%  influence-without-authority   ← high-risk
 1/20    5%  deadline-pressure
 1/20    5%  mentorship
 3/20   15%  leadership
 4/20   20%  scaling
 5/20   25%  customer-focus
 4/20   20%  data-driven-decision
 8/20   40%  ownership
11/20   55%  technical-tradeoff
```

`gaps: 0`.

`findGaps` (`resume-pipeline.ts:370`) computes a set difference on **presence**:

```ts
const missing = COMPETENCIES.filter((c) => !covered.has(c))
```

Every competency has at least one story, so `missing` is empty, the gap-scan step
is skipped entirely, and the bundle seals with no questions. The user is never
asked anything, no `gap-answer` story is ever created, and at interview time the
bank offers one résumé-mined sentence for `conflict`. The model does the only
thing left available to it.

### The rule contradicts what the module already knows

`profile.ts` names four competencies and says exactly why they are different:

> Competencies a resume essentially never evidences on its own, so their absence
> is expected rather than informative. The gap scan asks about these first — they
> are where the model would otherwise invent, which is the failure this whole
> pipeline exists to prevent.

If a résumé essentially never evidences `conflict`, then a `conflict` tag that
came *from a résumé* is precisely the tag that should not be trusted. Today it is
trusted, and one such tag is enough to suppress the question permanently. The
constant that identifies the unreliable signal exists; nothing consults it when
deciding coverage.

`1/20` is not coverage. It is a tag.

## The design

### 1. Coverage becomes source-aware

`findGaps` stops asking "does any story carry this tag" and starts asking
"is there evidence worth trusting for this tag":

- **The four `HIGH_RISK_COMPETENCIES`** — `failure`, `conflict`, `ambiguity`,
  `influence-without-authority` — are covered **only** by a story with
  `source: 'gap-answer'`. A résumé-mined tag does not cover them.
- **The other eight** keep today's rule: any story covers them.

No numeric threshold. A threshold would be an arbitrary number doing the job a
principle already does, and two weak résumé tags suppress a question exactly as
effectively as one.

**Every fresh résumé now always produces those four questions.** That is the
intent, not a side effect: they are the four a résumé cannot answer, so they are
the four that must be asked. For the bundle above, the change produces exactly
four gaps and leaves the other eight competencies alone.

### 2. Skip has to keep meaning skip

This is the part that only shows up once coverage is source-aware, and it is the
one place the change could become an annoyance rather than a fix.

If `conflict` is covered only by a `gap-answer` story, then a user who answers
"I don't have a conflict story" — recorded as `status: 'skipped'`, deliberately
without a model call — leaves `conflict` permanently uncovered. Every subsequent
scan would ask again. The honest answer would be punished with repetition.

So `findGaps` also takes the existing gaps and excludes any competency that
already has one, **whatever its status**:

```ts
findGaps(stories: Story[], existingGaps: Gap[] = []): Competency[]
```

Each status needs the exclusion for a different reason, and only one of the three
is obvious:

- **`skipped`** is the load-bearing case. It is the only thing that makes a skip
  permanent; without it the honest answer is punished with repetition.
- **`open`** is the one that is easy to miss. An open gap means the question is
  already on screen and unanswered — so the competency is genuinely still
  uncovered, `findGaps` would return it again, and the rescan would append a
  *second* open question for the same competency. Every rescan would add another.
- **`answered`** is belt-and-braces: an answered gap produced a `gap-answer`
  story, which covers the competency anyway.

"Has a gap already" is the single condition covering all three, which is why the
exclusion is on existence rather than on status.

The default of `[]` keeps every existing caller compiling and preserves today's
behaviour for the fresh-ingest path, where there are no prior gaps by definition.

### 3. A rescan that does not re-mine

`refreshBundle` (`ipc.ts:229`) only re-reads the bundle from disk. The gap scan
runs solely inside `ingest()`. So without a new entry point, a fixed rule reaches
an existing user only if they re-upload their résumé — a full re-mine, about a
minute and the full API cost, and it discards the bank they already have.

**New: `rescanGaps(bundle, llm)` in `resume-pipeline.ts`.**

1. `findGaps(bundle.stories, bundle.gaps)`.
2. If nothing is missing, return the bundle untouched and **make no model call**.
3. Otherwise run the one existing gap-scan step — `GAP_SYSTEM`,
   `GAP_QUESTIONS_SCHEMA`, `STEP_TOKENS.gapScan` (~1000 tokens) — with the same
   `Roles: … / Competencies with no story: …` payload the ingest path sends.
4. Merge: existing gaps are kept as they are, new open gaps are appended.
5. Reseal with `sealBundle`, because the bank changed and the content hash is a
   cache key elsewhere.

One model call, a few seconds, no re-mining, no résumé file, existing stories and
answered gaps intact.

`rescanProfileGaps()` in `ingest.ts` wraps it in the shape `answerProfileGap`
already established: `currentBundle()`, `clientForSettings('ingest')`, save
through `updateSettings({ profileBundleJson })`, and return the sealed bundle.
Then `hue:profile:rescan-gaps` in `ipc.ts`, `profile.rescanGaps()` in the preload
surface, and a button in the Settings profile pane beside the existing gap UI.

### 4. Two existing tests encode the old rule

Both in `resume-pipeline.test.ts`. Both are correct today and wrong afterwards,
and updating them is how the change gets recorded rather than a regression to
work around.

- **`'gaps are the set difference, with the invention-prone competencies first'`**
  asserts `!gaps.includes('conflict')`, because the mined fixture carries a
  résumé-sourced conflict story. Under the new rule `conflict` is a gap. The
  assertion inverts, and the test name stops being accurate — it is no longer a
  set difference. Rename it.
- **`'a bank with no gaps never reports a gap scan it did not run'`** builds one
  story per competency so `findGaps` returns empty and the `gap-scan` phase never
  fires. `normaliseStories` defaults `source` to `'resume'` (`resume-pipeline.ts:313`),
  so those stories no longer cover the high-risk four and the scan would run. The
  fixture needs the four high-risk stories switched to `source: 'gap-answer'`.
  The behaviour under test — not reporting a phase that did not run — is
  unaffected and still worth keeping.

## Testing

- **`findGaps`** — pure and already exported, so this carries the weight.
  A résumé-sourced `conflict` story does not cover `conflict`; a `gap-answer` one
  does; the other eight are covered by a résumé story exactly as before;
  high-risk competencies still sort first. Then one case per status, because each
  is excluded for a different reason: a `skipped` competency is never re-asked, an
  `open` one is not duplicated, an `answered` one stays out.
- **Rescan is idempotent** — running `rescanGaps` twice over the same bundle
  produces the same gaps the second time, with nothing appended. This is the
  assertion that would have caught the open-gap duplication.
- **The four-question case** — a bank of résumé-only stories covering all twelve
  tags yields exactly the four high-risk competencies. This is the reported
  bundle, reduced to a fixture.
- **`rescanGaps`** — stories survive unchanged; `answered` and `skipped` gaps
  survive with their status and `storyId`; only new `open` gaps are appended; the
  hash changes when gaps change; **no model call is made when nothing is
  missing**, asserted against a stubbed client that fails the test if invoked.
- **Ingest is unchanged where it should be** — a fresh résumé still runs
  `mining-profile`, `mining-stories`, `gap-scan` in order.

## Open questions

1. **Does `MAX_GAP_QUESTIONS: 8` still fit?** Four high-risk questions are now
   guaranteed, leaving four slots for genuinely uncovered ordinary competencies.
   That is comfortable today. It stops being comfortable if a later spec adds
   job-description-driven or project-depth questions to the same budget, which is
   the next piece of work queued behind this one.
2. **Should `deadline-pressure` and `mentorship` at 1/20 be gaps too?** Under this
   design they are covered, because a résumé genuinely can evidence them. The
   observed thinness may still be worth a question. Deliberately left alone: it
   needs a threshold, and this spec's whole argument is that the principle beats
   a number. Revisit with evidence from a real session.

## Follow-up, not in scope

- **The job description is stored but never parsed.** `jobDescription` holds 4005
  characters while `jobSpecJson` and `jobBriefJson` are both empty, so nothing
  structured about the target role reaches the gap scan or the answer prompt.
  This is the blocker for the JD-driven questions the user asked for, and it is
  the next spec.
- **Project-depth questions** — "for this project, what stack did you use" — are
  not competency questions at all and do not fit the `Competency`-keyed `Gap`
  shape. They need their own design, on top of the JD work.
