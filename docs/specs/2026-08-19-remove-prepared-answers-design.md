# Remove prepared answers; give the generated answer four beats — design

**Date:** 2026-08-19
**Scope:** `hue-desktop` only. No mobile or relay change; neither reads cue sheets.
**Supersedes:** [2026-08-11 Cue Sheet design](./2026-08-11-cue-sheet-design.md)

## The problem

Two changes, and they point the same way.

The Cue Sheet let a user upload prepared notes; Hue matched the interviewer's
question against them and put the user's own rehearsed wording on screen above
its generated answer. It is being removed in full — every file, setting, IPC
channel, and prompt block. Hue always generates.

That makes the generated answer the only thing on the glance surface, which
raises the standard it has to meet. Today the prompt demands "a single, natural
paragraph" with "no headings, no labels, no bullet points" (`pipeline.ts:1284`).
A wall of text is exactly the wrong shape for the surface: the user is reading it
aloud, live, glancing down between sentences. They need to find their place
again in a fifth of a second, and an unbroken paragraph gives the eye nothing to
land on.

So the answer gets four beats, each its own block:

1. **Open** — the habit or the claim, stated flat. A complete answer on its own.
2. **Prove** — one real specific that backs it up.
3. **Reflect** — what it taught, connecting the dots.
4. **Close** — the impact it had.

The user's own worked example of the shape:

> I use Postman constantly when I'm building or debugging an API, checking status
> codes, response shapes, and how the endpoint fails when something's malformed.
>
> At Solarworks I hardened our public endpoints with Zod validation,
> constant-time API key checks, and rate limiting.
>
> That gave me visibility into both sides: what breaks from the client's
> perspective, and what's actually going wrong on the server.
>
> A good chunk of my time went into making sure the lead capture pipeline stayed
> resilient when downstream services failed, which meant testing it the same way
> support would troubleshoot an issue.

Beat 1 leads with a concrete habit rather than a definition. Beat 2 is the proof,
and its technical nouns are what signal depth. Beat 3 is the reflection that
shows self-awareness. Beat 4 lands on business impact rather than "I wrote code".

## Part A — Removing the cue sheet

### Deleted outright

| File | |
|---|---|
| `src/shared/cuesheet.ts` | matching, latching, gating, prompt blocks |
| `src/shared/cuesheet.test.ts` | |
| `src/shared/cuesheet-corpus.ts` | the 111-case evaluation corpus |
| `src/shared/cuesheet-corpus.test.ts` | |
| `src/main/cuesheet-ingest.ts` | notes → cards, via `structured-llm` |
| `src/main/cuesheet-ingest.test.ts` | |
| `src/main/cuesheet-eval.test.ts` | |
| `src/main/cuesheet-store.ts` | sheets on disk |
| `src/main/cuesheet-store.test.ts` | |
| `src/renderer/src/components/CueSheetPanel.tsx` | |
| `src/renderer/src/assets/cuesheet-doc.css` | |

### `scriptIsExtractive` must survive the deletion

This is the only genuine coupling, and the only part of the removal that can go
wrong silently.

`src/shared/job-spec.ts:37` imports `scriptIsExtractive` from `cuesheet.ts` under
the local alias `isVerbatimSpan`, and uses it at line 164 to verify that a parsed
job requirement's `evidence` is a span the posting actually contains rather than
something the model composed. It has nothing to do with cue sheets; it lives in
`cuesheet.ts` only because that is where it was first needed.

Move it, with its two-line `normalise` helper, into `job-spec.ts` under the name
`isVerbatimSpan` it already goes by there. Move the three assertions at
`cuesheet.test.ts:419-427` into `job-spec`'s test file.

Delete `cuesheet.ts` without doing this and TypeScript catches it; delete it and
stub the check instead, and job-spec loses its grounding guarantee with nothing
failing. The test move is what makes the relocation visible in the suite.

### `gateCommands` collapses to identity

`gateCommands` (`cuesheet.ts:618`) filters the speculation scheduler's commands
against the latch state. Every branch that drops a command is guarded by a cue
sheet condition:

- `fire` is dropped only when `decision.suppress`, which `decide()` returns only
  from `this.matcher.suppresses(...)`.
- `regenerate` is dropped only when `state.cardId !== null`.
- `commit` is dropped only when `decision.latch !== null`.
- `reset` and `abort` always pass.

With no matcher, `suppress` is always `false`, `cardId` and `latch` always
`null`. Every command passes. So the function is not merely unused after the
removal — it is provably the identity function, and the pipeline can consume
`commands` directly.

This also disposes of `resetScheduler`. Its three call sites all exist to repair
the scheduler after *this function* dropped a command it was tracking; with no
drops there is no phantom draft to repair. `regenerateForLatch` and
`latchCleared` disappear for the same reason. This is a deletion, not a
behaviour change to preserve.

### Edits

- **`src/shared/types.ts`** — drop `selectedCueSheetId` from `HueSettings` (247)
  and `DEFAULT_SETTINGS` (293).
- **`src/main/settings-migrations.ts`** — add `'selectedCueSheetId'` to
  `RETIRED_SETTING_KEYS`. The machinery already exists for exactly this case:
  `readFromDisk` merges as `{ ...DEFAULT_SETTINGS, ...raw }`, so a key no longer
  in the defaults still survives from disk and is re-persisted on every write.
  One array entry; without it the dead key lives in every existing user's
  settings file forever.
- **`src/main/ipc.ts`** — remove the `hue:cuesheet:ingest`, `:list`, `:select`,
  `:delete` handlers and the `:progress` send (252-271), plus the two imports.
- **`src/preload/index.ts`** — remove the `cueSheet` API object (105-118) and the
  `CueSheet` type import.
- **`src/renderer/src/lib/pipeline.ts`** — remove the `onCueCard` and `onCueSheet`
  callbacks, `armedSheet`, `latch`, `matcher`, `armCueSheet()`, `decide()`,
  `latchedCard()`, the `gateCommands` calls in both the interim and final paths,
  the `regenerateForLatch` round-trip, and the `cueBlock` injection in
  `buildCompanionPrompt`. `buildSystemPrompt` and `buildCompanionPrompt` lose
  their `cueSheet` and `latchedCard` parameters.
- **`src/renderer/src/hooks/useVoiceMode.ts`** — remove `cueCard` and `cueSheet`
  state, the two callback wirings (240-241), the `armCueSheet` call on settings
  change (124), and both fields from the returned object.
- **`src/renderer/src/App.tsx`** — remove the `CueCardBody` component (281) and
  its **three** call sites: the transcript bubble (924), the glance block (1162),
  and the `CueSheetPanel` route (1325), plus the panel import (20). The glance
  collapses to a single answer block, losing the "Hue's take" label branch; the
  waiting placeholder loses its `!voice.cueCard` guard. The transcript site at
  924 is easy to miss — the card renders in bubble mode as well as glance mode.
- **`src/renderer/src/components/Settings.tsx`** — remove the "Prepared answers"
  section (2069-2115), the onboarding checklist item (931-933), and the
  remaining references. 41 references, the largest single edit.
- **`src/renderer/src/assets/main.css`** — remove the prepared-card rules (from
  285) and the `@import './cuesheet-doc.css'` at line 2.
- **Stale comments** — `job-spec.ts:26`, `memory-policy.ts:6`,
  `usage-store.ts:16,35`, `structured-llm.ts:395`, `ingest.ts:20` and
  `cuesheet-corpus.test.ts:64` all reference `cuesheet.ts` as a design precedent.
  Reword to name a module that still exists (`speculation.ts` serves in most
  cases) rather than leaving pointers into deleted files.

### Deliberately not deleted

**Sheets on disk.** `sheetsDir()` holds documents the user uploaded. Removing a
feature is not licence to destroy user data, and an uninstall that silently
deletes files is the kind of thing people never forgive. The directory is simply
no longer read. If reclaiming it matters later, that is a separate decision with
its own consent.

**The 2026-08-11 cue sheet docs.** They are a dated record of a design that was
built, measured against a 111-case corpus, and removed. That history has value;
a gap in `docs/` does not. Each gets a one-line note at the top pointing here.

## Part B — Four beats

### Prompt

In `buildCompanionPrompt`, replace the paragraph instruction at `pipeline.ts:1284`
with the four beats: open with the habit or claim as a complete standalone
answer, prove it with one real specific, say what it taught, close on the impact.
Each beat is its own short block, separated by a blank line.

Everything else about the answer holds unchanged: first person, speakable, no
headings, no labels, no bullets, one concrete example woven in rather than
announced.

Two existing rules constrain how this is written:

- **"Lead with the answer"** (1280) survives untouched. Beat 1 already *is* a
  standalone response to the question, so the two instructions agree.
- **No em dashes or en dashes.** `HUMAN_VOICE_GUIDANCE` forbids them, and the
  comment at 1290 records why every quoted exemplar in the prompt must obey the
  rule it teaches: an example containing a dash teaches the model to use one no
  matter what the abstract rule says, which is how dashes got into the answers
  once before. The beats are separated by paragraph breaks and nothing else, and
  any example added to the prompt is written dash-free. The worked example above
  has already been rewritten this way.

### Mode scope

Default mode only.

`star` and `live` are deliberate choices the user made, and each already carries
a shape instruction that contradicts this one: `star` demands
Situation/Task/Action/Result, `live` demands "brevity over completeness". Both
branches keep their current text. Emitting no blank lines, they render exactly as
they do today.

### Render

Blank lines are invisible today. `.glance-text` has no `white-space: pre-wrap`
(`main.css:469`), so HTML collapses the model's structure and the change would
have no visible effect at all.

Add a `paragraphs(text: string): string[]` helper — split on `/\n\s*\n/`, trim,
drop empties — and map it to `<p>` elements in both the glance block
(`App.tsx:1174`) and the transcript bubble. Space them with a `.glance-text p`
rule sized to the glance leading.

Two constraints from the existing code:

- **No per-token keys.** The comment at `main.css:481` records that anything
  keyed off content re-fires on every token and strobes for the whole of a long
  answer. Index keys on a stable list are fine; content-derived keys are not.
- **No buffering.** A partial fourth beat mid-stream renders as a shorter last
  paragraph and grows in place. The split is recomputed each render, which is a
  regex over a few hundred characters.

## Testing

- **`job-spec`** — the three relocated containment assertions, proving
  `isVerbatimSpan` survived the move intact.
- **`settings-migrations`** — a settings file carrying `selectedCueSheetId` loads
  without it.
- **`paragraphs()`** — one block; four blocks; leading and trailing blank lines;
  a single `\n` stays *inside* one paragraph rather than splitting it; empty
  string yields an empty list.
- **Prompt** — the default mode system prompt contains the four-beat instruction;
  `star` and `live` do not, and still contain their own shape instructions.
- **Whole suite plus typecheck.** Deleting eleven files turns every import missed
  in the edits above into a compile error rather than a runtime one, so the
  typecheck is the real completeness check on Part A.

## Risks

- **`Settings.tsx`** is the largest edit at 41 references, and the onboarding
  checklist is index-sensitive — removing item 931 shifts what follows it.
- **The pipeline's final path** (`pipeline.ts:722-790`) interleaves latch
  handling with the speculation commit and regenerate logic. The latch removal
  must not disturb the endpoint-then-generate recovery living alongside it,
  which is what stands between the user and a blank screen when speculation
  produced nothing.
