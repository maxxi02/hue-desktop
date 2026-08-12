import { createHash } from 'node:crypto'
import { canonicalJson, profilePromptBlock, type ProfileBundle } from '../shared/profile.ts'

/**
 * Bundle sealing, in the main process rather than in `shared/`.
 *
 * `shared/profile.ts` is imported by the renderer, and `node:crypto` is not
 * available there. The split is not stylistic: putting this in `shared/` breaks
 * the renderer bundle at build time.
 */

/**
 * Content hash of a bundle. `hash` and `createdAt` are excluded on purpose:
 * including either makes every re-ingest of an unchanged resume produce a fresh
 * hash, which defeats both the prompt cache and the device sync check.
 */
export function contentHash(bundle: Omit<ProfileBundle, 'hash' | 'createdAt'>): string {
  const { version, profile, stories, gaps } = bundle
  return createHash('sha256')
    .update(canonicalJson({ version, profile, stories, gaps }))
    .digest('hex')
}

/**
 * Stamps a bundle with its content hash. The only supported way to build one.
 *
 * Generic over the parts, so a caller working in the pipeline's narrow types
 * (`resume-types.ts`, where competencies are a closed union) gets those types
 * back rather than the renderer's wider ones. Fixing the return type to the
 * shared `ProfileBundle` would silently widen every bundle the pipeline seals
 * and undo the exhaustiveness checking the narrow types exist for.
 */
export function sealBundle<T extends Omit<ProfileBundle, 'hash' | 'createdAt'>>(
  parts: T,
  createdAt: string
): T & { hash: string; createdAt: string } {
  return { ...parts, hash: contentHash(parts), createdAt }
}

/**
 * Approximate token count of the prompt block this bundle becomes.
 *
 * ~4 chars per token is crude, but the number it guards is a budget rather than
 * a billing figure, and a dependency-free estimate that is always available
 * beats an exact one that needs a network call.
 *
 * Measured against `profilePromptBlock` — the desktop's renderer of the block —
 * rather than porting hue-ingest's separate `promptBlock`. Two renderers of the
 * same thing would diverge, and this estimate guards a budget that the *other*
 * function's output has to fit inside.
 */
export function estimateTokens(bundle: ProfileBundle): number {
  return Math.ceil(profilePromptBlock(bundle).length / 4)
}
