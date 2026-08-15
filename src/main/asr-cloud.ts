import { getSettings } from './settings'
import { fetchWithRetry, ProviderHttpError } from './stream-resilience'
import { record } from './usage-store'
import { parseRateLimitHeaders, type RateLimitSnapshot } from '../shared/usage'
import type { CloudAsrResult } from '../shared/types'

/**
 * Every utterance in the interview goes through here, so a request with no
 * deadline is not "slow" — it is a promise that never settles, an utterance that
 * silently never becomes a transcript, and one more dead in-flight request
 * stacked up behind the next one. A transcript that arrives after the candidate
 * has already had to answer is worthless, so the budget is short by design:
 * better to fail this utterance and let the next one through.
 */
const ASR_DEADLINE_MS = 20_000
/**
 * AssemblyAI is upload → create → poll, so it gets a longer budget than the
 * single-shot providers — but nothing like the 60 s it used to take, which was
 * long enough for the answer to arrive a full minute into the next question.
 */
const ASR_POLL_DEADLINE_MS = 30_000

/**
 * One transcription attempt, carrying whatever the vendor said about quota.
 *
 * Threaded through explicitly rather than kept in a module-level variable
 * because utterances can overlap — a slow AssemblyAI poll is still running when
 * the next utterance starts — and a shared slot would credit one utterance's
 * headroom to another.
 */
interface AsrCall {
  provider: string
  limit: RateLimitSnapshot | null
}

/**
 * 16-bit mono @ 16 kHz: two bytes a sample, sixteen thousand samples a second.
 * Seconds of audio, not bytes, is what every one of these vendors bills in.
 */
function audioSecondsOf(pcm16: ArrayBuffer): number {
  return pcm16.byteLength / 32_000
}

/**
 * Tier 3 cloud ASR proxy. Runs in the main process so provider API keys
 * never reach the renderer. Receives raw 16-bit PCM mono @ 16 kHz.
 */
export async function transcribeCloud(pcm16: ArrayBuffer): Promise<CloudAsrResult> {
  const s = getSettings()
  const provider = s.cloudAsrProvider
  const call: AsrCall = { provider, limit: null }

  try {
    let result: CloudAsrResult
    switch (provider) {
      case 'deepgram':
        result = await deepgram(pcm16, s.deepgramApiKey, call)
        break
      case 'groq':
        result = await groq(pcm16, s.groqApiKey, call)
        break
      case 'assemblyai':
        result = await assemblyai(pcm16, s.assemblyAiApiKey, call)
        break
      default:
        throw new Error(`Cloud ASR provider "${provider}" is not supported yet.`)
    }
    record({
      at: Date.now(),
      kind: 'asr',
      provider,
      audioSeconds: audioSecondsOf(pcm16),
      limit: call.limit ?? undefined
    })
    return result
  } catch (err) {
    // The utterance was lost, so no audio seconds — the vendor transcribed
    // nothing and billed for nothing. The headroom is still worth keeping: a
    // 429 is the most informative thing this app ever hears about quota, and
    // it would be perverse to discard it precisely when the limit is binding.
    const limit =
      err instanceof ProviderHttpError
        ? (parseRateLimitHeaders(provider, err.headers, Date.now()) ?? call.limit)
        : call.limit
    if (limit) record({ at: Date.now(), kind: 'asr', provider, limit })
    throw err
  }
}

/**
 * One bounded, retrying request. The deadline is the caller's whole budget, so a
 * retry cannot extend it — three attempts inside 20 s, then the utterance is
 * declared lost with a message the renderer can actually show.
 */
async function asrFetch(
  url: string,
  init: RequestInit,
  label: string,
  deadline: AbortSignal,
  call: AsrCall
): Promise<Response> {
  try {
    const res = await fetchWithRetry(url, init, label, { signal: deadline })
    // Every response is a fresh reading, so the last one wins — which for
    // AssemblyAI means the final poll rather than the upload that preceded it.
    // Only Groq fills these in; for Deepgram and AssemblyAI this stays null and
    // the panel shows a dash rather than a fabricated zero.
    call.limit = parseRateLimitHeaders(call.provider, res.headers, Date.now()) ?? call.limit
    return res
  } catch (err) {
    const e = err as { name?: string }
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || deadline.aborted) {
      throw new Error(`${label} did not answer in time; this utterance was dropped.`)
    }
    throw err
  }
}

/**
 * Wrap raw 16-bit LE PCM mono @ 16 kHz in a WAV container. Deepgram accepts raw
 * linear16, but Groq and AssemblyAI are file-upload APIs and need a real header.
 */
function pcm16ToWav(pcm16: ArrayBuffer, sampleRate = 16000): ArrayBuffer {
  const dataLength = pcm16.byteLength
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const writeStr = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, dataLength, true)
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm16))
  return buffer
}

async function deepgram(
  pcm16: ArrayBuffer,
  apiKey: string,
  call: AsrCall
): Promise<CloudAsrResult> {
  if (!apiKey) throw new Error('No Deepgram API key configured. Add one in Settings.')

  const params = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'true',
    smart_format: 'true'
  })

  const res = await asrFetch(
    `https://api.deepgram.com/v1/listen?${params}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/octet-stream'
      },
      body: pcm16
    },
    'Deepgram',
    AbortSignal.timeout(ASR_DEADLINE_MS),
    call
  )

  const data = (await res.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] }
  }
  const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
  return { text: text.trim(), provider: 'deepgram' }
}

async function groq(
  pcm16: ArrayBuffer,
  apiKey: string,
  call: AsrCall
): Promise<CloudAsrResult> {
  if (!apiKey) throw new Error('No Groq API key configured. Add one in Settings.')

  const wav = pcm16ToWav(pcm16)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'json')

  const res = await asrFetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    },
    'Groq',
    AbortSignal.timeout(ASR_DEADLINE_MS),
    call
  )

  const data = (await res.json()) as { text?: string }
  return { text: (data.text ?? '').trim(), provider: 'groq' }
}

async function assemblyai(
  pcm16: ArrayBuffer,
  apiKey: string,
  call: AsrCall
): Promise<CloudAsrResult> {
  if (!apiKey) throw new Error('No AssemblyAI API key configured. Add one in Settings.')

  // One deadline for the whole upload → create → poll sequence, so a slow upload
  // eats into the polling budget rather than adding to it.
  const deadline = AbortSignal.timeout(ASR_POLL_DEADLINE_MS)

  const wav = pcm16ToWav(pcm16)
  const upload = await asrFetch(
    'https://api.assemblyai.com/v2/upload',
    {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
      body: wav
    },
    'AssemblyAI upload',
    deadline,
    call
  )
  const { upload_url: audioUrl } = (await upload.json()) as { upload_url: string }

  const create = await asrFetch(
    'https://api.assemblyai.com/v2/transcript',
    {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl })
    },
    'AssemblyAI transcript',
    deadline,
    call
  )
  const { id } = (await create.json()) as { id: string }

  // Poll until the transcript completes (short clips usually finish in a few
  // seconds). Bounded by the same deadline: a job that is still queued when the
  // budget runs out is a lost utterance, not something to keep waiting on while
  // the interviewer moves to the next question.
  while (!deadline.aborted) {
    const poll = await asrFetch(
      `https://api.assemblyai.com/v2/transcript/${id}`,
      { headers: { authorization: apiKey } },
      'AssemblyAI poll',
      deadline,
      call
    )
    const data = (await poll.json()) as { status: string; text?: string; error?: string }
    if (data.status === 'completed') {
      return { text: (data.text ?? '').trim(), provider: 'assemblyai' }
    }
    if (data.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${data.error}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('AssemblyAI did not answer in time; this utterance was dropped.')
}
