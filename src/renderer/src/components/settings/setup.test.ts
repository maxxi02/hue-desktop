import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSetupSteps, ingestProviderOf, providerReady } from './setup.ts'
import { DEFAULT_SETTINGS, type HueSettings } from '../../../../shared/types.ts'

/**
 * The checklist is the answer to "why is Hue not answering yet", and it is the
 * only answer a new user gets. A step that ticks early is worse than no
 * checklist at all: it sends someone into a live interview believing they are
 * set up.
 *
 * Untestable until this logic left `Settings.tsx`. The tick-early case below is
 * a regression the file's own comment records as having reached a screen.
 */

function settings(overrides: Partial<HueSettings> = {}): HueSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

const steps = (s: HueSettings, hasResume = false, openGaps = 0): ReturnType<typeof buildSetupSteps> =>
  buildSetupSteps(s, hasResume, openGaps)

test('Ollama is ready without a key, because a local server has none to give', () => {
  // Demanding a placeholder would make the offline path the only one that looks
  // unconfigured.
  assert.equal(providerReady(settings(), 'ollama'), true)
})

test('every cloud provider needs its own key, and whitespace is not a key', () => {
  assert.equal(providerReady(settings(), 'anthropic'), false)
  assert.equal(providerReady(settings({ anthropicApiKey: 'sk-ant-x' }), 'anthropic'), true)
  assert.equal(providerReady(settings({ anthropicApiKey: '   ' }), 'anthropic'), false)
  assert.equal(providerReady(settings({ openaiApiKey: 'sk-proj-x' }), 'openai'), true)
  assert.equal(providerReady(settings({ groqApiKey: 'gsk_x' }), 'groq'), true)
  assert.equal(providerReady(settings({ groqApiKey: 'gsk_x' }), 'deepseek'), false)
})

test('an empty ingest provider means "same as drafting", matching the main process', () => {
  assert.equal(ingestProviderOf(settings({ llmProvider: 'openai', ingestProvider: '' })), 'openai')
  assert.equal(
    ingestProviderOf(settings({ llmProvider: 'openai', ingestProvider: 'google' })),
    'google'
  )
})

test('nothing is ticked on a fresh install', () => {
  assert.deepEqual(
    steps(settings()).map((step) => step.done),
    [false, false, false, false]
  )
})

test('Groq can draft but can never finish ingest, so that step stays open on it', () => {
  // Not a missing key: reading a résumé is one ~11k-token request and Groq's
  // free tier caps at 8k, so the step is unsatisfiable rather than incomplete.
  // Telling the user to add a key would send them round a loop that cannot end.
  const s = settings({ llmProvider: 'groq', groqApiKey: 'gsk_x', ingestProvider: '' })
  const [drafting, ingest] = steps(s)
  assert.equal(drafting.done, true, 'Groq is a perfectly good drafting provider')
  assert.equal(ingest.done, false)
  assert.match(ingest.detail, /8,000/, 'the step does not say why Groq cannot do it')
})

test('pointing ingest somewhere with headroom clears the step while drafting stays on Groq', () => {
  const s = settings({
    llmProvider: 'groq',
    groqApiKey: 'gsk_x',
    ingestProvider: 'openai',
    openaiApiKey: 'sk-proj-x'
  })
  const [drafting, ingest] = steps(s)
  assert.equal(drafting.done, true)
  assert.equal(ingest.done, true)
})

test('the gap step never ticks before there is a résumé to generate gaps from', () => {
  // This is the regression the checklist comment records: it used to count as
  // done while there was no résumé, on the reasoning that it was blocked by the
  // step above. On screen that read as a tick sitting above an unticked step,
  // claiming credit for something the user had never done.
  const s = settings({ llmProvider: 'ollama', ingestProvider: 'ollama' })
  const withoutResume = steps(s, false, 0)
  assert.equal(withoutResume[2].done, false, 'the résumé step ticked without a résumé')
  assert.equal(withoutResume[3].done, false, 'the gap step ticked with no gaps to answer')
})

test('the gap step ticks only when a résumé exists and no gap is left open', () => {
  const s = settings({ llmProvider: 'ollama', ingestProvider: 'ollama' })
  assert.equal(steps(s, true, 3)[3].done, false)
  assert.equal(steps(s, true, 0)[3].done, true)
})

test('a fully configured install has nothing left to do', () => {
  const s = settings({
    llmProvider: 'openai',
    openaiApiKey: 'sk-proj-x',
    ingestProvider: 'google',
    googleApiKey: 'AIza-x'
  })
  assert.equal(
    steps(s, true, 0).every((step) => step.done),
    true
  )
})

test('the gap step explains itself differently before and after a résumé exists', () => {
  // Before one exists the step cannot be acted on, so the detail has to say what
  // unblocks it rather than what to do.
  const s = settings()
  assert.match(steps(s, false, 0)[3].detail, /Appears once your résumé has been read/)
  assert.match(steps(s, true, 2)[3].detail, /what a résumé cannot show/)
})

test('every step says something actionable, whatever the settings', () => {
  for (const s of [
    settings(),
    settings({ llmProvider: 'ollama' }),
    settings({ llmProvider: 'groq', groqApiKey: 'gsk_x' })
  ]) {
    for (const step of steps(s)) {
      assert.ok(step.title.length > 0, 'a step has no title')
      assert.ok(step.detail.length > 0, `"${step.title}" has no detail to act on`)
    }
  }
})
