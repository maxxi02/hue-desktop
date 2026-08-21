import type { HueSettings } from './types.ts'

/**
 * Saved applications: the sets of "who am I interviewing with" a user switches
 * between.
 *
 * Someone interviewing is rarely interviewing once. They have three postings
 * open, a tailored résumé for two of them, and an analysis per posting that took
 * a minute and an API call to produce. Before this, switching between them meant
 * deleting the job description, pasting the next one, re-analysing, and — if the
 * résumé differed — re-uploading and re-ingesting it. The previous application's
 * work was not stored anywhere; it was overwritten.
 *
 * ## The one invariant
 *
 * **The live settings fields are the working copy of the active application.**
 *
 * Nothing else in the app knows applications exist. The prompt builder reads
 * `jobTitle`; the review panel reads `profileBundleJson`; ingest writes
 * `profileBundleJson`. All of that stays exactly as it was, and switching is
 * defined as: copy the live fields back into the slot they came from, then copy
 * the incoming slot's fields into the live fields.
 *
 * The alternative — teaching every read site to resolve "the active target" —
 * would have put a lookup on the session hot path and given every one of those
 * call sites a new way to be wrong. This way there is exactly one place that can
 * be wrong, and it is this file.
 *
 * The consequence to keep in mind: a slot's stored `fields` are stale while it
 * is the active one. `commitActive` is what makes them true again, and every
 * mutation here runs it first.
 */

/**
 * The fields an application owns.
 *
 * All strings, which is not a coincidence — it is why the whole feature fits in
 * a JSON blob in a flat settings document, like `profileBundleJson` next to it.
 *
 * `jobSpecJson` and `jobBriefJson` travel with the posting they were derived
 * from, and `profileBundleJson` with the résumé: a brief describes one story
 * bank against one posting, so a slot that carried the posting but not the bank
 * would restore an analysis about a résumé that is no longer loaded. That is
 * worse than no analysis, because it looks correct.
 */
export const TARGET_FIELDS = [
  'jobTitle',
  'jobDescription',
  'jobSpecJson',
  'jobBriefJson',
  'profileBundleJson',
  'resumeSummary'
] as const

export type TargetField = (typeof TARGET_FIELDS)[number]
export type TargetFields = Record<TargetField, string>

export interface Target {
  id: string
  /** What the radio button says. User-editable, never used as a key. */
  name: string
  fields: TargetFields
}

/** What the UI needs to draw the list, without carrying every résumé bundle into the renderer's state. */
export interface TargetSummary {
  id: string
  name: string
  jobTitle: string
  /** True when this slot has a posting saved, so the list can show which are set up. */
  hasJobDescription: boolean
  hasResume: boolean
}

export const UNTITLED_TARGET = 'Untitled application'

const MAX_NAME_CHARS = 80
/**
 * A ceiling, not a quota. Each slot can hold a résumé bundle and an analysis —
 * call it 40KB — and the settings file is read synchronously at startup, so an
 * unbounded list is a slow launch nobody asked for. Twenty is far past what
 * anyone interviews for at once.
 */
export const MAX_TARGETS = 20

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The live fields, as a slot's worth of data. */
export function fieldsOf(settings: Pick<HueSettings, TargetField>): TargetFields {
  const out = {} as TargetFields
  for (const field of TARGET_FIELDS) out[field] = settings[field]
  return out
}

function normaliseFields(raw: unknown): TargetFields {
  const source = (raw ?? {}) as Record<string, unknown>
  const out = {} as TargetFields
  for (const field of TARGET_FIELDS) out[field] = asString(source[field])
  return out
}

/**
 * Ids are generated here rather than by the caller so that `parseTargets` can
 * repair a hand-edited file that lost one. Settings are a user-editable
 * document; assuming an id exists is assuming nobody has opened it.
 */
function makeId(taken: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const id = `app-${n}`
    if (!taken.has(id)) {
      taken.add(id)
      return id
    }
  }
}

export function clampTargetName(raw: unknown): string {
  return asString(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
}

/**
 * Parses `targetsJson`, discarding anything unusable rather than throwing.
 *
 * Same contract as `parseProfileBundle`: this runs while the settings drawer is
 * rendering, and a malformed blob must degrade to "no applications yet" rather
 * than to a white screen.
 */
export function parseTargets(raw: string): Target[] {
  if (!raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const taken = new Set<string>()
  return parsed.slice(0, MAX_TARGETS).map((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>
    const rawId = asString(item.id).trim()
    const id = rawId && !taken.has(rawId) ? rawId : makeId(taken)
    taken.add(id)
    return {
      id,
      name: clampTargetName(item.name) || UNTITLED_TARGET,
      fields: normaliseFields(item.fields)
    }
  })
}

export function serialiseTargets(targets: Target[]): string {
  return JSON.stringify(targets)
}

export function summarise(
  targets: Target[],
  activeId: string,
  live: TargetFields
): TargetSummary[] {
  return targets.map((target) => {
    // The active slot is summarised from the live fields, not from its stored
    // copy — otherwise the list keeps showing the old job title until the next
    // switch, which reads as the app having ignored what was typed.
    const fields = target.id === activeId ? live : target.fields
    return {
      id: target.id,
      name: target.name,
      jobTitle: fields.jobTitle,
      hasJobDescription: fields.jobDescription.trim().length > 0,
      hasResume: fields.profileBundleJson.trim().length > 0
    }
  })
}

/** A settings patch. Every function below returns one; none of them writes anything. */
export type TargetPatch = Partial<HueSettings>

function patchFor(targets: Target[], activeId: string, fields: TargetFields): TargetPatch {
  return { targetsJson: serialiseTargets(targets), activeTargetId: activeId, ...fields }
}

/**
 * The stored list with the active slot's fields refreshed from the live ones.
 *
 * Every mutation starts here. Skipping it is how an edit made just before
 * pressing New or Delete disappears — the list still holds whatever the fields
 * were at the last switch.
 */
export function commitActive(targets: Target[], activeId: string, live: TargetFields): Target[] {
  return targets.map((target) => (target.id === activeId ? { ...target, fields: live } : target))
}

/**
 * Guarantees there is at least one application, adopting the current settings as
 * its contents.
 *
 * This is the upgrade path and it must be silent: an existing install has a
 * résumé and a posting and has never heard of applications, and the correct
 * outcome is one slot named after the job they were already preparing for, with
 * everything exactly where they left it. Returns null when nothing needs to
 * change, so a launch does not rewrite the settings file for no reason.
 */
export function ensureTargets(settings: HueSettings): TargetPatch | null {
  const targets = parseTargets(settings.targetsJson)
  const live = fieldsOf(settings)

  if (targets.length === 0) {
    const id = 'app-1'
    return patchFor(
      [{ id, name: clampTargetName(settings.jobTitle) || UNTITLED_TARGET, fields: live }],
      id,
      live
    )
  }
  // A pointer at a slot that is gone — a hand-edited file, or a delete that was
  // interrupted. Fall back to the first rather than to nothing: the live fields
  // are still real work, and they have to belong to something.
  if (!targets.some((t) => t.id === settings.activeTargetId)) {
    return patchFor(commitActive(targets, targets[0].id, live), targets[0].id, live)
  }
  return null
}

/**
 * Switch to another application.
 *
 * Null when `id` is unknown or already active — a no-op must not be written,
 * because writing it would commit the live fields and touch the file for
 * nothing.
 */
export function switchTarget(settings: HueSettings, id: string): TargetPatch | null {
  const targets = parseTargets(settings.targetsJson)
  const incoming = targets.find((t) => t.id === id)
  if (!incoming || id === settings.activeTargetId) return null
  const committed = commitActive(targets, settings.activeTargetId, fieldsOf(settings))
  // `incoming.fields` and not the committed copy: the incoming slot is by
  // definition not the active one, so its stored fields are the true ones.
  return patchFor(committed, id, incoming.fields)
}

const EMPTY_FIELDS: TargetFields = TARGET_FIELDS.reduce((acc, field) => {
  acc[field] = ''
  return acc
}, {} as TargetFields)

/**
 * A new, empty application, which becomes the active one.
 *
 * Empty and not a copy: "New" that silently duplicated the current posting would
 * leave the old job description in the box, and a posting that is 90% right is
 * the worst possible starting point — it is the one you do not re-read.
 * Duplicating is a separate button for the times that is what you meant.
 */
export function createTarget(settings: HueSettings, name: string): TargetPatch | null {
  const targets = parseTargets(settings.targetsJson)
  if (targets.length >= MAX_TARGETS) return null
  const committed = commitActive(targets, settings.activeTargetId, fieldsOf(settings))
  const taken = new Set(committed.map((t) => t.id))
  const id = makeId(taken)
  const created: Target = {
    id,
    name: clampTargetName(name) || UNTITLED_TARGET,
    fields: { ...EMPTY_FIELDS }
  }
  return patchFor([...committed, created], id, created.fields)
}

/**
 * Copy the active application, including its résumé bundle and analysis.
 *
 * The case this exists for: the same job title at a second company, where the
 * résumé and most of the prep carry over and only the posting changes. Copying
 * the bundle rather than re-ingesting saves a model call and a minute.
 */
export function duplicateTarget(settings: HueSettings, name: string): TargetPatch | null {
  const targets = parseTargets(settings.targetsJson)
  if (targets.length >= MAX_TARGETS) return null
  const live = fieldsOf(settings)
  const committed = commitActive(targets, settings.activeTargetId, live)
  const source = committed.find((t) => t.id === settings.activeTargetId)
  if (!source) return null
  const taken = new Set(committed.map((t) => t.id))
  const id = makeId(taken)
  const copy: Target = {
    id,
    name: clampTargetName(name) || `${source.name} copy`.slice(0, MAX_NAME_CHARS),
    fields: { ...source.fields }
  }
  return patchFor([...committed, copy], id, copy.fields)
}

export function renameTarget(settings: HueSettings, id: string, name: string): TargetPatch | null {
  const targets = parseTargets(settings.targetsJson)
  if (!targets.some((t) => t.id === id)) return null
  const clean = clampTargetName(name) || UNTITLED_TARGET
  const committed = commitActive(targets, settings.activeTargetId, fieldsOf(settings)).map((t) =>
    t.id === id ? { ...t, name: clean } : t
  )
  return patchFor(committed, settings.activeTargetId, fieldsOf(settings))
}

/**
 * Delete an application. Refuses the last one.
 *
 * There is no undo and the slot may hold the only copy of an ingested résumé, so
 * the caller must confirm. Refusing the last one is not squeamishness: "no
 * applications" is a state `ensureTargets` would immediately undo by adopting
 * whatever is live, so allowing it would delete a slot and then recreate it from
 * the very fields the delete was supposed to clear.
 */
export function deleteTarget(settings: HueSettings, id: string): TargetPatch | null {
  const targets = parseTargets(settings.targetsJson)
  if (targets.length <= 1 || !targets.some((t) => t.id === id)) return null

  const committed = commitActive(targets, settings.activeTargetId, fieldsOf(settings))
  const index = committed.findIndex((t) => t.id === id)
  const remaining = committed.filter((t) => t.id !== id)

  if (id !== settings.activeTargetId) {
    // Deleting an inactive slot leaves the live fields alone. Passing them back
    // unchanged keeps this one write rather than two.
    return patchFor(remaining, settings.activeTargetId, fieldsOf(settings))
  }
  // The active one went. Land on its neighbour — the one that took its place in
  // the list, or the new last one — so the selection moves the way a list
  // selection is expected to.
  const next = remaining[Math.min(index, remaining.length - 1)]
  return patchFor(remaining, next.id, next.fields)
}
