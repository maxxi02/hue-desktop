/**
 * The `ProfileBundle` — the desktop's copy of the contract `hue-ingest` owns.
 *
 * This replaces the freeform `resumeSummary`, which was the whole resume pasted
 * into the system prompt as prose. That worked, but it gave the model no way to
 * distinguish a fact from a gap: asked for a failure story by a resume that
 * contains none, the only thing it can do is invent one. A bundle names the
 * stories that exist, names their ids, and says explicitly what to return when
 * none of them fit.
 *
 * The types are duplicated here rather than imported because hue-ingest is a
 * separate deployable with no published package. The duplication is deliberate
 * and bounded: the shape is frozen by the content hash, which is a cache key on
 * `hue-edge` and a sync key on the phone, so it cannot drift quietly.
 */

export interface ProfileIdentity {
  name: string | null
  headline: string | null
  location: string | null
  email: string | null
  links: string[]
}

export interface ProfileRole {
  id: string
  company: string
  title: string
  start: string | null
  end: string | null
  current: boolean
  stack: string[]
  summary: string | null
}

export interface ProfileEducation {
  institution: string
  credential: string | null
  field: string | null
  end: string | null
}

export interface ProfileMetric {
  roleId: string | null
  value: string
  claim: string
}

export interface ProfileStory {
  id: string
  roleId: string | null
  competencies: string[]
  situation: string
  task: string
  action: string
  result: string
  metrics: string[]
  source: 'resume' | 'gap-answer'
}

export interface ProfileGap {
  id: string
  competency: string
  question: string
  status: 'open' | 'answered' | 'skipped'
  storyId: string | null
}

export interface Profile {
  identity: ProfileIdentity
  roles: ProfileRole[]
  education: ProfileEducation[]
  skills: string[]
  metrics: ProfileMetric[]
}

export interface ProfileBundle {
  version: number
  hash: string
  createdAt: string
  profile: Profile
  stories: ProfileStory[]
  gaps: ProfileGap[]
}

export type IngestPhase = 'uploading' | 'extracting' | 'working'

/** Progress for the Settings label while an ingest runs. */
export interface IngestProgress {
  phase: IngestPhase
  elapsedSeconds: number
}

/**
 * The result of an ingest.
 *
 * `retryable` is the load-bearing field: an unreadable scan will fail
 * identically on a second upload, so telling the user to try again would send
 * them round the same loop. A network blip genuinely is worth retrying.
 */
export type IngestOutcome =
  | { ok: true; bundle: ProfileBundle }
  | { ok: false; message: string; retryable: boolean }

/**
 * Shape-checks a bundle parsed from disk or from the network.
 *
 * Settings are user-editable JSON on disk, and a half-written bundle would
 * otherwise reach the prompt builder and throw mid-session — the one moment
 * this app cannot afford an exception. Cheap, and it fails at load rather than
 * at the worst possible time.
 */
export function isProfileBundle(value: unknown): value is ProfileBundle {
  if (typeof value !== 'object' || value === null) return false
  const bundle = value as Partial<ProfileBundle>
  return (
    typeof bundle.version === 'number' &&
    typeof bundle.hash === 'string' &&
    bundle.hash.length > 0 &&
    typeof bundle.profile === 'object' &&
    bundle.profile !== null &&
    Array.isArray(bundle.profile.roles) &&
    Array.isArray(bundle.stories)
  )
}

export function parseProfileBundle(raw: string): ProfileBundle | null {
  if (!raw.trim()) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isProfileBundle(parsed) ? parsed : null
  } catch {
    return null
  }
}

function dateRange(role: ProfileRole): string | null {
  if (!role.start && !role.end && !role.current) return null
  return `${role.start ?? '?'} – ${role.current ? 'present' : (role.end ?? '?')}`
}

/**
 * Renders the bundle as the grounding block that goes in the system prompt.
 *
 * Byte-identical for a given bundle, and identical to what hue-ingest and the
 * Android client render. That matters beyond tidiness: `hue-edge` caches this
 * block against the bundle's content hash, so a desktop that rendered it
 * differently would produce a cache key describing text nobody sent.
 */
export function profilePromptBlock(bundle: ProfileBundle): string {
  const lines: string[] = []
  const p = bundle.profile

  lines.push('# Candidate profile')
  lines.push('')
  lines.push("Every fact below is taken from the candidate's own resume or their own answers.")
  lines.push('A field that is absent is UNKNOWN. Never state, imply, or infer an unknown field.')
  lines.push('')
  if (p.identity.name) lines.push(`Name: ${p.identity.name}`)
  if (p.identity.headline) lines.push(`Headline: ${p.identity.headline}`)
  if (p.identity.location) lines.push(`Location: ${p.identity.location}`)
  lines.push('')
  lines.push('## Roles')
  for (const role of p.roles) {
    const dates = dateRange(role)
    lines.push(`- [${role.id}] ${role.title}, ${role.company}${dates ? ` (${dates})` : ''}`)
    if (role.stack.length) lines.push(`  stack: ${role.stack.join(', ')}`)
    if (role.summary) lines.push(`  ${role.summary}`)
  }
  if (p.education.length) {
    lines.push('')
    lines.push('## Education')
    for (const e of p.education) {
      const credential = [e.credential, e.field].filter(Boolean).join(' ')
      lines.push(`- ${credential} — ${e.institution}${e.end ? `, ${e.end}` : ''}`)
    }
  }
  if (p.skills.length) {
    lines.push('')
    lines.push('## Skills')
    lines.push(p.skills.join(', '))
  }
  if (p.metrics.length) {
    lines.push('')
    lines.push('## Citable metrics')
    lines.push('These figures are verified. Any other figure must not be stated.')
    for (const m of p.metrics) lines.push(`- ${m.value} — ${m.claim}`)
  }
  lines.push('')
  lines.push('## Story bank')
  lines.push('Select by competency tag. Cite the chosen entry by its id as `story_id`.')
  lines.push('If no entry fits, return `story_id: null` rather than inventing a story.')
  for (const s of bundle.stories) {
    lines.push('')
    lines.push(`### [${s.id}] tags: ${s.competencies.join(', ')}`)
    lines.push(`S: ${s.situation}`)
    lines.push(`T: ${s.task}`)
    lines.push(`A: ${s.action}`)
    lines.push(`R: ${s.result}`)
    if (s.metrics.length) lines.push(`metrics: ${s.metrics.join('; ')}`)
  }

  return lines.join('\n').trimEnd()
}

/**
 * A one-line description for Settings — "12 stories across 3 roles, 2 gaps left".
 *
 * The gap count is the useful half: it is the only signal telling the user there
 * is something still worth doing.
 */
export function describeBundle(bundle: ProfileBundle): string {
  const stories = bundle.stories.length
  const roles = bundle.profile.roles.length
  const open = bundle.gaps.filter((g) => g.status === 'open').length
  const parts = [
    `${stories} ${stories === 1 ? 'story' : 'stories'} across ${roles} ${roles === 1 ? 'role' : 'roles'}`
  ]
  if (open > 0) parts.push(`${open} ${open === 1 ? 'gap' : 'gaps'} left to fill`)
  return parts.join(' · ')
}
