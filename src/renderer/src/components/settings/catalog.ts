/**
 * The lookup tables the Settings screen reads from, and nothing that renders.
 *
 * These are catalogues rather than logic: what each provider is called, where
 * its key is issued, and the steps for getting one. They were 200 lines at the
 * top of `Settings.tsx`, read by a component two thousand lines below them.
 *
 * Keeping them here is not only tidiness. `COMPAT_PROVIDERS` is typed
 * `Record<OpenAiCompatProvider, …>` on purpose, so adding a provider to the
 * shared union without adding its key field and signup steps is a compile error
 * rather than an empty panel. That guarantee is easier to see in a file that is
 * only tables.
 *
 * Imports below are relative and carry an explicit `.ts`, rather than the
 * `@shared/types` alias the components use. That alias is resolved by Vite and
 * by tsconfig, neither of which is present under `node --test`, and Node's type
 * stripping resolves a relative specifier literally. Written the other way this
 * module is bundler-only, and the test beside it cannot load it.
 */

import type {
  CloudAsrProvider,
  HueSettings,
  LlmProvider,
  OpenAiCompatProvider,
  WindowAnchor
} from '../../../../shared/types.ts'

export const KOKORO_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'bf_emma', 'bm_george']

/**
 * Résumé ingest as a percentage.
 *
 * The pipeline reports which of four phases it is in, not a fraction, so these
 * are the four points the bar can honestly occupy. They are not evenly spaced
 * because the phases are not: story mining is by far the longest, so giving it
 * the widest span stops the bar sprinting to 75% and then appearing to stall.
 *
 * It deliberately never reaches 100 while running — the last step is the one
 * that writes the bundle, and a bar at 100% with work still happening is the
 * exact thing that makes people think an app has hung.
 */
export const RESUME_PHASE_PCT: Record<string, number> = {
  extracting: 8,
  'mining-profile': 25,
  'mining-stories': 60,
  'gap-scan': 86,
  'tech-probe': 94
}

export interface CompatProviderInfo {
  label: string
  keyField: keyof HueSettings
  modelField: keyof HueSettings
  keyPlaceholder: string
  consoleUrl: string
  /** Step-by-step instructions for obtaining an API key. */
  steps: string[]
}

// Cloud providers that share the OpenAI wire format. Each ships a short guide so
// the user can self-serve an API key. Models are detected live (never hardcoded).
export const COMPAT_PROVIDERS: Record<OpenAiCompatProvider, CompatProviderInfo> = {
  openai: {
    label: 'OpenAI',
    keyField: 'openaiApiKey',
    modelField: 'openaiModel',
    keyPlaceholder: 'sk-proj-…',
    consoleUrl: 'https://platform.openai.com/api-keys',
    steps: [
      'Go to platform.openai.com and sign in.',
      'Open the "API keys" page (link below).',
      'Click "Create new secret key", name it, and confirm.',
      'Copy the key (shown only once, starts with "sk-proj-…") and paste it above.',
      // Same trap as DeepSeek, and it reads the same way from the outside: the
      // key is valid, the account simply has no credit, and the 429 that comes
      // back says "quota" rather than "unfunded".
      'Add credit on the Billing page — a new key on a zero balance returns "You exceeded your current quota", which looks like a rate limit rather than an empty wallet.'
    ]
  },
  google: {
    label: 'Google Gemini',
    keyField: 'googleApiKey',
    modelField: 'googleModel',
    keyPlaceholder: 'AIza…',
    consoleUrl: 'https://aistudio.google.com/app/apikey',
    steps: [
      'Go to aistudio.google.com and sign in with your Google account.',
      'Open the "Get API key" page (link below).',
      'Click "Create API key" and choose or create a Google Cloud project.',
      'Copy the key (it starts with "AIza…") and paste it above.'
    ]
  },
  groq: {
    label: 'Groq',
    keyField: 'groqApiKey',
    modelField: 'groqModel',
    keyPlaceholder: 'gsk_…',
    consoleUrl: 'https://console.groq.com/keys',
    steps: [
      'Go to console.groq.com and create a free account.',
      'Open the "API Keys" section (link below).',
      'Click "Create API Key", give it a name, and submit.',
      'Copy the key (shown only once, starts with "gsk_…") and paste it above.'
    ]
  },
  mistral: {
    label: 'Mistral AI',
    keyField: 'mistralApiKey',
    modelField: 'mistralModel',
    keyPlaceholder: 'Your Mistral key',
    consoleUrl: 'https://console.mistral.ai/api-keys',
    steps: [
      'Go to console.mistral.ai and create an account.',
      'Open the "API Keys" page (link below).',
      'Click "Create new key" and confirm.',
      'Copy the key and paste it above.'
    ]
  },
  cohere: {
    label: 'Cohere',
    keyField: 'cohereApiKey',
    modelField: 'cohereModel',
    keyPlaceholder: 'Your Cohere key',
    consoleUrl: 'https://dashboard.cohere.com/api-keys',
    steps: [
      'Go to dashboard.cohere.com and sign up.',
      'Open the "API Keys" page (link below) — a free trial key is created for you.',
      'Copy the trial key (or create a new one) and paste it above.'
    ]
  },
  deepseek: {
    label: 'DeepSeek',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
    keyPlaceholder: 'sk-…',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    steps: [
      'Go to platform.deepseek.com and create an account.',
      'Open the "API keys" page (link below).',
      'Click "Create new API key", name it, and confirm.',
      'Copy the key (shown only once, starts with "sk-…") and paste it above.',
      // The one step people skip, and the failure it causes looks nothing like
      // its cause: a correctly-created key on a zero balance returns
      // "Insufficient Balance", which reads as a broken key rather than an
      // unfunded account.
      'Add credit on the Billing page — DeepSeek has no free tier, so a new key with a zero balance returns "Insufficient Balance".'
    ]
  }
}

/**
 * Derived from `COMPAT_PROVIDERS` rather than written out.
 *
 * This used to be a hand-maintained `p === 'google' || p === 'groq' || …`
 * chain — a second copy of the list directly above it, with nothing tying the
 * two together. Adding a provider and forgetting the chain does not fail to
 * compile: the provider simply never satisfies the guard, so a correctly
 * configured account silently renders no key field at all. Reading the keys of
 * the record makes that class of bug impossible.
 */
export const isCompatProvider = (p: LlmProvider): p is OpenAiCompatProvider =>
  Object.hasOwn(COMPAT_PROVIDERS, p)

// Cloud ASR providers and the settings key holding each one's credential. Only
// the selected provider's key is shown, to keep the section uncluttered. Each
// ships a short self-serve guide for obtaining an API key (mirrors COMPAT_PROVIDERS).
export const CLOUD_ASR: Record<
  CloudAsrProvider,
  { label: string; keyField: keyof HueSettings; consoleUrl: string; steps: string[] }
> = {
  deepgram: {
    label: 'Deepgram Nova-3',
    keyField: 'deepgramApiKey',
    consoleUrl: 'https://console.deepgram.com',
    steps: [
      'Go to console.deepgram.com and create a free account (comes with free credit).',
      'Verify your email and sign in to the Deepgram Console.',
      'Open the "API Keys" page from the left sidebar (link below).',
      'Click "Create a New API Key", give it a name, and keep the default scopes.',
      'Copy the key (shown only once) and paste it above.'
    ]
  },
  assemblyai: {
    label: 'AssemblyAI',
    keyField: 'assemblyAiApiKey',
    consoleUrl: 'https://www.assemblyai.com/dashboard',
    steps: [
      'Go to assemblyai.com and create a free account.',
      'Verify your email and sign in to the dashboard (link below).',
      'Your API key is shown on the dashboard home under "Your API key".',
      'Copy the key and paste it above.'
    ]
  },
  groq: {
    label: 'Groq Whisper',
    keyField: 'groqApiKey',
    consoleUrl: 'https://console.groq.com/keys',
    steps: [
      'Go to console.groq.com and create a free account.',
      'Open the "API Keys" section (link below).',
      'Click "Create API Key", give it a name, and submit.',
      'Copy the key (shown only once, starts with "gsk_…") and paste it above.'
    ]
  }
}

/**
 * The nine docking positions, in reading order so the array maps straight onto a
 * 3x3 CSS grid. 'free' is deliberately absent: it is not a position you aim at,
 * it is the state you fall into by dragging the window, so it gets its own
 * button rather than a tenth cell that would have nowhere sensible to sit.
 */
export const ANCHOR_CELLS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
] as const satisfies readonly WindowAnchor[]

export const ANCHOR_LABELS: Record<(typeof ANCHOR_CELLS)[number], string> = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'center-left': 'Middle left',
  center: 'Centre',
  'center-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right'
}
