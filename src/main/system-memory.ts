/**
 * The measuring half of the memory policy (the deciding half is
 * `shared/memory-policy.ts`, which is pure and unit-tested).
 *
 * Lives in main because the renderer cannot see the machine: `navigator
 * .deviceMemory` is capped at 8 and rounded to a power of two, so it reports the
 * same "8" for the 7.8 GB laptop this was written for and for a 16 GB one, and
 * it says nothing at all about how much is actually free. `os.freemem()` is the
 * number the policy needs and only this side has it.
 */
import { app } from 'electron'
import { freemem, totalmem } from 'node:os'
import { memoryPolicy, type MemoryPolicy, type MemorySnapshot } from '../shared/memory-policy.ts'

/**
 * Whether the GPU shares system RAM, or null while unknown.
 *
 * Cached because `getGPUInfo` is async and the policy is read on a path that
 * wants an answer now. Null until the first successful probe, which the policy
 * reads as "don't assume" rather than "no".
 */
let integratedGpu: boolean | null = null

/**
 * Vendors whose consumer parts are overwhelmingly integrated.
 *
 * A heuristic, and worth naming as one: Intel's discrete Arc cards share vendor
 * 0x8086 with the UHD/Iris parts and would be misread as integrated here. The
 * consequence of that misread is Whisper running q8 on the CPU instead of fp32
 * on the GPU — slower transcription, nothing broken — so the failure is in the
 * safe direction and not worth a device-id table to avoid.
 */
const INTEGRATED_VENDOR_IDS = new Set([
  0x8086 // Intel
])

/**
 * Probe the GPU once at startup. Never throws and never rejects: a machine where
 * `getGPUInfo` hangs or fails is a machine that keeps the default policy, not
 * one that fails to start.
 */
export async function probeGpu(): Promise<void> {
  try {
    const info = (await app.getGPUInfo('basic')) as {
      gpuDevice?: { vendorId?: number; deviceId?: number; active?: boolean }[]
    }
    const devices = info?.gpuDevice
    if (!Array.isArray(devices) || devices.length === 0) return
    // Prefer the active device; a laptop with switchable graphics lists both.
    const device = devices.find((d) => d.active) ?? devices[0]
    if (typeof device?.vendorId !== 'number') return
    integratedGpu = INTEGRATED_VENDOR_IDS.has(device.vendorId)
  } catch (e) {
    console.warn('could not read GPU info; assuming a discrete GPU:', e)
  }
}

/** Physical memory right now, plus whatever the GPU probe concluded. */
export function snapshot(): MemorySnapshot {
  return {
    totalMB: Math.round(totalmem() / 1024 / 1024),
    freeMB: Math.round(freemem() / 1024 / 1024),
    ...(integratedGpu === null ? {} : { integratedGpu })
  }
}

/** The snapshot and the policy derived from it, as the renderer consumes them. */
export function currentPolicy(): MemoryPolicy & { snapshot: MemorySnapshot } {
  const snap = snapshot()
  return { ...memoryPolicy(snap), snapshot: snap }
}
