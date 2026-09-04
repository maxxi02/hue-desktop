/**
 * The setup checklist, as a pure function of settings.
 *
 * Pure and therefore testable, which matters more here than the line count it
 * saves: this is the list that tells a new user why Hue is not answering yet,
 * and the order and wording of it are product decisions with reasons recorded
 * against them. See `setup.test.ts`.
 */

import type { HueSettings, LlmProvider } from '../../../../shared/types.ts'
import { COMPAT_PROVIDERS } from './catalog.ts'

export interface SetupStep {
  title: string
  detail: string
  done: boolean
}

/**
 * Whether a provider is usable right now — i.e. it has the credential it needs.
 *
 * Ollama is the exception on purpose: a local server has no key, and demanding
 * a placeholder would make the offline path the only one that looks
 * unconfigured.
 */
export function providerReady(s: HueSettings, p: LlmProvider): boolean {
  if (p === 'ollama') return true
  if (p === 'anthropic') return s.anthropicApiKey.trim().length > 0
  return (s[COMPAT_PROVIDERS[p].keyField] as string).trim().length > 0
}

/** Mirrors `providerFor` in the main process: empty means "same as drafting". */
export function ingestProviderOf(s: HueSettings): LlmProvider {
  return s.ingestProvider || s.llmProvider
}

/**
 * The setup checklist, as a pure function of settings.
 *
 * Module-level rather than computed in the component body because two things
 * need it and one of them is a hook. The rail's unfinished-setup dot and the
 * "open on the category that has work in it" effect both ask "is setup done",
 * and hooks cannot live below the `if (!s)` early return where the component's
 * own derived values are built. Deriving both from one function is what stops
 * the dot and the landing category disagreeing about the same question.
 */
export function buildSetupSteps(s: HueSettings, hasResume: boolean, openGapCount: number): SetupStep[] {
  const ingest = ingestProviderOf(s)
  return [
    {
      title: 'Add a key for the provider that drafts answers',
      detail:
        s.llmProvider === 'ollama'
          ? 'Ollama runs locally and needs no key — make sure it is running and the model name below matches one you have pulled.'
          : 'Pick a provider under Assistant and paste its API key. There are step-by-step instructions under the key field.',
      done: providerReady(s, s.llmProvider)
    },
    {
      title: 'Choose a provider that can read a whole résumé',
      detail:
        ingest === 'groq'
          ? 'Ingest is currently set to Groq, which cannot finish it: reading a résumé needs about 10,000 tokens in one request and Groq’s free tier caps that at 8,000. Set Ingest provider to Google or Ollama. Drafting can stay on Groq.'
          : 'Set an Ingest provider and give it a key. Ingest sends a whole document at once, so it needs more headroom per request than drafting does.',
      done: ingest !== 'groq' && providerReady(s, ingest)
    },
    {
      title: 'Upload your résumé',
      detail:
        'Under Your background. Hue turns it into a story bank and checks every claim against the document, so it can only cite things you actually wrote.',
      done: hasResume
    },
    {
      title: 'Answer the gap questions',
      detail: hasResume
        ? 'They cover what a résumé cannot show. Answering them — or saying you have no story — is what stops Hue inventing one under pressure.'
        : 'Appears once your résumé has been read — the questions are generated from what it does not cover.',
      // Ticked only when genuinely finished. This used to count as done while
      // there was no résumé, on the reasoning that it was blocked by the step
      // above and two open items for one cause reads as twice the work. Seen on
      // screen that was worse: a tick sat above an unticked step, claiming
      // credit for something the user had never done.
      done: hasResume && openGapCount === 0
    }
  ]
}
