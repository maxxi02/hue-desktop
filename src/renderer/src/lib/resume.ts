// Extracts plain text from an uploaded résumé so it can populate the assistant's
// interview context. PDF/DOCX parsers are dynamically imported to keep them out
// of the initial renderer bundle.

export interface ResumeParseResult {
  text: string
  fileName: string
  fileType: 'pdf' | 'docx' | 'txt'
  wordCount: number
}

export async function parseResume(file: File): Promise<ResumeParseResult> {
  const ext = file.name.split('.').pop()?.toLowerCase()

  if (ext === 'pdf') return parsePDF(file)
  if (ext === 'docx') return parseDOCX(file)
  if (ext === 'txt') return parseTXT(file)

  throw new Error(
    `Unsupported file type: .${ext ?? 'unknown'}. Please upload a PDF, DOCX, or TXT file.`
  )
}

async function parsePDF(file: File): Promise<ResumeParseResult> {
  const { extractText } = await import('unpdf')
  const buffer = await file.arrayBuffer()
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true })
  const cleaned = cleanText(text)
  return { text: cleaned, fileName: file.name, fileType: 'pdf', wordCount: countWords(cleaned) }
}

async function parseDOCX(file: File): Promise<ResumeParseResult> {
  const mammoth = await import('mammoth')
  const buffer = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer: buffer })
  const cleaned = cleanText(result.value)
  return { text: cleaned, fileName: file.name, fileType: 'docx', wordCount: countWords(cleaned) }
}

async function parseTXT(file: File): Promise<ResumeParseResult> {
  const cleaned = cleanText(await file.text())
  return { text: cleaned, fileName: file.name, fileType: 'txt', wordCount: countWords(cleaned) }
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}
