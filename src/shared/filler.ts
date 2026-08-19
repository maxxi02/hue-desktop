/**
 * Is this utterance nothing but filler?
 *
 * The VAD segments on silence, so an interviewer who pauses to think produces a
 * complete speech segment containing "um" and nothing else. Whisper transcribes
 * it faithfully, and the only guard on the firing path was "is the text empty",
 * which "um" passes. Hue then generated a full answer to a hesitation, spent a
 * model call on it, and put it on the surface the user reads aloud from.
 *
 * The test is vocabulary, deliberately, and NOT a word-count minimum. "Why?" is
 * one word and a real question; so is "Thoughts?". Suppressing a real question
 * is an invisible failure — the user watches an empty card while the
 * interviewer waits — whereas answering a stray word is merely an odd answer
 * nobody has to use. So the rule is the conservative direction: every token must
 * be filler for the utterance to be dropped, and one content word anywhere makes
 * the whole thing real.
 */

/**
 * Tokens that carry no question.
 *
 * Hesitations, backchannel, and the acknowledgement noises people make while
 * deciding what to ask next.
 *
 * "so", "well" and "like" are here because as a WHOLE utterance they are the
 * trailing-off case ("so...") rather than a prompt. A bare "So?" meaning "go
 * on" does exist and would be missed; it is much rarer than the hesitation, and
 * being missed costs nothing but a moment of silence.
 *
 * "yes" and "no" are deliberately absent. They are real words with real
 * meaning, and the point of this list is to catch noise, not to start deciding
 * which real words deserve an answer.
 */
const FILLER_TOKENS = new Set([
  'um',
  'uh',
  'uhm',
  'erm',
  'er',
  'ah',
  'aah',
  'hm',
  'hmm',
  'hmmm',
  'mm',
  'mmm',
  'mhm',
  'huh',
  'oh',
  'eh',
  'ok',
  'okay',
  'right',
  'yeah',
  'yep',
  'yup',
  'well',
  'so',
  'like',
  'anyway',
  'sure',
  'alright',
  'gotcha',
  'cool',
  'nice',
  'great',
  'sorry'
])

/**
 * Split on anything that is not a letter, digit, or apostrophe.
 *
 * Matches the tokeniser in `speculation.ts` so the two agree on what a word is.
 * Punctuation falling away for free is what makes "Um..." and "um" the same
 * utterance, and an input of "..." tokenise to nothing at all.
 */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 0)
}

export function isFillerOnly(text: string): boolean {
  const words = tokens(text)
  // Nothing was said. Punctuation-only ("...") and whitespace land here, and
  // both mean the same thing as silence.
  if (words.length === 0) return true
  return words.every((word) => FILLER_TOKENS.has(word))
}
