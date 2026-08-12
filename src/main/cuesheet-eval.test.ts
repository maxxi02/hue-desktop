// src/main/cuesheet-eval.test.ts
/**
 * Network-gated trigger-quality eval.
 *
 * Trigger generation is prompt- and model-dependent: a prompt tweak or a
 * model upgrade can quietly degrade match quality while every offline test
 * in `cuesheet.test.ts` / `cuesheet-corpus.test.ts` stays green, because those
 * tests exercise `CueMatcher` against a fixed, hand-written corpus rather than
 * anything a real model produced. This is the regression net for that gap —
 * the same argument `hue-ingest`'s grounding eval makes about its own prompt.
 *
 * Skipped by default (`HUE_EVAL=1` opts in) so `npm test` stays fully
 * offline; see the `RUN` guard below.
 *
 * ## What this can and cannot cover
 *
 * The brief asks this to "run it through the real ingest path
 * (`ingestCueSheet`)". That is not achievable under plain `node --test`, for
 * reasons specific to this codebase rather than to this eval:
 *
 * - `ingestCueSheet` calls `saveSheet(sheetsDir(), sheet)`, and `sheetsDir()`
 *   does `require('electron')` and then `app.getPath(...)`. Outside a real
 *   Electron process, the `electron` package's `require` either throws
 *   ("Electron failed to install correctly") or — if it did resolve — hands
 *   back a path *string*, not the `{ app, safeStorage }` API, so `app.getPath`
 *   would throw anyway (verified empirically against this repo's
 *   `node_modules/electron`).
 * - `ingestCueSheet` also lazily imports `./anthropic.ts`, which statically
 *   imports `./settings.ts`, which statically imports `{ app, safeStorage }`
 *   from `'electron'` at module scope — an import that cannot succeed at all
 *   under plain Node, independent of Electron even being present, because
 *   `settings.ts` also imports `'../shared/types'` without the `.ts`
 *   extension that `node --test`'s type-stripping resolver requires (verified
 *   empirically: `node --test` fails that import with `Cannot find module`).
 *
 * Both are pre-existing properties of `cuesheet-store.ts` / `settings.ts`,
 * which this task is not permitted to touch. So per the brief's own escape
 * hatch ("implement the eval against the pieces that CAN run"), this eval:
 *
 * - DOES call the real model, with the real system prompt — extracted at
 *   test time straight from `cuesheet-ingest.ts`'s source (see
 *   `extractSystemPrompt` below) so a prompt edit in that file is picked up
 *   automatically and cannot silently drift out of sync with what this eval
 *   tests.
 * - DOES use the real, exported `segment` and `parseCards` from
 *   `cuesheet-ingest.ts`, and the real `verifyCard` / `CueMatcher` from
 *   `../shared/cuesheet.ts` — the entire pipeline except the network call
 *   itself and the final disk write.
 * - Does NOT cover `saveSheet`/`sheetsDir` (disk persistence) or anything
 *   sourced from `settings.ts` (the user's configured API key or model
 *   choice) — both require a real Electron main-process runtime, which does
 *   not exist in this repo's `node --test`-based test setup. The model call
 *   below authenticates via the `ANTHROPIC_API_KEY` env var directly (the
 *   `@anthropic-ai/sdk` client reads it automatically), not via
 *   `getSettings().anthropicApiKey`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { segment, parseCards } from './cuesheet-ingest.ts'
import { verifyCard, CueMatcher, type CueCard, type CueSheet } from '../shared/cuesheet.ts'

const RUN = process.env.HUE_EVAL === '1'

/**
 * Pulls the `SYSTEM` prompt template literal straight out of
 * `cuesheet-ingest.ts`'s source text, rather than duplicating it by hand.
 * `SYSTEM` is not exported (and this task cannot add an export to that
 * file), so reading the source is the only way to test the actual prompt
 * instead of a copy that could quietly drift from it.
 */
function extractSystemPrompt(): string {
  const source = readFileSync(new URL('./cuesheet-ingest.ts', import.meta.url), 'utf-8')
  const match = source.match(/const SYSTEM = `([\s\S]*?)`/)
  if (!match) {
    throw new Error(
      'Could not find the SYSTEM prompt in cuesheet-ingest.ts — has its shape changed?'
    )
  }
  return match[1]
}

/**
 * A small fixture "prepared notes" document: four realistic interview
 * questions, each with a 2-3 sentence prepared answer. Headings use the `#`
 * form so `segment()` takes its primary (markdown-heading) path.
 */
const FIXTURE_DOC = `# Tell me about a time you resolved a conflict with a coworker
On a previous project, a teammate and I disagreed about which caching strategy to ship before a deadline. I set up a 20-minute call, asked him to walk me through his concerns, and we ended up combining both approaches into a hybrid design that shipped on time. Afterward we agreed to flag disagreements earlier next time instead of letting them sit until the deadline forced the issue.

# Why do you want to work here
I've used your product daily for two years, and what stands out is how much the team ships in public and explains its reasoning along the way. I want to work somewhere that treats documentation and transparency as a feature rather than an afterthought, and this is the only company I've seen do that consistently at your size.

# Describe a project you're proud of
I led the rebuild of an internal reporting dashboard that had grown unmaintainable after three years of quick patches. I rewrote the data layer, cut the average page load from nine seconds to under one, and trained two other engineers to own it going forward. It's still in daily use by the finance team today.

# What is your greatest weakness
I used to say yes to almost every meeting invite because I didn't want to seem uncooperative, and some weeks that left me with no deep work time at all. I now block two mornings a week as meeting-free and ask organizers what decision the meeting actually needs before accepting. It has made my output more predictable without hurting how people see me.`

/**
 * Held-out phrasings: different ways an interviewer might ask each of the
 * four questions above, worded deliberately to share little vocabulary with
 * the fixture document. None of this text was given to the model.
 */
const HELD_OUT: { phrasing: string; sectionIndex: number }[] = [
  {
    phrasing: 'Give me an example of when you and a colleague butted heads over an approach.',
    sectionIndex: 0
  },
  {
    phrasing: 'How do you handle it when a teammate pushes back hard on your idea?',
    sectionIndex: 0
  },
  { phrasing: 'Walk me through a disagreement at work that got a little tense.', sectionIndex: 0 },
  { phrasing: 'What draws you to this particular company?', sectionIndex: 1 },
  { phrasing: 'Why us instead of one of our competitors?', sectionIndex: 1 },
  { phrasing: 'What made you decide to apply for this role specifically?', sectionIndex: 1 },
  {
    phrasing: "Walk me through something you built that you're really happy with.",
    sectionIndex: 2
  },
  { phrasing: "Tell me about a piece of work you'd put on a highlight reel.", sectionIndex: 2 },
  {
    phrasing: "What's an accomplishment from a past role you'd want us to know about?",
    sectionIndex: 2
  },
  { phrasing: 'Where do you still need to grow professionally?', sectionIndex: 3 },
  { phrasing: "What's an area you're actively working to improve?", sectionIndex: 3 },
  { phrasing: 'If your old manager had one critique of you, what would it be?', sectionIndex: 3 }
]

const HIT_RATE_BAR = 0.8

test(
  'generated triggers match unseen phrasings',
  { skip: !RUN && 'set HUE_EVAL=1 to run (calls the real Anthropic API)', timeout: 120_000 },
  async () => {
    const system = extractSystemPrompt()
    const sections = segment(FIXTURE_DOC)
    assert.equal(sections.length, 4, 'fixture must segment into exactly 4 sections')

    // Mirrors ingestCueSheet's own call shape (model, maxTokens, prompt
    // assembly), minus routing through completeOnce/getSettings, which
    // require a real Electron process. See the file header.
    const anthropic = new Anthropic()
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: sections.map((s) => `## ${s.heading}\n${s.body}`).join('\n\n') }
          ]
        }
      ]
    })
    const raw = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const cards: CueCard[] = parseCards(raw)
      .map((c) => verifyCard(c, FIXTURE_DOC))
      .filter((c) => c.script.length > 0 && c.cues.length > 0 && c.triggers.length > 0)

    // A run that produces zero verified cards must fail loudly rather than
    // silently pass a vacuous 0/0 hit-rate below.
    assert.ok(cards.length > 0, 'ingest produced zero cards that survived verification')
    for (const card of cards) {
      assert.ok(card.cues.length > 0, `card "${card.id}" has no surviving cues`)
      assert.ok(
        card.triggers.length >= 8,
        `card "${card.id}" has only ${card.triggers.length} triggers, fewer than the 8-15 the prompt asks for`
      )
    }

    const sheet: CueSheet = {
      id: 'eval-sheet',
      label: 'eval',
      sourceHash: '',
      createdAt: new Date().toISOString(),
      cards
    }
    const matcher = new CueMatcher(sheet)

    // Ground truth for which fixture question each generated card answers:
    // `verifyCard` guarantees `card.script` is a verbatim substring of the
    // source, so finding which section's body contains it is exact, not a
    // heuristic on the model-chosen heading text.
    const cardSectionIndex = new Map<string, number>()
    for (const card of cards) {
      const idx = sections.findIndex((s) => s.body.includes(card.script))
      if (idx >= 0) cardSectionIndex.set(card.id, idx)
    }

    let hits = 0
    for (const { phrasing, sectionIndex } of HELD_OUT) {
      const result = matcher.match(phrasing)
      const matchedSection = result.cardId ? cardSectionIndex.get(result.cardId) : undefined
      if (matcher.renders(result) && matchedSection === sectionIndex) hits++
    }

    const total = HELD_OUT.length
    const hitRate = total > 0 ? hits / total : 0
    assert.ok(
      total > 0 && hitRate >= HIT_RATE_BAR,
      `held-out match rate ${hits}/${total} (${(hitRate * 100).toFixed(0)}%) is below the ${
        HIT_RATE_BAR * 100
      }% bar`
    )
  }
)
