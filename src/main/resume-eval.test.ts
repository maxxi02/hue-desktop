// src/main/resume-eval.test.ts
/**
 * The grounding eval, re-homed from `hue-ingest/eval/run.ts`.
 *
 * Unlike every other `*.test.ts` in this directory, this calls the real model.
 * It is the regression net for the product's central claim, and a fake cannot
 * test whether a prompt still stops a model inventing an employer. Run it on
 * every prompt or model change:
 *
 *   HUE_EVAL=1 ANTHROPIC_API_KEY=... npm run eval:resume
 *
 * Gated behind `HUE_EVAL=1` exactly like `cuesheet-eval.test.ts`, so a plain
 * `npm test` stays offline, free, and needs no key.
 *
 * The bar is absolute: **zero hallucinated employers, titles, institutions, or
 * metrics.** `pruneUngrounded` would silently drop those in production, so the
 * eval checks the pre-prune drops as well as the shipped bundle — a run that
 * passes only because the pruner cleaned up after it is a failing prompt.
 * Warnings are advisory and do not fail the run; a thin story bank is likewise
 * reported rather than failed, matching the original eval.
 *
 * The fixtures went from `hue-ingest/eval/resumes/` to `__fixtures__/resumes/`
 * unchanged. They are plain text, but they are still put through
 * `extractResume` rather than read straight in, so the eval exercises the same
 * entry point the app does.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractResume } from './resume-extract.ts'
import { runIngest } from './resume-pipeline.ts'
import { anthropicClient } from './structured-llm.ts'
import { storyIds } from '../shared/profile.ts'

const ENABLED = process.env.HUE_EVAL === '1'
const FIXTURES = join(import.meta.dirname, '__fixtures__', 'resumes')

/** Below this the bank is advisory-thin — reported, never failed. */
const THIN_STORIES = 8

interface Row {
  name: string
  errors: number
  dropped: number
  warnings: number
  stories: number
  gaps: number
  tokens: number
}

test(
  'fixture resumes yield zero ungrounded claims',
  {
    skip: !ENABLED && 'set HUE_EVAL=1 to run (calls the real Anthropic API)',
    timeout: 900_000
  },
  async () => {
    // Reads ANTHROPIC_API_KEY from the environment, like the original eval.
    // A missing key must fail loudly rather than silently pass nothing.
    assert.ok(
      process.env.ANTHROPIC_API_KEY,
      'ANTHROPIC_API_KEY is not set. The grounding eval calls the real model.'
    )

    const llm = anthropicClient()
    const files = readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.txt'))
      .sort()
    assert.ok(files.length > 0, `no fixtures in ${FIXTURES}`)

    const rows: Row[] = []
    const failures: string[] = []

    for (const name of files) {
      const extracted = await extractResume(readFileSync(join(FIXTURES, name)))
      assert.equal(extracted.ok, true, `${name} failed extraction`)
      if (!extracted.ok) continue

      const { bundle, report } = await runIngest(extracted.text, llm)
      const errors = report.issues.filter((i) => i.severity === 'error')

      rows.push({
        name,
        errors: errors.length,
        dropped: report.dropped.length,
        warnings: report.issues.length - errors.length,
        stories: bundle.stories.length,
        gaps: bundle.gaps.length,
        tokens: report.estimatedTokens
      })

      for (const issue of [...errors, ...report.dropped]) {
        console.log(`  x ${name} ${issue.path}: ${issue.message}`)
      }
      // Every story the live prompt may cite must be citable by id.
      const ids = storyIds(bundle)
      if (ids.size !== bundle.stories.length) {
        failures.push(`${name}: duplicate story ids`)
        console.log(`  x ${name}: duplicate story ids`)
      }
      if (errors.length + report.dropped.length > 0) {
        failures.push(`${name}: ${errors.length} errors, ${report.dropped.length} dropped`)
      }
    }

    console.table(rows)

    const thin = rows.filter((r) => r.stories < THIN_STORIES)
    if (thin.length) {
      console.warn(`Thin story banks (advisory): ${thin.map((r) => r.name).join(', ')}`)
    }

    assert.deepEqual(failures, [], `ungrounded claims: ${failures.join('; ')}`)
  }
)
