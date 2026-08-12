import type { Competency } from '../shared/profile.ts'

/**
 * The pipeline's own view of a profile — narrower than the renderer's.
 *
 * `shared/profile.ts` types `competencies` as `string[]` and omits per-role
 * `stack`/`summary`, and that is correct *there*: `parseProfileBundle` reads a
 * JSON blob off disk that any earlier version of the app could have written, so
 * claiming the competency strings are a closed union would be a lie the type
 * system cannot check.
 *
 * In here the opposite is true. The pipeline filters competencies against
 * `COMPETENCIES` before anything is kept, so downstream code genuinely does
 * know the value is in the union — and typing it as `string` would silently
 * disable the exhaustiveness checks that stop a new competency being added in
 * one place and forgotten in another.
 *
 * These types are assignable to the shared ones, never the reverse, so the
 * conversion happens exactly once: where a sealed bundle is handed to the
 * renderer.
 */

export interface Identity {
  name: string | null
  headline: string | null
  location: string | null
  email: string | null
  links: string[]
}

export interface Role {
  id: string
  company: string
  title: string
  /** ISO `YYYY-MM`, or null when the resume gives no date. Never inferred. */
  start: string | null
  end: string | null
  current: boolean
  stack: string[]
  summary: string | null
}

export interface Education {
  institution: string
  credential: string | null
  field: string | null
  end: string | null
}

/** A number the user may safely cite out loud, with the claim it belongs to. */
export interface Metric {
  roleId: string | null
  value: string
  claim: string
}

export type StorySource = 'resume' | 'gap-answer'

export interface Story {
  id: string
  roleId: string | null
  competencies: Competency[]
  situation: string
  task: string
  action: string
  result: string
  /** Verbatim metric strings this story is allowed to cite. */
  metrics: string[]
  source: StorySource
}

export type GapStatus = 'open' | 'answered' | 'skipped'

export interface Gap {
  id: string
  competency: Competency
  question: string
  status: GapStatus
  /** Set when an answer has been folded back into the bank as a new story. */
  storyId: string | null
}

export interface Profile {
  identity: Identity
  roles: Role[]
  education: Education[]
  skills: string[]
  metrics: Metric[]
}

export interface ProfileBundle {
  version: number
  /** sha256 over the content only — see `contentHash`. */
  hash: string
  createdAt: string
  profile: Profile
  stories: Story[]
  gaps: Gap[]
}

/** A profile with every field explicitly empty — never a guess, never absent. */
export function emptyProfile(): Profile {
  return {
    identity: { name: null, headline: null, location: null, email: null, links: [] },
    roles: [],
    education: [],
    skills: [],
    metrics: []
  }
}
