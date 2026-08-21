/**
 * The release name a person reads, derived from the semver a machine needs.
 *
 * Hue numbers releases the way Dota 2 numbers patches — see `docs/Versioning.md`
 * — but `package.json`, `electron-builder` and `electron-updater` all require a
 * three-integer semver, and none of them can compare `"1.5b"`. So the letter
 * lives in the patch field and is rendered back out here:
 *
 * ```
 * 1.5.0  →  1.5
 * 1.5.1  →  1.5b
 * 1.5.2  →  1.5c
 * 1.6.0  →  1.6
 * ```
 *
 * The mapping preserves ordering exactly, which is the whole reason it is a
 * mapping rather than a separate field: `1.5.0 < 1.5.1 < 1.6.0` in semver is
 * `1.5 < 1.5b < 1.6` in Hue, so the update feed sorts releases correctly
 * without knowing this scheme exists.
 *
 * **Display only.** Installer filenames and `latest.yml` stay semver — an
 * artifact called `Hue-1.5b-setup.exe` is one `electron-updater` cannot parse.
 */

/** Patch 0 carries no letter: the base release *is* `a`, so letters start at `b`. */
const FIRST_LETTER = 'b'.charCodeAt(0)
/** `b`…`z` is 25 follow-ups. Past that the letter form stops being readable. */
const MAX_LETTERED_PATCH = 25

/**
 * Anything that is not exactly `major.minor.patch` is returned untouched.
 *
 * Prereleases (`1.6.0-beta.2`) and build metadata are deliberately not
 * translated: a lettered name promises "this is the release after 1.6", and a
 * prerelease has not made that promise yet. Showing it verbatim is the honest
 * answer, and it is also what makes a malformed value visible rather than
 * silently rewritten into something that looks fine.
 */
export function displayVersion(semver: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(semver.trim())
  if (!match) return semver

  const [, major, minor, rawPatch] = match
  const patch = Number(rawPatch)

  if (patch === 0) return `${major}.${minor}`
  // A 26th follow-up to one patch is a different problem than naming can solve;
  // fall back to the raw number rather than inventing `aa`.
  if (patch > MAX_LETTERED_PATCH) return semver

  return `${major}.${minor}${String.fromCharCode(FIRST_LETTER + patch - 1)}`
}
