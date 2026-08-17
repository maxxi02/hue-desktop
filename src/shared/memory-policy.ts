/**
 * How much of itself Hue is allowed to keep resident, given what the machine has
 * left.
 *
 * Pure TypeScript — no Electron, no `os`, no I/O. The caller measures; this only
 * decides. Same discipline as `speculation.ts` and `cuesheet.ts`, for the same
 * reason: the interesting part is a policy matrix, and a policy matrix belongs
 * in fast unit tests rather than in a machine you have to run out of memory to
 * observe.
 *
 * ## Why this exists
 *
 * Hue keeps two ONNX models resident: Whisper for ASR and Kokoro for TTS. On a
 * machine with room, loading both at launch is the right call — the first turn
 * of the first session doesn't pay the model init, which is otherwise several
 * seconds of "Connecting" before Hue can hear anything.
 *
 * On a machine WITHOUT room it is the wrong call, and wrong in a way that is
 * hard to attribute: the models fit, so nothing fails and nothing logs, but free
 * physical memory goes to roughly zero and Windows begins paging. Paging is not
 * an app-local cost. Every other process on the box gets slower, so the symptom
 * that reaches the user is "my PC lags when Hue is open", which sounds nothing
 * like "an assistant preloaded a speech model it wasn't using yet".
 *
 * The fp32/WebGPU path makes it worse on integrated graphics specifically, where
 * GPU memory is carved out of the same system RAM the paging pressure is already
 * coming from.
 */

/**
 * Free physical memory below which Hue stops loading things it does not yet
 * need.
 *
 * Sized against what Hue actually costs, not picked round: Electron's four
 * processes are ~350 MB before any model, Whisper base.en is ~290 MB resident at
 * fp32 (~90 MB at q8), and Kokoro q8 is ~90 MB in the wasm heap. Both models on
 * top of the baseline is comfortably over 700 MB, so a machine with less than
 * 1.5 GB genuinely free cannot host an eagerly-warmed Hue without pushing
 * something else to disk.
 */
export const LOW_MEMORY_FREE_MB = 1_536

/**
 * Total RAM at or below which the machine is treated as constrained regardless
 * of what happens to be free at the moment Hue starts.
 *
 * Free memory is a snapshot and a volatile one — measured right after a reboot
 * almost any machine looks roomy, and a policy keyed only on that would warm
 * both models at launch and then be wrong for the rest of the day. Installed RAM
 * is the stable half of the signal, so an 8 GB machine stays cautious even when
 * it is briefly idle.
 */
export const LOW_MEMORY_TOTAL_MB = 8_192

export interface MemorySnapshot {
  /** Physical RAM installed, in MB. */
  totalMB: number
  /** Physical RAM not currently in use, in MB. */
  freeMB: number
  /**
   * Whether the GPU shares system RAM (integrated graphics) rather than having
   * its own. When it does, a WebGPU allocation is a system-RAM allocation and
   * competes with the paging pressure instead of escaping it.
   */
  integratedGpu?: boolean
}

export interface MemoryPolicy {
  /**
   * Warm the models before the user starts a session. False on a constrained
   * machine: the first turn pays the init cost, which is a delay the user can
   * see and attribute, instead of a system-wide slowdown they cannot.
   */
  preloadModels: boolean
  /**
   * Pin Whisper to the single-threaded wasm/q8 path instead of fp32 on WebGPU.
   * Roughly a third of the resident footprint, and on integrated graphics it
   * also keeps the weights out of memory the desktop compositor is sharing.
   */
  preferWasm: boolean
  /**
   * Tear the models down when a session ends rather than holding them for the
   * next one. Costs a reload per session; returns the footprint to the OS in
   * between, which on a constrained machine is the difference between "Hue is
   * open" and "the PC is paging".
   */
  unloadOnIdle: boolean
}

/**
 * The policy for a machine, from one measurement.
 *
 * Deliberately a single function over a snapshot rather than three independent
 * checks scattered across the renderer: the three answers have to move together.
 * A build that skipped the preload but still loaded fp32 on WebGPU, or that
 * unloaded on idle but re-warmed eagerly on the next config read, would give
 * back most of what the policy is for.
 */
export function memoryPolicy(snapshot: MemorySnapshot): MemoryPolicy {
  const constrained =
    snapshot.totalMB <= LOW_MEMORY_TOTAL_MB || snapshot.freeMB < LOW_MEMORY_FREE_MB

  return {
    preloadModels: !constrained,
    // Integrated graphics is its own reason to stay off fp32/WebGPU even on a
    // machine with plenty of RAM: the allocation lands in system memory either
    // way, and it shares that pool with the desktop compositor.
    preferWasm: constrained || snapshot.integratedGpu === true,
    unloadOnIdle: constrained
  }
}
