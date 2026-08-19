# Labelled answers, and an endpoint that waits for the whole question — design

**Date:** 2026-08-19
**Scope:** `hue-desktop` only. Two new modules land in `src/shared/`, which
`hue-mobile` mirrors in Kotlin; porting them is named as follow-up work here and
is not part of this change.
**Follows:** [2026-08-19 Remove prepared answers](./2026-08-19-remove-prepared-answers-design.md),
whose four-beat answer this spec is the repair of.

## The problem

Two screenshots from a live session, one after the other.

> **Interviewer:** Walk me through your brass.
>
> **Hue:** I'm honestly not sure what you're referring to, but if you're asking
> about the brass tacks, meaning the core details of how I work, I can walk you
> through the main things I focus on day to day. [...] If that wasn't what you
> meant by brass, feel free to point me in the right direction and I can get more
> specific.

> **Interviewer:** when you are testing a new endpoint for the first time.
>
> **Hue:** When I'm testing a new endpoint for the first time, I start by
> defining the expected request shape [...] so the next person doesn't have to
> redo the manual checks.

Those are not two questions. The user has confirmed the interviewer said one
sentence with a pause in it:

> "Walk me through your brass tacks **when you are testing a new endpoint for the
> first time**."

The VAD closed the segment on the breath. Everything visible in those two cards
follows from that one fact, and the defects it exposes are worth separating,
because only the first is caused by the split.

1. **The question was cut in half.** `redemptionMs: 700` (`pipeline.ts:259`)
   ended the utterance mid-sentence. Hue answered a five-word fragment.
2. **It asked a clarifying question, live.** The prompt already forbids exactly
   this: the user "can't relay a clarifying question mid-call". The answer opens
   "I'm honestly not sure what you're referring to" and closes by asking the
   interviewer for direction. The worst available output, because it makes the
   *user* look lost rather than Hue.
3. **No paragraph breaks reached the screen.** `paragraphs()` is correctly wired
   to the answer card (`App.tsx:978`), so the renderer is not at fault. The model
   emitted one unbroken block. `FOUR_BEAT_SHAPE` was ignored.
4. **Length was unenforced.** The prompt asks for "roughly three to five
   sentences". The second card is roughly ten, about 230 words.
5. **"Not anchored to your history" showed on both cards** even though the
   answers draw on Solarworks, Zod, and the lead-capture pipeline, which are the
   user's real history.

Defect 3 has a structural cause that also explains 2 and 4, and it is not the
shape instruction being wrong.

### The system prompt is one run-on paragraph, and it contradicts itself

`buildCompanionPrompt` ends with `parts.join(' ')`. Every rule in it, roughly
1200 words, is joined into a single undifferentiated paragraph with the shape
instruction appended last. Two of those rules disagree:

> **part 4:** "Weave one concrete, real-life example directly into the answer so
> it backs up the point **as part of the flow**"
>
> **`FOUR_BEAT_SHAPE`:** "four short beats, **each its own paragraph separated by
> a blank line**"

Flow, or four paragraphs. The model chose flow. The same wall is where the
never-ask-for-clarification rule and the three-to-five-sentence rule are buried,
and both were ignored in the same response.

This is the failure mode `answer-shape.ts` already documents in its own header
comment about em dashes: a concrete instruction outweighs an abstract rule, and a
prompt that argues with itself resolves unpredictably. Adding a further
instruction to that wall cannot be the fix, because the wall is the fix.

### Defect 5 is a false negative, not a fabrication

Worth stating plainly, because the alarming reading is the wrong one. Solarworks
and Zod are the user's genuine history: the preceding spec quotes them as the
user's own worked example of the answer shape. So the answers were drawn from
real background and the chip still fired.

That makes the chip a cry of wolf, which `pipeline.ts` already worries about by
name ("alarm fatigue by construction"). The cause is not yet established: either
no `ProfileBundle` is installed, in which case the prompt never asks for a
`story_id` at all and grounding can never resolve, or a bundle exists and the
model omitted the citation line. These need different fixes, so this spec
diagnoses rather than guesses. See Open Questions.

## The design

Five pieces, in dependency order. The ordering is load-bearing: piece 4 is the
feature that was asked for, and doing it before piece 3 would add new markers to
the same self-contradicting wall and reproduce defect 3 with extra steps.

### 1. Endpointing: hold the final, merge the continuation

Stop treating the first `onSpeechEnd` as the end of the question. Hold the final
briefly. If another interviewer segment opens inside the hold, concatenate it and
carry on; if the hold expires, the question is over and the final ships.

**Why a timing gate rather than a punctuation or grammar heuristic.** The
structure of an interview does the work. After the interviewer actually finishes,
*the candidate talks* — that is the whole premise of the product. An interviewer
segment arriving a few hundred milliseconds after the previous one is therefore
almost never a new question; it is the back half of the one already being asked.
Punctuation cannot carry this: Whisper stamps a confident full stop onto
fragments, and "Walk me through your brass." has one.

**Why the hold is free.** During it, the speculative draft is still in flight and
still valid. The wait costs no perceived latency because it is spent inside time
speculation has already paid for. This is the reason `redemptionMs` is left alone
at 700 rather than tuned: the hold subsumes what tuning it would try to buy, and
shortening it — which an earlier reading of the latency budget suggested — would
have made this defect strictly more frequent.

The general principle, which is worth stating because it is not obvious from the
speculation design as written: **speculation is not only a latency win; it is what
buys the budget to endpoint accurately.**

It also fits the existing scheduler without special cases. Merged text is a clean
prefix extension of the first fragment, so `invalidation()` returns
`'prefix-extension'` and an in-flight draft keeps running rather than aborting.

**New module: `src/shared/endpointing.ts`.** Pure, in the discipline
`speculation.ts` sets and for the reason it gives: no timers, no I/O, no browser
globals, `now` passed in rather than read, so the whole behaviour matrix runs
against a fake clock under plain `node --test`.

```
holdMs: 700          // gap below which a new segment is a continuation
maxHeldSegments: 3   // a monologue must not accumulate without bound
```

`maxHeldSegments` exists for the same reason `INTERIM_MAX_SAMPLES` does: nothing
guarantees a VAD segment is one sentence, and an interviewer who talks
continuously must not defer the answer indefinitely.

### 2. The `commits()` length-ratio floor

A bug found while tracing the merge path. It is latent today and the endpoint
hold would make it fire routinely, so it is fixed here rather than filed.

`commits()` in `speculation.ts` returns true for any clean prefix extension, at
any length ratio:

```
fired on: "walk me through your brass"                    (5 tokens)
final:    "walk me through your brass tacks when you are
           testing a new endpoint for the first time"     (14 tokens)
```

Prefix match, so it commits — shipping the draft written for "your brass" as the
answer to a question about endpoint testing. That is the product's stated worst
failure (confidently rendering the answer to a question nobody asked) reached
through the commit gate rather than through a stale `specId`.

The prefix rule is justified in its own comment by noting that token F1 unfairly
penalises a final that merely got longer, scoring 0.84 on a case that should
commit. That reasoning is sound for a few trailing words and does not hold at
3x. Add a floor: a prefix extension commits only when the final has not grown
past `1.75x` the fire text in tokens. Beyond that, fall through to F1, which will
correctly refuse and regenerate.

### 3. The prompt, restructured

`parts.join(' ')` becomes a sectioned prompt with headed blocks, ordered so the
output contract is last and unambiguous:

1. Role and situation
2. Grounding rules and the profile bundle
3. Job posting and brief
4. Voice
5. **Output contract** — shape, labels, length

The contradiction is deleted, not layered over. Part 4's "as part of the flow"
wording goes; the real-life example is now a named section of the output contract
rather than something woven into prose. Its "no headings, no labels" clause is
rewritten to "no labels **inside** the spoken prose — the section markers are app
chrome and are stripped before the user sees the answer", which is the same
contract `story_id` already keeps and which the model already honours.

Never-ask-for-clarification and the length rule are lifted out of the wall into
the output contract, where the evidence says they need to be.

### 4. Labelled beats and the 50/50 scenario

The feature as asked for: each beat of the direct answer carries a label in the
card's margin, and the real-life scenario gets its own half.

**Marker format.** A sentinel line of its own, matched against a closed
vocabulary:

```
## what
I own the deploy pipeline end to end.

## why
We were losing about a day a week to manual releases.

## scenario
At Solarworks I cut the release from 40 minutes to 6.
```

Vocabulary: `what`, `why`, `how`, `when`, `scenario`. Anything else is prose.

Bracket tags (`[what]`) were rejected: the prompt mandates `[company]` and `[X]%`
placeholders, so a beat opening on a placeholder would be eaten by the parser.
Structured JSON was rejected outright — it cannot stream, and streaming into the
glance surface is the product.

**New module: `src/shared/answer-beats.ts`.** Pure, same reasoning as above.

```ts
type BeatLabel = 'what' | 'why' | 'how' | 'when' | 'scenario'
interface Beat { label: BeatLabel | null; text: string }
function parseBeats(text: string): Beat[]
```

The subtle requirement is **streaming safety**. Text arrives token by token, so a
trailing `##` or `## wh` must never flash on screen as prose before resolving
into a marker. The parser withholds a trailing partial line that could still
become a marker until its newline arrives. This is the part that carries real
test weight.

`parseBeats()` supersedes `paragraphs()` on the answer card. `paragraphs()` stays
for the transcript path at `App.tsx:1060`.

**The 50/50 split.** The output contract sizes the direct-answer beats and the
scenario block to land roughly equal.

**When no story fits, the scenario half is omitted entirely.** No placeholder
skeleton, no adapted near-miss. This chains onto the existing honesty rule and
`story_id: null` rather than introducing a second mechanism, and it keeps the
grounding guarantee load-bearing: a mandatory scenario quota is precisely a
standing instruction to invent one when the bank is empty. The card simply gets
shorter, and the existing `Grounding` value drives the chip. No new state.

### 5. Latency

With endpointing fixed, the remaining budget work:

| Change | Note |
|---|---|
| Migration opting existing installs into `speculativeDrafting` | A default flip alone is insufficient: `settings.ts:48` merges a saved file *over* `DEFAULT_SETTINGS`, so an existing install keeps `false` forever. Needs a marker key so a user who later turns it off is not re-flipped on every launch. |
| `model` default to `claude-sonnet-5` | **New installs only.** An existing install keeps its model. Silently changing the model behind a user who chose Opus is a quality change made without consent. |
| Drop `settings.get()` from `transcribe()` | An IPC round trip on the ASR hot path for settings the pipeline already holds in `this.settings`. Free. |
| `maxTokens` 500 → 700 on the answer path | The scenario half needs the room. |
| `redemptionMs` | **Unchanged at 700.** See piece 1. |
| `minWords`, `stableMs` | **Unchanged.** See below. |

**Do not tune the scheduler thresholds yet.** `SpeculationMetrics.hitRate` exists
for this decision and its own comment says to tune against that number rather
than against intuition. It is computed and never surfaced. Ship it to a log line
first; tuning blind is how the hit rate lands at 40% and margin burns for
nothing. This is the one place where the cheapest change is to add an instrument
and change nothing else.

**Named risk.** The 50/50 scenario half makes every answer longer, and longer
answers take longer to generate. Speculation hides that on a commit but not on a
regenerate, so misses get strictly worse than they are today. `hitRate` is the
instrument that would show this happening, which is a second reason to ship it.

## Testing

- **`endpointing.test.ts`** — fake clock. Continuation inside the hold merges;
  a gap past the hold ends the question; `maxHeldSegments` bounds a monologue;
  the exact two-fragment case from the screenshots reassembles.
- **`speculation.test.ts`** — the ratio floor. The 5-token/14-token case must not
  commit; a final that adds two trailing words must still commit, so the
  regression the prefix rule was written to prevent stays prevented.
- **`answer-beats.test.ts`** — streaming increments character by character, with
  the invariant that no prefix of a marker ever renders as prose; the closed
  vocabulary; `[company]` and `[X]%` do not collide; an unmarked answer degrades
  to a single unlabelled beat.
- **`answer-shape.test.ts`** — extend the existing no-dash assertion to cover
  every new string. The header comment explains why this has been got wrong
  before.
- **Grounding interaction** — the scenario block is present if and only if a
  story resolved.
- **Pipeline** — behaviour is unchanged when `speculativeDrafting` is off.

## Open questions

1. **Why did the grounding chip fire on real history (defect 5)?** Is a
   `ProfileBundle` installed in the session that produced the screenshots? If
   not, the prompt never asks for a `story_id`, grounding can never resolve, and
   the chip is showing "not anchored" on every answer the app will ever give —
   which is alarm fatigue by construction and a more urgent problem than it
   looks. If a bundle is installed, the model omitted the citation line and the
   fix is in the output contract instead. Diagnose before fixing.
2. **`holdMs: 700` is a first estimate.** It should be validated against a real
   session once transcript logging carries segment gaps.

## Follow-up, not in scope

`endpointing.ts` and `answer-beats.ts` join `speculation.ts` as shared rules that
`hue-mobile` mirrors in Kotlin. Until they are ported, a mirrored session renders
differently on the phone. `speculation.ts` states the rule this inherits: when a
rule changes here, change it there.
