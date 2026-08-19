import type { CloudAsrProvider } from './types.ts'

/**
 * The language every cloud ASR request is pinned to.
 *
 * **Why this exists.** Groq's `whisper-large-v3-turbo` is the multilingual
 * Whisper, and a request without a language field runs auto-detection
 * independently on every clip. Detection is unreliable on exactly the audio this
 * app sends it: short utterances, room noise, a compressed call. When it
 * misdetects, Whisper does not merely label the clip wrong, it transcribes
 * *into* the language it picked. A live interview question came back on screen
 * as Indonesian, and Chinese on other occasions, while the interviewer was
 * speaking English.
 *
 * The on-device tier never had this failure, and not by luck:
 * `Xenova/whisper-base.en` is English-only and has no other language available
 * to it. Pinning here is what gives the cloud tier the same guarantee the model
 * file gives the local one, rather than leaving the two tiers silently
 * disagreeing about what languages the app supports.
 *
 * Hardcoded rather than a setting, deliberately. The app is already English-only
 * wherever the on-device model runs, so a language setting would be a promise
 * only one of the two tiers could keep.
 */
export const ASR_LANGUAGE = 'en'

/**
 * The language fields to attach to a request for `provider`.
 *
 * Returned as entries rather than an object because the three providers carry
 * them differently: Deepgram in a query string, Groq in multipart form data,
 * AssemblyAI in a JSON body. Entries drop into all three without a conversion
 * step at each call site.
 *
 * The field name differs per API and getting it wrong fails silently, which is
 * the dangerous part: every one of these APIs ignores a field it does not
 * recognise and falls straight back to auto-detection. A typo here does not
 * throw, it just restores the bug.
 *
 * Pure, and in `shared/` rather than beside the request code, because
 * `asr-cloud.ts` imports `settings.ts` which imports `electron` and therefore
 * cannot be loaded by `node --test`. Same arrangement, and the same reason, as
 * `answer-shape.ts` and `speculation.ts`.
 */
export function languageEntriesFor(provider: CloudAsrProvider): Array<[string, string]> {
  switch (provider) {
    case 'deepgram':
      return [['language', ASR_LANGUAGE]]
    case 'groq':
      return [['language', ASR_LANGUAGE]]
    case 'assemblyai':
      // Not `language`. AssemblyAI spells it `language_code`, and sending the
      // other spelling would be indistinguishable from sending nothing.
      return [['language_code', ASR_LANGUAGE]]
  }
}
