# Assessment mode: a second kind of answer — design

**Date:** 2026-08-22
**Scope:** `hue-desktop` only. One new pure module, one new answer shape, four new
beat labels, one new `Grounding` state, three settings, one hotkey, one card chip.
No change to the `ProfileBundle` schema and no change to the relay wire format.
The phone mirror renders assessment answers as raw text, as it already does for
labelled answers — see §1.
**Follows:** [2026-08-19 Labelled answers and endpointing](./2026-08-19-labeled-answers-and-endpointing-design.md),
whose `LABELLED_SHAPE` contract this sits beside rather than replaces.

## The problem

A technical interview asks two kinds of question and Hue can only answer one.

> "Tell me about a time you disagreed with your manager."

is served well today: `LABELLED_SHAPE` produces ~70 words of speakable prose in
two beats, grounded in a story from the résumé bank, with a citation receipt.

> "How would you design an SSR function?"

is served badly by the same machinery, and the reasons are structural rather
than a matter of prompt wording:

- **The word cap is wrong.** Seventy words is thirty seconds of speech. It is
  the right budget for a behavioural answer and far too small for an approach
  plus its tradeoffs.
- **The grounding rule is inapplicable.** `groundResponse` asks which résumé
  story an answer came from. A correct SSR answer comes from none of them, so
  the response is marked `ungrounded` and the card shows a warning. The warning
  is not wrong, it is _irrelevant_ — and an indicator that cries wolf on every
  technical question is one the user learns to ignore on the behavioural ones,
  where it is load-bearing.
- **The provider is chosen for latency.** `llmProvider` is documented as wanting
  the cheapest and fastest option, with Groq's free tier named. That is the
  right trade for prose the user reshapes as they speak. It is the wrong trade
  for code, where a plausible-looking wrong answer is worse than a slow one.
- **There is no place to put code.** Every rendering surface in the app assumes
  speakable prose. `answer-beats.ts` says so outright: "anything on this surface
  that is not speakable is a hazard."

Half the feature already exists and is unaware of the other half.
`captureScreen` (`pipeline.ts:822`) is documented as being for "a coding prompt
the interviewer is screen-sharing", forces `speak: false`, and raises its budget
to 1024 tokens. It is assessment mode with no shape, no classifier and no
provider of its own.

## The design

### 1. A second answer kind, not a second prompt

Assessment mode does not replace the companion answer. It adds a second kind of
answer, chosen per question, and everything downstream that already treats an
answer as text inherits it: the relay wire format (`{ type, text }`), the
session transcript and the review all carry text and need no change.

One honest caveat, verified rather than assumed. `useVoiceMode.ts:206` mirrors
the **raw** assistant text to the phone, markers included, and
`main/phone-page.html` contains no beat handling at all — so the phone already
renders `## what` literally today. Assessment mode does not introduce that bug,
but it makes it uglier: an unformatted code block on a phone screen is worse
than a stray marker. Out of scope here, and named so it is a known gap rather
than a surprise.

The toggle **arms** the mode. It does not force it. One session mixes both kinds
because one interview does.

### 2. Classification

`shared/assessment.ts`, pure, tested under `node --test` like `answer-shape.ts`
and `memory-policy.ts`:

```ts
export function looksLikeCodingQuestion(text: string): boolean
```

A local heuristic over the transcript. Deliberately not a model call, for two
reasons that compound: it must run on the **interim** transcript so the routing
decision is made while the interviewer is still speaking, and the provider is
chosen from its result — so a classifier call would add its own latency to the
front of the slowest answer type in the app.

It matches on question intent rather than on vocabulary: "how would you
implement/design/build", "write a function", "what's the time complexity",
"walk me through the algorithm", plus language and primitive names. Vocabulary
alone would fire on "tell me about a hard **technical** decision", which is a
behavioural question wearing technical words.

**The heuristic will be wrong.** That is designed for rather than argued away:
the answer card carries a one-click "answer as code" / "answer normally" that
re-runs the question through the other path. The escape hatch is the feature;
classifier accuracy is a tuning exercise on top of it.

### 3. Routing

```
spoken question (interim → final) ─┐
screen capture ────────────────────┴→ classify ─→ assessment | normal
                                          ↑
                                  assessmentEnabled
                                          ↓
              provider  = assessmentProvider || llmProvider
              shape     = ASSESSMENT_SHAPE
              speak     = false
              speculate = false
              maxTokens = 1500
```

`assessmentProvider` mirrors `ingestProvider` exactly, including the `''` means
"same as drafting" convention, and reuses the existing per-provider model
fields. The precedent is deliberate: the codebase already accepts that one job
wants speed and another wants capability, and this is a third job with a third
requirement.

### 4. The answer shape

Explanation leads, code supports. The user is talking the interviewer through a
design, not reading syntax aloud, so the steps are the deliverable and the code
is a prop they glance at.

`ASSESSMENT_SHAPE` joins `answerShapeFor`, and uses the same marker mechanism
`LABELLED_SHAPE` established:

| Marker          | Holds                                            | Budget     |
| --------------- | ------------------------------------------------ | ---------- |
| `## approach`   | the one-sentence shape of the answer, said first | ~25 words  |
| `## steps`      | the ordered beats, each one speakable on its own | ~120 words |
| `## code`       | a compact block, verbatim, never read aloud      | —          |
| `## complexity` | time and space, when the question implies them   | ~20 words  |

`## code` and `## complexity` are optional for the same reason `## scenario` is:
a mandatory section is a standing instruction to invent one when there is
nothing to put in it.

**`## steps` is the one place a number is allowed.** `LABELLED_SHAPE` ends with
"never write a heading, a label, a number, or a bullet of your own", and that
rule is correct for prose the user reads aloud continuously. Steps are the
exception and `ASSESSMENT_SHAPE` must say so explicitly rather than leaving the
two instructions to fight: the numbering is what lets someone glance down,
find where they were, and carry on talking. Every other part of the assessment
answer keeps the no-ornament rule.

### 5. The `## code` hazard

`answer-beats.ts` splits on a line that is exactly a known marker. A code block
can legally contain such a line:

```python
## normalise the route key before hashing
def key(req): ...
```

Under today's parser that comment starts a new beat and the answer shatters
mid-render, while the user is reading it out loud. Two changes:

- The `## code` beat runs to the **next known label at column zero**, and lines
  inside it are never re-examined for markers.
- The streaming-safety rule already in that module — withhold a trailing line
  that could still become a marker — must not apply inside a code beat, or the
  last line of code is withheld until the answer completes.

Both get tests. This is the single most likely thing to break, because it only
fails on inputs a fixture writer would not naturally think to write.

### 6. Grounding gains a third state

```ts
export type Grounding =
  | { kind: 'grounded'; story: ProfileStory }
  | { kind: 'ungrounded'; claimedId: string | null }
  | { kind: 'general-knowledge' } // new
```

An assessment answer is not grounded and is not *un*grounded — those two states
both presuppose the question was one the résumé could answer. The third state
says the question was outside the bank by design.

Making it a union member rather than a boolean flag is the point: TypeScript
forces all six existing consumers to say what they do with it, and none of them
can silently treat it as a failure. The consumers are
`App.tsx:239`, `pipeline.ts:1021`, `sessionHistory.ts:124`/`:133`, and
`session-review.ts:134`/`:158`.

Rendering: a neutral marker reading "general knowledge, not from your résumé" —
a statement of provenance, not a warning. `session-review.ts` excludes these
from the grounding score entirely rather than counting them as misses, so a
session full of coding questions does not report as a session full of
hallucinations.

### 7. Screen capture

While armed, `captureScreen` routes to the assessment provider and uses
`ASSESSMENT_SHAPE`. This is where most real coding questions arrive.

The one constraint: the assessment provider may be text-only.
`providerSupportsVision` already exists in `main/openai-compat.ts`. When it
returns false the capture falls back to the drafting provider **and says so on
the card** — a silent fallback would leave the user believing they were getting
the accurate model.

### 8. Never spoken, never speculated

Both forced, both for stated reasons:

- **`speak: false`.** The capture path already does this. A code answer read
  aloud by TTS is noise at best and audible to the interviewer at worst.
- **No speculative drafting.** Speculation fires on the interim transcript and
  discards drafts that turn out wrong. Assessment answers are the longest, and
  they route to the most expensive model. Paying for discarded code drafts is
  the worst instance of that trade in the app.

### 9. The toggle

State must be visible. A mode that changes what every answer looks like, and
which model is billed, cannot be invisible.

- A labelled chip on the main card showing armed/disarmed, toggling on click.
- `assessmentHotkey`, a fourth global hotkey using the existing encoding, so it
  works while another app is focused — which is the situation it exists for.
- Settings holds `assessmentProvider` and the model choice, in the **Interview**
  category beside Mode and Answering.

New settings fields:

| Field                                   | Modelled on           | Default |
| --------------------------------------- | --------------------- | ------- |
| `assessmentEnabled: boolean`            | `speculativeDrafting` | `false` |
| `assessmentProvider: LlmProvider \| ''` | `ingestProvider`      | `''`    |
| `assessmentHotkey: string`              | `captureScreenHotkey` | unbound |

Defaulting `assessmentEnabled` to false is deliberate: this mode changes which
provider is billed, and a mode that costs money must be entered on purpose.

## Testing

- **`shared/assessment.test.ts`** — the heuristic, both directions. The
  must-_not_-fire corpus is the important half and includes "tell me about a
  hard technical decision", "what's the hardest bug you've shipped", "how do you
  approach code review" — behavioural questions dense with technical words.
- **`answer-beats.test.ts`** — the four new labels; a `## code` body containing
  a `##` comment line; streaming a code beat token by token and asserting no
  intermediate render drops or mangles a line.
- **`answer-shape.test.ts`** — `ASSESSMENT_SHAPE` obeys the existing no-em-dash
  rule that file already enforces.
- **`session-review.test.ts`** — a session of assessment answers scores as
  neither grounded nor ungrounded.
- **Routing** — armed + coding question picks the assessment provider; armed +
  behavioural keeps the drafting provider and `LABELLED_SHAPE`; disarmed always
  keeps today's behaviour; text-only assessment provider falls back on capture.

## What this deliberately does not do

- **No syntax highlighting.** It is a dependency, this app ships offline, and
  the house style is hand-drawn SVG rather than packages. Monospace with the
  step numbers carrying the structure is enough to glance at.
- **No code execution or verification.** Hue cannot claim the code runs, and
  building a sandbox to find out is a different project.
- **No language picker.** The model infers the language from the question, and a
  control that is right by default is a control nobody should have to touch.
- **No editing or diffing the produced code.** The user types it themselves.

## Risks

1. **The heuristic is the weakest part.** Mitigated by the override, not by
   confidence in the patterns. If misfires are common in real use, the upgrade
   path is a classifier call on the fast provider, which slots into the same
   function signature.
2. **Latency is unbudgeted.** A 1500-token answer from a capable model may take
   several seconds where today's answers take under one. The card must show that
   the slower path was taken deliberately rather than appearing to hang. No
   measurement exists yet; this needs one before tuning.
3. **Cost.** Every armed coding question bills a capable model. The usage panel
   already tracks per-provider spend, so this is visible, but nothing caps it.
