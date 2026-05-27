// Runs raw résumé text (as extracted from a PDF/DOCX) through the configured LLM
// once, to repair the messy ordering/line breaks/noise that extraction leaves
// behind. The cleaned result is what feeds the interview system prompt, so the
// assistant reads the background reliably instead of a jumbled dump.

import type { LlmStreamRequest } from '@shared/types'

const CLEANUP_SYSTEM = `You clean up résumé text that was extracted from a PDF or DOCX. The raw text often has columns merged out of order, broken line breaks, page numbers, and repeated header/footer noise.

Rewrite it into one clear, well-organized plain-text summary of the candidate's background that an interview assistant can read easily. Rules:
- Keep every real fact: name, job titles, employers, dates, education, skills, projects, and measurable achievements. Do not drop details.
- Fix ordering and line breaks so it reads naturally, grouped into sections (e.g. Summary, Experience, Education, Skills).
- Remove extraction noise: page numbers, repeated headers/footers, stray symbols, broken hyphenation.
- NEVER invent, embellish, or guess. If something is unclear or garbled beyond recognition, leave it out.
- Output ONLY the cleaned summary as plain text. No preamble, no markdown, no code fences, no commentary.`

/**
 * Drive a single non-streaming completion by reusing the streaming LLM IPC and
 * accumulating the deltas. Resolves with the full text, rejects on error/abort/
 * timeout. Uses the provider/key from the *saved* settings (the main process
 * reads them), so the LLM must be configured before this is called.
 */
function completeOnce(req: LlmStreamRequest, timeoutMs = 60000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const streamId = crypto.randomUUID()
    let text = ''
    const disposers: Array<() => void> = []
    const cleanup = (): void => {
      disposers.forEach((d) => d())
      disposers.length = 0
    }

    disposers.push(
      window.hue.llm.onDelta((e) => {
        if (e.streamId === streamId) text += e.text
      }),
      window.hue.llm.onDone((e) => {
        if (e.streamId !== streamId) return
        cleanup()
        if (e.aborted) reject(new Error('Clean-up was interrupted.'))
        else resolve(text)
      }),
      window.hue.llm.onError((e) => {
        if (e.streamId !== streamId) return
        cleanup()
        reject(new Error(e.message))
      })
    )

    const timer = setTimeout(() => {
      window.hue.llm.abort(streamId)
      cleanup()
      reject(new Error('Clean-up timed out.'))
    }, timeoutMs)
    disposers.push(() => clearTimeout(timer))

    void window.hue.llm.start(streamId, req)
  })
}

/** Reorganize raw résumé text into a clean, structured plain-text summary. */
export async function cleanResumeText(rawText: string): Promise<string> {
  const cleaned = await completeOnce({
    system: CLEANUP_SYSTEM,
    messages: [{ role: 'user', content: rawText }],
    maxTokens: 1500
  })
  return cleaned.trim()
}
