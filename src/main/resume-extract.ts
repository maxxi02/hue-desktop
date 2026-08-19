import { extractText as extractPdfText } from 'unpdf'
import mammoth from 'mammoth'

/**
 * Turns an uploaded resume into text, or explains why it could not.
 *
 * Format is decided by magic bytes, never by the filename. A user renaming a
 * scan to `.pdf` is ordinary, and trusting the extension means the failure
 * surfaces as a hallucinated profile instead of a clear error.
 *
 * This replaces `hue-ingest`'s hand-rolled PDF and DOCX readers. Those existed
 * to satisfy the services' zero-runtime-dependency rule, which does not apply
 * inside Electron — `unpdf` and `mammoth` are already bundled.
 * What is kept is the part that actually protects the product: the validation
 * that turns an unreadable document into a refusal rather than into confident,
 * fabricated output.
 */

export type ExtractFailure =
  | 'unsupported-format'
  | 'no-text-layer'
  | 'unreadable-text-layer'
  | 'too-short'
  | 'too-large'

export type ExtractResult =
  | { ok: true; text: string; format: 'pdf' | 'docx' | 'text'; chars: number }
  | { ok: false; reason: ExtractFailure; message: string }

/** A resume is two pages. Anything past this is a portfolio, and out of scope. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/**
 * Below this, extraction produced a header and nothing else — which is exactly
 * what a scanned page looks like. Refusing is right: there is no useful profile
 * in 200 characters, and inventing one from a name alone is the failure mode
 * this whole pipeline is built to prevent.
 */
export const MIN_USEFUL_CHARS = 200

const FAILURE_MESSAGES: Record<ExtractFailure, string> = {
  'unsupported-format':
    'That file is not a PDF, a Word document, or plain text. Export your resume as a PDF and try again.',
  'no-text-layer':
    'This PDF has no text in it — it looks like a scan or an image. Export a text PDF from the original document, or paste the text instead.',
  'unreadable-text-layer':
    'This PDF\'s text could not be read; it uses a font encoding we cannot decode. Try "Print to PDF" from the original document, or paste the text instead.',
  'too-short': 'We only found a few words in that file. If it is a scan, paste the text instead.',
  'too-large': 'That file is larger than 10 MB. Upload the resume itself rather than a portfolio.'
}

function fail(reason: ExtractFailure): ExtractResult {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason] }
}

export function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '%PDF-'
}

/** A .docx is a ZIP. Whether it is *this* kind of ZIP is mammoth's problem, below. */
export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50
}

/** UTF-8 text that is not one of the binary formats we know. */
function looksLikePlainText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096)
  for (const byte of sample) {
    // NUL never appears in text and is the cheapest binary tell there is.
    if (byte === 0) return false
  }
  return true
}

/**
 * Is this plausibly prose, or did we decode a font's glyph ids?
 *
 * A PDF whose font encoding could not be resolved yields bytes that are not
 * text, and the result reads as dense control characters and accented Latin-1.
 * The check is cheap, and the alternative — handing mojibake to the extractor —
 * produces a fully fabricated profile with no signal that anything went wrong.
 */
export function looksLikeProse(text: string): boolean {
  const trimmed = text.replace(/\s/g, '')
  if (trimmed.length < 40) return false
  let readable = 0
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xc0 && code <= 0x24f)) readable++
  }
  if (readable / trimmed.length < 0.85) return false
  // Real prose has vowels. Glyph-id soup passes the printable test and fails this.
  const letters = trimmed.match(/[a-zA-Z]/g)?.length ?? 0
  const vowels = trimmed.match(/[aeiouAEIOU]/g)?.length ?? 0
  return letters >= 20 && vowels / letters > 0.2
}

export async function extractResume(buf: Buffer): Promise<ExtractResult> {
  if (buf.length > MAX_UPLOAD_BYTES) return fail('too-large')

  if (isPdf(buf)) {
    let text: string
    try {
      const extracted = await extractPdfText(new Uint8Array(buf), { mergePages: true })
      text = typeof extracted.text === 'string' ? extracted.text : String(extracted.text ?? '')
    } catch {
      // A PDF the reader cannot open at all is, from the user's side, the same
      // situation as one with no text in it: there is nothing to extract.
      return fail('no-text-layer')
    }
    if (text.trim().length === 0) return fail('no-text-layer')
    // A text layer that decodes to glyph soup is worse than none: it is
    // plausible-looking input that yields a fully invented profile.
    if (!looksLikeProse(text)) return fail('unreadable-text-layer')
    if (text.length < MIN_USEFUL_CHARS) return fail('too-short')
    return { ok: true, text, format: 'pdf', chars: text.length }
  }

  if (isZip(buf)) {
    // A .docx is a ZIP; a .zip of anything else is not. Rather than reimplement
    // a ZIP directory reader just to look for `word/document.xml`, let mammoth
    // decide — it fails on a ZIP that is not a Word document, which is exactly
    // the question being asked.
    let text: string
    try {
      const { value } = await mammoth.extractRawText({ buffer: buf })
      text = value
    } catch {
      return fail('unsupported-format')
    }
    if (text.length === 0) return fail('no-text-layer')
    if (text.length < MIN_USEFUL_CHARS) return fail('too-short')
    return { ok: true, text, format: 'docx', chars: text.length }
  }

  if (looksLikePlainText(buf)) {
    const text = buf.toString('utf8').trim()
    if (text.length < MIN_USEFUL_CHARS) return fail('too-short')
    return { ok: true, text, format: 'text', chars: text.length }
  }

  return fail('unsupported-format')
}
