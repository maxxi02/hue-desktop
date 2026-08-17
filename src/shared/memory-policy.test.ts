import test from 'node:test'
import assert from 'node:assert/strict'
import {
  memoryPolicy,
  LOW_MEMORY_FREE_MB,
  LOW_MEMORY_TOTAL_MB,
  type MemorySnapshot
} from './memory-policy.ts'

/** A machine with room to spare: 32 GB installed, 20 GB free, discrete GPU. */
const roomy: MemorySnapshot = { totalMB: 32_768, freeMB: 20_000, integratedGpu: false }

test('a roomy machine keeps the warm-start behaviour', () => {
  const p = memoryPolicy(roomy)
  assert.equal(p.preloadModels, true, 'there is room; the first turn should not pay model init')
  assert.equal(p.preferWasm, false, 'fp32 on a discrete GPU is the fast path and costs nothing here')
  assert.equal(p.unloadOnIdle, false, 'reloading per session would be a cost with no benefit')
})

test('an 8 GB machine is constrained even when it is momentarily idle', () => {
  // The reported case: 7.8 GB installed. Measured just after a reboot it can
  // look roomy, and a policy keyed only on free memory would warm both models
  // and then be wrong for the rest of the day.
  const p = memoryPolicy({ totalMB: 7_991, freeMB: 6_000, integratedGpu: true })
  assert.equal(p.preloadModels, false)
  assert.equal(p.preferWasm, true)
  assert.equal(p.unloadOnIdle, true)
})

test('a large machine that is actually full is treated as constrained', () => {
  // Installed RAM is the stable half of the signal, not the whole of it: a 32 GB
  // workstation with 800 MB free has no more room for a preloaded model than an
  // 8 GB laptop does.
  const p = memoryPolicy({ ...roomy, freeMB: 800 })
  assert.equal(p.preloadModels, false)
  assert.equal(p.unloadOnIdle, true)
})

test('integrated graphics forces the wasm path without forcing everything else', () => {
  // A roomy machine with an iGPU should still avoid fp32/WebGPU — that
  // allocation comes out of system RAM shared with the compositor — but it has
  // no reason to give up the warm start or to reload models between sessions.
  const p = memoryPolicy({ totalMB: 32_768, freeMB: 20_000, integratedGpu: true })
  assert.equal(p.preferWasm, true)
  assert.equal(p.preloadModels, true)
  assert.equal(p.unloadOnIdle, false)
})

test('an unknown GPU is not assumed to be integrated', () => {
  const { integratedGpu: _omitted, ...noGpuInfo } = roomy
  assert.equal(
    memoryPolicy(noGpuInfo).preferWasm,
    false,
    'absent information must not silently downgrade a capable machine'
  )
})

test('the thresholds are boundaries, not ranges', () => {
  // Exactly at the total-RAM threshold still counts as constrained: 8 GB is the
  // reported failing configuration, not the first safe one.
  assert.equal(memoryPolicy({ totalMB: LOW_MEMORY_TOTAL_MB, freeMB: 20_000 }).preloadModels, false)
  assert.equal(
    memoryPolicy({ totalMB: LOW_MEMORY_TOTAL_MB + 1, freeMB: 20_000 }).preloadModels,
    true
  )
  // Free memory exactly at the floor is enough; below it is not.
  assert.equal(
    memoryPolicy({ totalMB: 32_768, freeMB: LOW_MEMORY_FREE_MB }).preloadModels,
    true
  )
  assert.equal(
    memoryPolicy({ totalMB: 32_768, freeMB: LOW_MEMORY_FREE_MB - 1 }).preloadModels,
    false
  )
})
