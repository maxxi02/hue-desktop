# The interviewer keeps talking after the answer starts — design

**Date:** 2026-08-21
**Scope:** `hue-desktop` only. One existing shared module gains state, one
renderer file gains a flag. `hue-mobile` mirrors `src/shared/` in Kotlin; porting
is named as follow-up here and is not part of this change.
**Follows:** [2026-08-19 Labelled answers and endpointing](./2026-08-19-labeled-answers-and-endpointing-design.md),
whose `EndpointBuffer` this spec extends past the moment it currently gives up.

## The problem

Reported from a live session:

> **Interviewer:** Can you please...
>
> **Hue:** *(starts answering the fragment)*
>
> **Interviewer:** ...introduce yourself.
>
> **Hue:** *(discards the first answer, starts a second one)*

The preceding spec fixed the version of this where the gap is short. `holdMs:
700` catches a breath mid-sentence and joins the halves. This is the same defect
with a longer pause — long enough that the hold expired, the question shipped,
and generation started before the interviewer resumed.

Everything after that point is working as designed, and the design is wrong for
this case:

1. `onHoldExpired` fires, the buffer `reset()`s, `resolveQuestion()` pushes
   `"can you please"` as a user turn and starts a stream.
2. The interviewer resumes. `onSpeechStart` (`pipeline.ts:457`) sees state
   `thinking` and treats it as **barge-in**: `abortResponse()` kills the stream,
   aborts the draft, resets the scheduler.
3. `"introduce yourself"` is transcribed, held, shipped, and pushed as a
   *second* user turn.

So the model is asked to answer `"introduce yourself"` with `"can you please"`
sitting above it as a separate, already-answered turn. The user watches one
answer get thrown away and a worse one replace it.

### Why the existing hold cannot simply be widened

The obvious fix — raise `holdMs` — is wrong, and it is worth saying why, because
it is the first thing anyone will try.

`holdMs` is dead time before *anything* is shown. Widening it to cover a
two-second pause taxes every question in the session, including the overwhelming
majority that were never split, and the preceding spec's argument for why the
hold is free stops holding: the draft in flight covers 700ms of it, not 2000ms.
The hold is cheap precisely because it is short.

The pause we need to survive here is one that happens *after* an answer is
already on screen. That is a different resource. Waiting is expensive; replacing
is not, because the user has something to read the whole time.

## The design

### 1. `EndpointBuffer` gets a settled state

Today the buffer's life ends when it ships. `onHoldExpired` returns the assembled
text and calls `reset()`, and the pipeline never asks it about that question
again. Instead it keeps three more fields:

```
settledText     the question it last shipped
settledAt       when it shipped
supersedeCount  how many times this question has already been replaced
```

A final arriving while the supersede window is open does **not** ship
immediately. It prepends `settledText` back into `segments` and re-enters the
ordinary hold.

That reuse is the point. A continuation can itself be split across two segments —
the interviewer resumes, pauses again, finishes — and re-entering the existing
700ms hold handles that for free. There is no second merging path to keep in
sync with the first.

The only new API is on the way out. Both ship points now carry whether this
shipment replaces the previous turn or begins a new one:

```ts
onHoldExpired(now): { text: string; supersedes: boolean } | null
{ kind: 'complete'; text: string; supersedes: boolean }
```

`EndpointConfig` gains `supersedeMs` and `maxSupersedes: 2`.

**When the counter resets, and what the cap does.** `supersedeCount` belongs to
the question, not to the session: it increments on each replacement and resets to
zero whenever a shipment goes out with `supersedes: false` — that is, whenever a
genuinely new question begins. Once the cap is reached the settled state is
cleared, so the next final takes the ordinary path and starts a new turn rather
than replacing. The cap bounds wasted generations at two per question; it never
drops a question on the floor.

The module stays pure — no timers, no I/O, `now` passed in — for the reason
`speculation.ts` gives and `endpointing.ts` inherited. The entire behaviour
matrix has to run against a fake clock under plain `node --test`, and this change
roughly doubles the number of states worth asserting.

### 2. The window is sized by who can be heard

`speakerOfIncomingSpeech()` (`pipeline.ts:583`) labels **all** incoming audio
`'interviewer'` in companion mode. There is no speaker discrimination. Whether
that label is true depends entirely on the audio source (`pipeline.ts:356`):

- **`system` (loopback)** — the call's audio only. The user's own voice
  physically cannot reach the VAD. The label is true by construction.
- **microphone** — a room mic hears the interviewer *and the user reading the
  answer aloud*. The label is an assumption.

This inverts the timing argument the preceding spec rests on. "After the
interviewer finishes, the candidate talks" is what makes resumed speech safe to
merge on loopback — and is exactly what makes it *unsafe* on a room mic, where
the candidate talking is indistinguishable from the interviewer continuing.
Merging it would concatenate the user's own answer onto the question.

So the window scales with the source:

```
supersedeMs: 4000   // system loopback: interviewer-only audio, guaranteed
supersedeMs: 1500   // microphone: the user's voice is in the same channel
```

1500ms is defensible on a room mic on timing alone: within a second and a half of
the interviewer stopping, the user cannot yet be reading an answer aloud, because
the answer has barely started streaming. Past that it stops being defensible, so
the window closes.

The buffer never learns what an audio source is. The pipeline picks the value and
passes it in:

```ts
new EndpointBuffer({
  supersedeMs: settings.audioSource === 'system' ? 4000 : 1500
})
```

### 3. Timing, not grammar — with one positive exception

The gate is pure timing, for the reason `endpointing.ts` already documents in its
own header: Whisper stamps a confident full stop onto fragments, so punctuation
cannot carry this decision. No classifier is consulted.

One grammatical signal is admitted, and only in the direction that cannot cause a
false merge. A segment opening with a continuation marker —

```
and · also · or · plus · specifically · in particular · for example
```

— is strong evidence of continuation that does not depend on punctuation, so it
widens the window to the loopback value even on a room mic. It can extend a
window; it can never reject a merge that timing accepted. A false positive here
costs one wasted regeneration. A false negative costs nothing at all, because
timing already decided.

### 4. There is no summarisation step

The feature was requested as "summarise the detected cut-off questions, then
respond to the whole." The merge is plain concatenation instead, and the
difference matters.

A summariser is a lossy middleman standing between the interviewer's words and
the model that answers them. `"can you please introduce yourself"` needs no
compression — it needs to arrive intact. Responding "to the whole" is what the
answering model does natively with the whole as input; inserting a step whose job
is to *discard detail* before the answer sees it can only subtract, while adding
a call, latency, and resident memory on a machine that has none to spare.

Concatenate, replace the turn, regenerate.

### 5. `resolveQuestion` learns to replace a turn

`resolveQuestion(text)` becomes `resolveQuestion(text, supersedes)`. When
`supersedes` is true it **pops** the previous user turn and its assistant reply
from `this.messages` before pushing the merged question.

Without the pop, the model sees the fragment and the merged question as two
separate turns and answers as though it had been asked twice — which is the
defect, relocated from the screen into the context window.

The on-screen half is nearly free, because `useVoiceMode` holds only the latest
question and the latest answer rather than a thread. Re-emitting
`onUserTranscript` with the merged text sets the new question and clears
`assistantText` / `assistantResult` in one move (`useVoiceMode.ts:185`), and
mirrors the corrected question to the phone.

Two call sites need adjusting for the new shape: the hold-expiry timer
(`pipeline.ts:536`) and `onVADMisfire` (`pipeline.ts:297`).

**The answer may have already finished.** If the interviewer resumes after the
stream completed, state is `listening`, so the barge-in branch in `onSpeechStart`
never runs and nothing is aborted. The supersede path still applies unchanged:
the pop and the re-emit replace a completed answer exactly as they replace a
streaming one. This is the case most likely to be missed in implementation, and
it gets its own test.

**Nothing is spoken, so nothing is cut off mid-word.** `speakResponses` is
interviewer-mode-only (`pipeline.ts:204`) and supersede is companion-only, so the
entire feature is visual. This is what makes "replace" an acceptable answer to
"what happens to the text already on screen"; in a mode that spoke its answers it
would not be.

### 6. A display bug this fixes on the way past

`pipeline.ts:488` emits `onUserTranscript` with the **raw segment**, before the
endpoint decision is made. The assembled text is never sent to the UI at all.

So today, when the ordinary 700ms hold joins two segments, the model receives the
whole question and the screen shows *only the last fragment*. The user reads
"when you are testing a new endpoint for the first time" above an answer that
plainly addresses more than that. Latent since the preceding spec shipped, and
independent of supersede.

The fix rides on the mechanism section 5 already needs: keep the immediate
per-segment emit, so the user still sees words appear while speaking, then
re-emit the assembled text at resolve when it differs from what was last emitted.
One path serves the join case and the supersede case.

### 7. Speculation needs no changes

Worth recording, because the interaction looks dangerous and is not.

A draft can fire on the continuation segment alone — on `"introduce yourself"` —
and then be tested against the merged final. If it committed, Hue would render an
answer to half a question, which is the product's stated worst failure.

It cannot. `commits()` (`speculation.ts:427`) takes the prefix path only when the
final *starts with* the fire text. Here the fire text is a **suffix** of the
merged final, so the prefix branch is skipped entirely — the `MAX_PREFIX_GROWTH`
floor added by the preceding spec is never even reached — and it falls through to
`tokenF1`. Two fire tokens against five final tokens scores precision 1.0, recall
0.4, F1 ≈ 0.57, against a `commitThreshold` of 0.85. It refuses and regenerates.

No new guard. The existing one covers this.

## Testing

- **`endpointing.test.ts`** — fake clock, extending the existing matrix.
  A final inside the supersede window replaces; one past it starts a new
  question; `maxSupersedes` bounds a repeatedly-interrupted question;
  a continuation that is itself split re-enters the hold and merges both;
  a continuation marker widens a mic-width window; a misfire while settled
  leaves the settled question intact rather than stranding it.
  The reported case — `"can you please"` then `"introduce yourself"` —
  reassembles as one question.
- **Message history** — a supersede replaces the previous user turn and its
  assistant reply rather than appending, asserted on `this.messages`.
- **The completed-answer case** — supersede after the stream finished, where no
  barge-in abort fires. Named separately because it exercises a different branch.
- **The display fix** — an ordinary two-segment join emits the assembled text,
  not the last fragment. This one is a regression test for a bug that shipped
  unnoticed, so it should read as such.
- **Unchanged behaviour** — interviewer mode constructs no `EndpointBuffer` and
  is unaffected; companion mode with `supersedeMs: 0` behaves exactly as today.

## Open questions

1. **`supersedeMs: 4000` and `1500` are first estimates**, in the same sense the
   preceding spec's `holdMs: 700` was and still is. Both want validation against
   a real session once transcript logging carries segment gaps. This spec makes
   that instrumentation more valuable, not less: there are now three timing
   constants resting on the same unmeasured distribution.
2. **Should a supersede be visible?** The design replaces silently. An argument
   exists for a brief marker — the user glancing down mid-read deserves to know
   the text changed under them rather than doubting what they just read. Left out
   under YAGNI, but it is the first thing to add if the replacement is reported
   as disorienting.

## Follow-up, not in scope

`endpointing.ts` is one of the shared rules `hue-mobile` mirrors in Kotlin.
Until the settled state is ported, a mirrored session answers a split question
differently on the phone. `speculation.ts` states the rule this inherits: when a
rule changes here, change it there.
