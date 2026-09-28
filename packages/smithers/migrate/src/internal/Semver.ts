/**
 * A semver comparator, written here rather than taken as a dependency.
 *
 * The detector needs one question answered: is this dependency's version
 * before Smithers 1.0? Answering it takes precedence ordering over release and
 * prerelease identifiers, which is forty lines. `@smthrs/migrate` runs inside a
 * project it is about to rewrite, so its dependency set stays inside the
 * workspace.
 *
 * @since 1.0.0-rc.0
 * @private
 */

/**
 * A parsed semantic version.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: ReadonlyArray<string>
}

const pattern = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

/**
 * Parses the first version in a dependency specifier, so `^0.35.0`,
 * `>=0.35.0 <1`, and `0.35.0` all parse. A specifier with no version at all
 * (`file:../smithers`, `workspace:*`, `latest`) returns `undefined`.
 * Core components outside the safe integer range also return `undefined`.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const parse = (specifier: string): Version | undefined => {
  const match = pattern.exec(specifier)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return undefined
  const prerelease = match[4] === undefined ? [] : match[4].split(".")
  return { major, minor, patch, prerelease }
}

const comparePrerelease = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): number => {
  // A version with a prerelease has lower precedence than one without.
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric && bNumeric) {
      // Numeric prerelease identifiers can exceed JavaScript's integer range.
      const aValue = BigInt(a)
      const bValue = BigInt(b)
      if (aValue !== bValue) return aValue < bValue ? -1 : 1
      continue
    }
    if (aNumeric) return -1
    if (bNumeric) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Orders two versions by semver precedence.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const compare = (left: Version, right: Version): number => {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

const oneZeroZero: Version = { major: 1, minor: 0, patch: 0, prerelease: ["0"] }

/**
 * Reports whether a dependency specifier resolves before `1.0.0-0`, the range
 * that separates a 0.x Smithers package from a 1.0 release candidate.
 *
 * `1.0.0-rc.0` is not before it: a numeric prerelease identifier has lower
 * precedence than an alphanumeric one, so `1.0.0-0 < 1.0.0-rc.0`. A specifier
 * that cannot be parsed is treated as before it for legacy compatibility,
 * including local links in a 0.x project. Callers deciding migration must
 * admit the specifier with `parse` first rather than treating this fallback
 * as evidence that an unsupported version is old.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const isBeforeOneZero = (specifier: string): boolean => {
  const version = parse(specifier)
  if (version === undefined) return true
  return compare(version, oneZeroZero) < 0
}
