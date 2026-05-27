export interface Recorder {
  stop: () => Promise<Float32Array>
}

const TARGET_SAMPLE_RATE = 16000

/**
 * Push-to-talk style recorder used by the Step 1 test harness.
 * Captures mono audio resampled to 16 kHz (Whisper's expected rate).
 * The real pipeline uses VAD instead, which already emits 16 kHz Float32.
 */
export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })

  const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  // Zero-gain sink so the node runs without echoing the mic back to speakers.
  const mute = ctx.createGain()
  mute.gain.value = 0

  const chunks: Float32Array[] = []
  processor.onaudioprocess = (e): void => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  }

  source.connect(processor)
  processor.connect(mute)
  mute.connect(ctx.destination)

  return {
    async stop(): Promise<Float32Array> {
      processor.disconnect()
      source.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      await ctx.close()

      const total = chunks.reduce((n, c) => n + c.length, 0)
      const out = new Float32Array(total)
      let offset = 0
      for (const c of chunks) {
        out.set(c, offset)
        offset += c.length
      }
      return out
    }
  }
}
