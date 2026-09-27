/**
 * The glob matcher that decides whether a pattern selects a capability.
 *
 * @since 0.1.0
 */

import type { CapabilityPattern } from "./CapabilityPattern.ts"
import type { Capability } from "./ExactCapability.ts"
import { matchesAction } from "./internal/matchesAction.ts"
import { maxMatchWork } from "./maxMatchWork.ts"

/**
 * Iterative glob matcher over UTF-16 code units: `*` matches any run of
 * units (path separators and newlines included), `?` matches exactly one
 * unit, and everything else is literal.
 *
 * Grant patterns are attacker-influenced input on the authorization path, so
 * the matcher must not be built on RegExp backtracking: a pattern such as
 * `a*a*a*a*b` against a long non-matching resource made the old
 * `.*`-compiled RegExp exponential. This two-pointer form remembers only the
 * most recent `*` and re-anchors it one unit at a time, which bounds the
 * whole match at O(pattern × resource) with constant memory — the standard
 * linear-scan wildcard algorithm.
 */
const matchGlob = (pattern: string, resource: string): boolean => {
  let patternIndex = 0
  let resourceIndex = 0
  let starIndex = -1
  let starResourceIndex = 0
  while (resourceIndex < resource.length) {
    const unit = pattern[patternIndex]
    if (unit === "*") {
      starIndex = patternIndex
      starResourceIndex = resourceIndex
      patternIndex += 1
    } else if (unit !== undefined && (unit === "?" || unit === resource[resourceIndex])) {
      patternIndex += 1
      resourceIndex += 1
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      starResourceIndex += 1
      resourceIndex = starResourceIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === "*") {
    patternIndex += 1
  }
  return patternIndex === pattern.length
}

const matchesResource = (pattern: string, resource: string): boolean => {
  if (pattern.length * resource.length > maxMatchWork) {
    // A grant must never widen, so matches remains a total boolean and returns
    // false. Permission.evaluate fails closed by treating an undecidable rule
    // as a veto instead of skipping a deny that might otherwise fall through.
    return false
  }
  // A pattern ending in ` *` (`proc:spawn` command grants such as `npm *`)
  // additionally matches the bare resource without its trailing argument
  // text, exactly as the old `( .*)?` compilation did.
  if (pattern.endsWith(" *") && matchGlob(pattern.slice(0, -2), resource)) {
    return true
  }
  return matchGlob(pattern, resource)
}

/**
 * Tests whether an exact capability is selected by a pattern.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const matches = (pattern: CapabilityPattern, capability: Capability): boolean =>
  matchesAction(pattern.action, capability.action) && matchesResource(pattern.resource, capability.resource)
