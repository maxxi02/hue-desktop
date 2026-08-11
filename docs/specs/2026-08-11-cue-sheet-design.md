# Cue Sheet — design

**Date:** 2026-08-11
**Scope:** `hue-desktop` only. Mobile is explicitly deferred; see [Deferred: mobile](#deferred-mobile).

## The problem

Every answer Hue puts on screen today is generated, and therefore carries two
costs the product spends real machinery on: it can be wrong, and it can be late.
`SpeculationScheduler` exists to fight the latency; `grounding.ts` exists to
fight the invention. Both costs are unavoidable when Hue is answering a question
the user never anticipated.

But users prepare. They arrive with notes — a document of questions they expect
and answers they have already written and rehearsed. For those questions,
generation is the wrong tool: it re-derives, at cost and at latency, an answer
the user already authored better.

A Cue Sheet is that document, turned into something Hue can match against and
surface. When the interviewer asks a question the user prepared for, Hue shows
the user's own words instead of the model's — instantly, with no round trip and
no possibility of invention.

## Why this is worth building

- **Zero invention risk by construction.** The content is the user's, selected
  rather than written. There is nothing to ground because nothing was composed.
- **Zero generation latency on the matched path.** The card is already on disk.
- **It needs no model at match time**, which makes it the first substantial
  capability that works with no key configured and no network.
- **It was expected to save tokens rather than spend them**, by suppressing the
  speculation that would otherwise have fired. **Measured, it mostly does not —
  see below.**

### What the corpus actually showed (2026-08-11)

An honest 111-case corpus (3 sheets, 15 cards, 90 positive and 21 negative
transcripts, written as an interviewer would speak rather than back-derived from
the triggers) gives:

The 90 positive cases have **three** outcomes, not two, and they are reported
here as three because the difference matters to the user: not rendering is a
missed opportunity, rendering the WRONG card is a wrong answer on screen.

| Outcome of a positive case | | |
|---|---|---|
| Hit — the right card renders | 70/90 | **0.778** |
| Wrong-card render — a card renders, but not the prepared one | 7/90 | **0.078** |
| No render — falls through to generation | 13/90 | **0.144** |

| Other bars | | |
|---|---|---|
| False renders on the 21 negative cases | 0/21 | **0** |
| False suppressions | 0/111 | **0** |
| Suppression coverage — generation actually skipped | 10/90 | **0.111** |

**The wrong-card rate is not zero, and an earlier draft of this document implied
it was.** That claim was only ever true of the 21 negative cases, which are the
only ones the original test walked. The worst case is "Tell me about saying no
to a stakeholder who wanted something unreasonable", which renders
`pm-prioritize` over `pm-stakeholder` at 0.741 — two cards that genuinely share
most of their vocabulary. `cuesheet-corpus.test.ts` now asserts this rate as a
regression bar rather than leaving it unmeasured.

So the feature usually shows the user their own prepared answer, occasionally
shows a neighbouring one, and skips generating on roughly one question in nine.
**The token-saving argument above is largely unrealised.** In practice this is a
display path that usually runs alongside generation rather than replacing it.

An initial scoring defect accounted for part of the gap — bigrams were two-thirds
of the score's denominator, capping paraphrase matches near 0.33 — and fixing it
moved suppression coverage from 0.078 to 0.133 and hit rate from 0.722 to 0.778.
Coverage then went back to 0.111 deliberately: `suppressThreshold` was raised
from 0.75 to 0.80 because the old bar cleared the highest wrong-card score
(0.741) by 0.0086, which on a 111-case corpus is luck rather than safety. Two
suppressions is a cheap price for seven times the headroom, given that a false
suppression is the failure that blanks the card mid-interview.

The remaining gap is structural: suppression is deliberately the stricter gate,
because a wrong suppression leaves a blank card mid-interview while a wrong
render costs only a glance. A threshold sweep found no configuration that
narrows the gap without breaking one of the zero bars.

**Consequence for the tier argument.** The claim that this gives free tiers a
substantial capability still holds — matching needs no model and no network, and
0.778 of prepared questions surface the user's own words. The claim that it pays
for itself in saved tokens does not, and should not be repeated in product copy
without this number beside it.

It does not replace speculation. It covers the anticipated questions; generation
covers the rest. The design keeps the two strictly ordered rather than competing.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Fallback-first**: a confident match wins and generation is skipped; anything less falls through to speculation. | One thing on screen at a time. Side-by-side doubles the reading load at the worst moment. |
| 2 | Uploaded prose is **reduced to 3–5 bold cues**, not rendered as prose. | Discourages reading verbatim — the most detectable failure mode. |
| 3 | Matching uses **trigger phrases generated at ingest**, matched lexically at runtime. | Semantic coverage with no runtime model call. Testable offline. |
| 4 | A match **latches at the final** and holds until the next question. | The card must not move while the user is mid-answer. |
| 5 | `CueSheet` is a **separate artifact from `ProfileBundle`**, ingested **locally** via `src/main/anthropic.ts`. | Resume ingest is a remote service; cue sheets are per-interview and must not churn the cached prompt prefix. See below. |
| 6 | Suppression is enforced by the **caller, not the scheduler**. | `SpeculationScheduler` is triplicated across desktop/mobile/edge and must stay identical in all three. |
| 7 | The cue scorer is **new code**; `tokenF1` and `tokens()` are not touched. | They are load-bearing for the commit gate and have no direct unit test. |

### On decision 5

Two facts drive this, and both differ from what the prose in `profile.ts` implies:

**Resume ingest is remote.** `src/main/ingest.ts` is an HTTP client — it POSTs
bytes to `${ingestBaseUrl}/v1/accounts/{id}/ingest`, polls a job, and fetches a
bundle by hash. It never imports `src/main/anthropic.ts`. Routing cue sheets
through that service would mean shipping a coordinated change to a second repo
before anything works on desktop, which defeats "desktop first".

Desktop already has a direct Anthropic path (`src/main/anthropic.ts`) with the
user's own key. Cue sheet ingest uses it. The privacy consequence is a genuine
improvement worth stating plainly: a cue sheet is a user's rehearsed answers for
a named employer, and under this design it goes to the model provider and nowhere
else — never to Hue's own infrastructure.

**The bundle hash is not a cache key on desktop.** `ProfileBundle.hash` is
received from the service, stored, validated as non-empty, and never read again.
Nothing in `src/` computes a hash; there is no `hue-edge` client. Anthropic
prompt caching is positional — `anthropic.ts` marks the system block
`cache_control: { type: 'ephemeral' }`.

That still argues for keeping the artifacts separate, but for a different and
more immediate reason: the profile block is rendered by `profilePromptBlock()`
into that cached system prefix. Appending per-interview notes to it would
invalidate the ephemeral cache at the start of every session, and edit it every
time the user tweaks their notes. A separate artifact that never enters the
system prompt cannot do that.

## The artifact

A `CueSheet` is a per-interview document. A user may hold several — one per
company — and selects one at session start. It is immutable once ingest
completes; the segmentation confirmation described below happens *during* ingest,
on a draft that is not yet a `CueSheet`.

```ts
interface CueSheet {
  id: string
  label: string          // user-facing, e.g. "Apollo — 1st level support"
  sourceHash: string     // hash of the uploaded text; re-ingest / dedupe key
  createdAt: string
  cards: CueCard[]
}

interface CueCard {
  id: string
  heading: string        // "Why support instead of development?"
  cues: string[]         // 3–5 bold lines. This is what renders.
  script: string         // the full prepared passage, behind a disclosure
  triggers: string[]     // ~8–15 paraphrases. Never rendered; search index only.
}
```

`cues` renders. `script` is revealed on demand. `triggers` is never shown to the
user under any circumstance — it exists solely to be matched against.

### Persistence

Settings live in a single hand-rolled JSON file — `hue-settings.json` in
`app.getPath('userData')`, written whole on every update by `src/main/settings.ts`.
The profile bundle is already stuffed into it as a `profileBundleJson` string.

Cue sheets do **not** follow that precedent. They are plural, per-interview, and
each carries a full document; accumulating several into the settings blob means
rewriting every sheet to disk on every unrelated settings change. They are stored
as individual files under `userData/cue-sheets/{id}.json`, with only the selected
sheet id in settings.

Note for the security review: `profileBundleJson` is not in
`SECRET_SETTING_KEYS`, so the profile is already stored in plaintext — only API
keys and the ingest token get `safeStorage` encryption. Cue sheets are the same
class of content (personal, not credential) and are stored the same way. Calling
this out because it is a deliberate consistency choice, not an oversight.

## Ingest

A new `src/main/cuesheet-ingest.ts`, calling `src/main/anthropic.ts` directly,
with an IPC surface mirroring the profile one (`hue:cuesheet:ingest`,
`:progress`, `:list`, `:select`, `:delete`) and a hidden file input in the
Settings drawer, exactly as `Settings.tsx` already does for the resume.

Text extraction is local, using `unpdf` and `mammoth` — both already
dependencies — plus plain text and markdown.

### Segmentation

Split on markdown headings, falling back to `Q:`-style lines when headings are
absent, which is the shape prepared interview notes usually already have. If
neither is present, the model proposes a split and the user confirms it before
the sheet becomes usable. The pipeline never silently guesses where one answer
ends and the next begins.

### Grounding, and the one deliberate exception

**`src/shared/grounding.ts` is not the mechanism here, and must not be extended
to become it.** It is a *citation receipt* check: `resolveGrounding(claimedId,
bundle)` looks up one `story_id` against `bundle.stories` by exact match. It is
hard-coupled to `ProfileBundle`, handles exactly one citation per response, and
its header explicitly forbids ever adding fuzzy matching — because an id that is
merely *near* a bank entry is an invented story wearing a real label. "Is this id
in the bank" and "is this sentence in the source document" are different
problems, and merging them would weaken the strictest check in the product.

Cue grounding is a new, narrow check in `cuesheet.ts`:

- `script` is **extractive by construction** — ingest selects a span of the
  source document rather than writing prose. Verification is a containment check
  against the normalised source, not a judgement call.
- `cues` are compressions of their own card's `script`, and are verified against
  it by **order-preserving subsequence plus negation parity** (see the correction
  below). A cue introducing a claim, number, or employer absent from the span the
  user wrote is dropped, and the card shows fewer cues.

**Correction (2026-08-11, found in review of the implementation).** This spec
originally specified cue verification as content-word *coverage* — every content
word in the cue must appear in the script. That check is unsound. Set membership
is blind to both order and omission, so these pass while inverting the source:

| script | cue | verdict under coverage |
|---|---|---|
| "I did not cut costs." | "Cut costs" | passes — **claim inverted** |
| "I cut costs and grew the team." | "Grew costs, cut team" | passes — **roles reversed** |

Both produce a bold line the user reads aloud in a live interview, which is
precisely the failure this check exists to prevent. The check is now:

1. A cue tokenising to nothing is rejected. Under `.every()` an empty array is
   vacuously true, so an all-stopword cue previously survived even when its
   script had already been rejected.
2. The cue's tokens must appear in the script **in order**, as a subsequence.
   This defeats scrambling.
3. Every negation token from the **start of the script** through the cue's last
   matched token must also appear in the cue. This defeats omission — the
   inverted example above is a valid subsequence, and is caught only by this rule.

   The span must start at the beginning of the script, not at the cue's first
   matched token. An earlier draft of this correction said "the span the cue
   covers", meaning `firstIdx..lastIdx`, and that is wrong: in `[not, cut,
   costs]` the cue "Cut costs" matches indices 1–2, so a `firstIdx`-anchored span
   excludes the very `not` that inverts it. The negation would slip through and
   the Critical bug would be live again.

   **The known cost was measured, and it was far worse than "will thin cards
   out".** See the correction below.

Negation words are deliberately excluded from `STOPWORDS`; adding one there would
silently re-open the inversion hole.

**Accepted cost:** a legitimate cue that reorders for readability ("Cut payload,
reduced latency" from "reduced latency by cutting the payload") is rejected.
That asymmetry is intentional — dropping a good cue degrades a card, keeping a
misleading one puts a false claim in the user's mouth.

### Second correction (2026-08-11, from measuring the rule above)

Run over the corpus's own 56 hand-written faithful cues, each against its own
card's script, the rule above kept **8**. Every one of the 15 cards lost cues
and **10 of 15 lost all of them**. A card with no cues is filtered out at
ingest, so a sheet built from that corpus would have reported "no usable cue
cards were found": the feature would have appeared simply broken.

The dominant cause was not the negation span. Subsequence-over-`cueTokens`
demanded exact surface forms, in exact order, with no inserted words, and real
compression does none of those things — "Read replicas plus a write queue" from
a script saying "split reads onto replicas… moved the hottest write path onto a
queue" fails twice over, on `read`/`reads` and on a "plus" the script never
used. Three changes, each measured against the corpus:

- **Stem, not surface form.** A small hand-written suffix stripper (`ies`→`y`,
  `ing`, `ed`, plural `s`, a doubled final consonant, a trailing `e`), applied
  to both sides. Deliberately not a stemming library: this needs to unify
  `read`/`reads` and `cause`/`causing`, not to decide that "university" and
  "universe" are one word.
- **A bounded connective budget.** `ceil(n/4)` cue tokens may be absent from the
  script — the "plus", "first", "instead" that compression inserts. An
  unmatched token may never carry a digit, and may only be a negation where the
  script's own covered span already contains a contrast marker: a cue may echo
  the user's "instead of" as a "not", it may not invent a "never".
- **Anchoring at any sentence start.** Matching greedily from token zero picks
  the first occurrence of a repeated word and drags every negation in between
  into the span. A cue drawn from the third sentence is now judged against the
  third sentence.

Two further defeats found in review are also closed. Negation parity is
**counted**, not set-tested, so one "never" in a cue no longer satisfies two in
the script. And the span runs to the end of the **clause** containing the last
matched token, so "I never cut costs without approval from finance" no longer
licenses "Never cut costs". Extending to the end of the *sentence* instead was
measured and rejected: it pulls in negations from later, unrelated clauses and
costs 12 points of keep rate to catch the same case.

**Measured result: keep rate 0.143 → 0.500 (8/56 → 28/56); cards left with no
cues 10/15 → 1/15.**

**0.500 is short of the 0.80 the review asked for, and the target is not
reachable.** With the reordering rule abandoned entirely, the measured ceiling
on this corpus is 0.786 — because roughly a third of the corpus's own faithful
cues locally reorder ("Block deep work before meetings fill the day" from "I
block time for deep work before the day fills with meetings"). Rejecting
reordering and reaching 0.80 are in direct conflict on real compression;
rejecting reordering was the explicit safety requirement, so it is the target
that gave way. The bar in `cuesheet-corpus.test.ts` is set at what was measured.

### What this check does not verify

**It verifies the provenance of WORDS, not the provenance of CLAIMS.** It can
tell you every word in a cue came from the script, in the script's own order,
without dropping a negation. It cannot tell you the cue asserts what the script
asserted. Two classes of distortion are outside it entirely, and no amount of
tightening the containment rule reaches them:

| script | cue | why it passes |
|---|---|---|
| "My manager decided the architecture and I implemented it." | "Decided the architecture" | `my` and `i` are stopwords, so **who did what never enters the compared token stream**. Re-attribution is invisible. |
| "I cut costs by 5 percent while the target was 40 percent." | "Cut costs by 40 percent" | both numbers are the user's own words, in the script's own order. The fabrication is in the **pairing**, not in the vocabulary. |

Both are recorded in a test named `KNOWN GAP` so the passing suite is never
read as a claim that cue text is safe against every distortion. Closing either
needs a claim-level model — a different check from this one, and one that can
itself be wrong, which is exactly what containment was chosen to avoid.

Dropping a cue degrades a card; it never invalidates the sheet.

`triggers` are **exempt**, deliberately. Their whole purpose is to contain
phrasings that are *not* in the source — that is what lets Hue catch a question
worded differently than the user wrote it. Grounding them would defeat them. The
exemption is safe because nothing a trigger contains can reach the user's mouth:
they are never rendered and never spoken.

## Runtime

### Placement

A new pure module, `src/shared/cuesheet.ts`, exporting `CueMatcher` and
`gateCommands`. No Electron, no React, no I/O, no timers — in the same style and
for the same reason as `speculation.ts`. Purity is what makes the fixture suite
below possible.

`VoicePipeline` in `src/renderer/src/lib/pipeline.ts` is the caller.

### Scoring

Per card, score is the best score across its `triggers`.

**The scorer is new. `tokenF1` and its private `tokens()` helper are not
modified.** The temptation is real — `tokenF1` measures roughly the right thing —
but it is load-bearing in ways invisible from its signature:

- `tokens()` is shared by `commits()`, `opensAQuestion()` and therefore
  `isInterrogative()`. Adding stopword-stripping to it changes when the scheduler
  believes a question has opened — a speculation behaviour change wearing a
  cue-sheet disguise.
- `commits()` short-circuits on a token-prefix check *before* reaching `tokenF1`,
  so that path shifts too.
- `commitThreshold: 0.85` is calibrated against a worked example in the file's own
  doc comment (precision 1.0, recall 8/11 → 0.84). `tokenF1` has **no direct unit
  test** — it is covered only indirectly through commit/no-commit behaviour, so a
  regression would not announce itself.

The two notions of "same question" are genuinely different anyway. The scheduler
asks *did the question I fired on survive to the final*, wanting strict literal
similarity. The matcher asks *is this one of the questions the user prepared for*,
wanting deliberate looseness. One scorer serving both would be tuned for neither.

The cue scorer applies:

- **stopword stripping**, so "tell me about a time when you" contributes nothing
- **bigram weighting**, so "biggest weakness" outscores loose hits on "biggest"
  and "weakness" in unrelated clauses
- **rarity weighting** by document frequency across the sheet's own trigger set,
  so a term appearing in every card carries no discriminating signal
- **Unicode-aware tokenisation** (`\p{L}\p{N}`), matching `containsResetMarker`
  rather than `tokens()`. `tokens()` splits on `[^a-z0-9']+`, treating every
  accented or non-Latin character as a separator — tolerable where it is, but it
  would silently shred any cue sheet not written in ASCII.

### Two thresholds

Speculation fires *during* the question so the draft is ready when it ends. A cue
decision taken only at the end would save latency but pay for the draft anyway.
So the matcher runs continuously, with two gates:

| Gate | When | Initial | Effect |
|---|---|---|---|
| **Suppress** | Each interim | 0.72 | Pipeline declines to start generation for this question. Where the token saving comes from. |
| **Render** | Once, on final | 0.55 | The winning card latches and displays. |

The asymmetry is deliberate. A wrong suppression risks no draft *and* no cue — a
blank card mid-interview, the worst outcome in the system. A wrong render is
merely visibly wrong and costs a glance. So suppression is set conservatively
high and render permissively low.

Both are starting points, calibrated against the fixture suite. They are not
guesses to be left alone; the suite is what sets them.

### Margin gate

A card must clear its threshold **and** beat the runner-up by ≥ 0.10, at **both**
gates. Two cards at 0.71 and 0.69 is not a match, it is a coin flip the user pays
for. Ambiguity falls through to speculation, which is correct: generation is
precisely the tool for questions the sheet does not cleanly cover.

### Suppression without touching the scheduler

`SpeculationScheduler`'s header states its rules are ported verbatim to
`hue-mobile/core-speculation` and `hue-edge`, and that a divergence means two
implementations render different answers to the same question in a mirrored
session. Making the scheduler cue-aware would require the same change in three
places and couple a desktop-first feature to the phone and the edge.

So the scheduler is not modified. Every `Command[]` it produces funnels through
exactly two methods — `applyInterimCommands` and `applyFinalCommands` — fed from
three call sites (`onSpeechEnd`, `beginSegment`'s tick, `runInterim`). A
`gateCommands` call at the top of those two methods intercepts all command flow.

**Dropping `fire` alone is not sufficient, and this is the subtle part.** If the
gate swallows a `fire`, the scheduler still believes a draft is in flight: its
internal `draft` is set, and `accepts(specId)` will subsequently reject the
deltas of a draft the pipeline *did* want. Suppression must therefore drop the
`fire` **and** call `scheduler.reset()`, returning the scheduler to a coherent
no-draft state.

**Correction (2026-08-11, found in review of the implementation).** An earlier
draft of this spec claimed that with no draft in flight `onFinal` emits
`regenerate`, and that the recovery path below therefore came for free. That is
false. `speculation.ts`'s `onFinal` no-draft branch reads:

```ts
if (!inFlight) {
  this.firesThisQuestion = 0
  return normalised.length === 0 ? [] : [this.fireCommand(normalised)]
}
```

It emits a **`fire`** — endpoint-then-generate at unspeculated latency.
`regenerate` comes only from the other branch, where a draft exists but answers a
different question.

This matters because the gate drops `fire` under suppression. A question that
suppressed mid-way, reset the scheduler, and then still scored as suppressing at
the final would have its endpoint `fire` dropped too, and nothing would ever be
generated — the blank card this design exists to prevent, reachable rather than
theoretical.

The rule is therefore explicit and structural: **suppression may drop a `fire`
only while the question is still in progress. At the final, a `fire` always
passes through.** It is enforced inside `gateCommands` rather than by the caller
choosing safe flags, because a safety property that holds only while the caller
cooperates is not a safety property.

**Teardown outside the dispatchers.** `abortResponse()` independently calls
`abortSpeculation()` and `scheduler.reset()` without passing through either
dispatcher — it is the barge-in, stop, and clear-history path. Cue latch state
must be cleared there too, or a latched card survives a session stop and reappears
attached to the next question.

### Suppression recovery

Suppression is decided on a partial transcript; render is decided on the full
one. A question can suppress mid-way and then fail the render gate — the
interviewer's second clause turned it into a different question. Unhandled, that
produces exactly the blank card the threshold asymmetry exists to prevent.

Recovery is explicit: because the gate never drops a `fire` at the final, the
scheduler's endpoint-then-generate command always reaches the pipeline. The user
pays full generation latency for that question — the honest cost of a suppression
that turned out wrong, and strictly better than a blank card.

The intended metric here was **suppression regret**, the signal that the suppress
threshold is too low. It is not implemented: it belongs with the other metrics
work, which is blocked on `SpeculationMetrics` living inside the scheduler this
design may not modify. The false-suppress bar in the fixture suite is the actual
guard; this path is the runtime backstop for cases the corpus lacked.

### The latch and stale renders

On `onFinal`, the final match runs against the full transcript. Clearing the
render threshold and the margin gate latches the card, which then holds until the
next question begins.

On stale renders, one correction to the README's account. It says the renderer
"drops any delta whose `specId` is not current". Mechanically, deltas carry a
`streamId`, not a `specId`; `onLlmDelta` matches `e.streamId === this.specStreamId`
and then checks `scheduler.accepts(this.specId)` against the pipeline's own
tracked id. Speculative deltas are never rendered while streaming at all — they
accumulate into `specText` and are shown only by `commitSpeculation`.

The guard therefore already prevents a stale draft from *committing* over a
latched cue, provided the latch clears `this.specId`. Latching sets `specId` to
null and aborts any in-flight generation — a generation nobody will read still
costs money and can still win a race.

### Metrics

A suppressed `fire` is counted separately rather than as a miss. Speculation hit
rate is the number the scheduler's own thresholds are tuned against; polluting it
with cue-sheet decisions would misdirect that tuning.

## Testing

Tests run under the existing `npm test` — `node --test src/**/*.test.ts`, native
type stripping, no build step, colocated `*.test.ts` files importing source with
explicit `.ts` extensions, matching `speculation.test.ts` and `grounding.test.ts`.

### Matcher fixtures (offline, no keys)

A corpus of cue sheets paired with many real phrasings of each question, plus
phrasings that must match nothing. Two metrics, deliberately different bars:

- **Hit rate** at the render threshold — how often the right card wins. Soft bar;
  misses fall through to speculation, a degraded but correct outcome.
- **False-suppress rate** at the suppress threshold — how often Hue kills
  generation for a question it cannot then answer from the sheet. **Hard bar:
  zero across the corpus**, because it is the only failure that blanks the card.

### Trigger-quality eval (calls the real model)

Trigger generation is prompt- and model-dependent: a prompt tweak can degrade
match quality with every offline test still green. Run on every prompt or model
change. Gated behind an env key so `npm test` stays offline — no current test
touches the external network and that should remain true.

### Gate tests

`gateCommands` is pure and tested directly: suppression drops `fire` and pairs it
with a reset; `abort`/`commit`/`reset` always pass through; a latch clears on the
`abortResponse` teardown path; a suppressed question that fails to latch yields
`regenerate`.

### Targeted refactor

`pipeline.ts` is 980 lines in a single `VoicePipeline` class with three exports
and no free functions. The gate is therefore extracted as a pure
`gateCommands(commands, matchState): Command[]` in `cuesheet.ts`, unit-tested
there; `pipeline.ts` calls it and performs the result. This is the minimum
extraction that keeps new logic testable. Broader decomposition of `pipeline.ts`
is out of scope.

`src/main/ingest.ts` has no test file today. `cuesheet-ingest.ts` gets one.

## Failure cases

| Case | Behaviour |
|---|---|
| Question phrased beyond every trigger | Scores low, falls through to speculation. Working as designed. |
| Multi-part question | Two cards score close, margin gate rejects, falls through. |
| Follow-up ("can you expand on that?") | No content words, nothing clears threshold, the existing latch stays on screen. Correct, and free. |
| Wrong sheet loaded | Nothing matches; Hue behaves as it does today. After 3 consecutive non-matches, a quiet hint. |
| Empty or single-card sheet | Rarity weighting degrades to uniform; matching still works. No special case. |
| ASR error inside the key phrase | Lowers the score, usually below threshold, falls through. The fallback is the current product. |
| Suppressed, then final fails to latch | Immediate `regenerate`. Full latency for that question; never a blank card. Counted as suppression regret. |
| Session stopped mid-latch | `abortResponse` teardown clears latch state. |

## The mic-mode hazard

`Speaker` is not diarization. The only runtime producer is:

```ts
private speakerOfIncomingSpeech(): Speaker {
  return this.settings.hueMode === 'companion' ? 'interviewer' : 'self'
}
```

It is a settings lookup. `'unknown'` is never produced. No ASR provider is
configured for diarization — Deepgram is called without `diarize`, AssemblyAI
without `speaker_labels`, and `CloudAsrResult` carries only `{ text, provider }`.

So in companion mode **everything Hue hears is labelled `interviewer`**,
including the user's own voice — and whether it hears the user depends on
`settings.audioSource`, not on `hueMode`. With `'system'` (loopback) it hears only
the far side and the feature is safe. With `'mic'` it hears the room, and when the
user delivers their answer from a cue card, their own speech is a near-verbatim
match for that card's `script`.

This is the mobile hazard, present on desktop, and it was not obvious: "desktop
takes clean loopback" is true of the default, not of the setting. Two mitigations,
both in scope:

1. ~~**Never re-latch the currently latched card.**~~ **Dropped — see below.**
2. **Score `script` as an anti-signal.** An utterance matching a card's `script`
   far better than its `triggers` is someone reciting an answer, not asking a
   question; matching is suppressed for that utterance. Triggers are questions and
   scripts are answers — lexically distinct enough to separate.

**Amended (2026-08-11, review found mitigation 1 was never implemented).** Only
mitigation 2 ships. The spec is corrected here rather than the code, and the
reasoning is that mitigation 1 is not free after all — "costs nothing" was
wrong on both halves.

It does not add coverage. The failure it targets is the user's own recited
answer arriving labelled `interviewer` and re-matching the card it was read
from. Mitigation 2 catches exactly that, earlier and by a better signal: it
tests whether the utterance looks like an *answer*, which is the actual
property, rather than whether it happens to hit the same card, which is a
proxy.

And it has a real cost mitigation 2 does not. `decide()` sees `this.latch`
holding the previous question's card, so a re-latch block cannot distinguish a
recitation from an interviewer genuinely repeating themselves — "sorry, say
that again, how do you prioritise?", or a follow-up circling the same ground.
Those are questions the user prepared for, and the rule would deny them their
card and send them down the generation path instead. That is a worse outcome
than the one it prevents, in a case that is more common in a real interview.

The remaining exposure is a recitation whose script/trigger ratio falls under
`recitationRatio` — real, and better addressed by tuning that ratio against
recorded sessions than by a structural rule with this side effect.

## Out of scope

- Editing cue sheets in-app beyond confirming an ambiguous segmentation.
- Syncing cue sheets to the phone over `hue-relay`.
- Any change to `SpeculationScheduler` in any of its three implementations.
- Any change to `tokenF1`, `tokens()`, or `grounding.ts`.
- Broader decomposition of `pipeline.ts`.
- Adding a cue-sheet endpoint to the remote `hue-ingest` service.

## Deferred: mobile

`hue-mobile` captures acoustically and always hears both sides of the room, so
the mic-mode hazard above is its default rather than its edge case. Both
mitigations are required there rather than merely prudent, and its
`UtteranceSegmenter` provides an `Endpoint` reason (`SILENCE` vs `MAX_LENGTH`)
that desktop lacks — a `MAX_LENGTH` latch should be provisional and replaceable by
its continuation, which has no desktop equivalent.

Deferred until the desktop matcher's thresholds are calibrated against real
sessions, since porting an untuned matcher would mean tuning it twice.
