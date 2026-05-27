import { getSettings } from './settings'
import type { CloudAsrResult } from '../shared/types'

/**
 * Tier 3 cloud ASR proxy. Runs in the main process so provider API keys
 * never reach the renderer. Receives raw 16-bit PCM mono @ 16 kHz.
 */
export async function transcribeCloud(pcm16: ArrayBuffer): Promise<CloudAsrResult> {
  const s = getSettings()
  switch (s.cloudAsrProvider) {
    case 'deepgram':
      return deepgram(pcm16, s.deepgramApiKey)
    case 'groq':
      return groq(pcm16, s.groqApiKey)
    case 'assemblyai':
      return assemblyai(pcm16, s.assemblyAiApiKey)
    default:
      throw new Error(`Cloud ASR provider "${s.cloudAsrProvider}" is not supported yet.`)
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

async function deepgram(pcm16: ArrayBuffer, apiKey: string): Promise<CloudAsrResult> {
  if (!apiKey) throw new Error('No Deepgram API key configured. Add one in Settings.')

  const params = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'true',
    smart_format: 'true'
  })

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/octet-stream'
    },
    body: pcm16
  })

  if (!res.ok) {
    throw new Error(`Deepgram error ${res.status}: ${await res.text()}`)
  }

  const data = (await res.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] }
  }
  const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ''
  return { text: text.trim(), provider: 'deepgram' }
}

async function groq(pcm16: ArrayBuffer, apiKey: string): Promise<CloudAsrResult> {
  if (!apiKey) throw new Error('No Groq API key configured. Add one in Settings.')

  const wav = pcm16ToWav(pcm16)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'json')

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })

  if (!res.ok) {
    throw new Error(`Groq error ${res.status}: ${await res.text()}`)
  }

  const data = (await res.json()) as { text?: string }
  return { text: (data.text ?? '').trim(), provider: 'groq' }
}

async function assemblyai(pcm16: ArrayBuffer, apiKey: string): Promise<CloudAsrResult> {
  if (!apiKey) throw new Error('No AssemblyAI API key configured. Add one in Settings.')

  const wav = pcm16ToWav(pcm16)
  const upload = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
    body: wav
  })
  if (!upload.ok) {
    throw new Error(`AssemblyAI upload error ${upload.status}: ${await upload.text()}`)
  }
  const { upload_url: audioUrl } = (await upload.json()) as { upload_url: string }

  const create = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl })
  })
  if (!create.ok) {
    throw new Error(`AssemblyAI transcript error ${create.status}: ${await create.text()}`)
  }
  const { id } = (await create.json()) as { id: string }

  // Poll until the transcript completes (short clips usually finish in a few seconds).
  for (let attempt = 0; attempt < 60; attempt++) {
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: apiKey }
    })
    if (!poll.ok) {
      throw new Error(`AssemblyAI poll error ${poll.status}: ${await poll.text()}`)
    }
    const data = (await poll.json()) as { status: string; text?: string; error?: string }
    if (data.status === 'completed') {
      return { text: (data.text ?? '').trim(), provider: 'assemblyai' }
    }
    if (data.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${data.error}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('AssemblyAI transcription timed out.')
}
