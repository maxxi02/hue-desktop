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
    default:
      throw new Error(`Cloud ASR provider "${s.cloudAsrProvider}" is not supported yet.`)
  }
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
