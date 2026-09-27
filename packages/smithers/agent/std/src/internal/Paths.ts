/**
 * Path containment checks against a declared effect envelope.
 *
 * @since 1.0.0
 */

import * as Effects from "@smthrs/core/Effects"

const normalize = (path: string): string => {
  const collapsed = path.replace(/\/+/g, "/")
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed
}

const hasDotSegment = (path: string): boolean => path.split("/").some((segment) => segment === "." || segment === "..")

/**
 * Whether a path is covered by any entry of a declared read or write set.
 *
 * An entry covers itself, everything beneath it when it names a directory,
 * and everything matched by the prefix-glob subset `/core` supports.
 *
 * @category predicates
 * @since 1.0.0
 */
export const withinEnvelope = (declared: ReadonlyArray<string>, path: string): boolean => {
  const candidate = normalize(path)
  if (candidate === "" || hasDotSegment(candidate)) return false
  return declared.some((entry) => {
    const normalized = normalize(entry)
    if (normalized === "") return false
    const envelope = normalized === "/" ? "/**" : normalized
    return Effects.covers(envelope, candidate) || candidate.startsWith(`${normalized}/`)
  })
}

/**
 * A path without its trailing slashes, so a root compares and joins as one name.
 *
 * @category conversions
 * @since 1.0.0
 */
export const withoutTrailingSlash = (path: string): string => path.replace(/\/+$/, "")
