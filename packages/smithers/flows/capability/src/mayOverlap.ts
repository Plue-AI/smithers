/**
 * Provable disjointness of two patterns.
 *
 * @since 0.1.0
 */

import type { CapabilityPattern } from "./CapabilityPattern.ts"
import { actionSubsumes } from "./internal/actionSubsumes.ts"
import { metacharacters } from "./internal/metacharacters.ts"
import { isLiteralResource } from "./isLiteralResource.ts"

/** The leading run of a resource that the grammar matches literally. */
const literalPrefix = (resource: string): string => {
  let end = resource.length
  for (const metacharacter of metacharacters) {
    const index = resource.indexOf(metacharacter)
    if (index >= 0 && index < end) {
      end = index
    }
  }
  return resource.slice(0, end)
}

const resourcesMayOverlap = (left: string, right: string): boolean => {
  if (isLiteralResource(left) && isLiteralResource(right)) {
    return left === right
  }
  const leftPrefix = literalPrefix(left)
  const rightPrefix = literalPrefix(right)
  const shared = Math.min(leftPrefix.length, rightPrefix.length)
  return leftPrefix.slice(0, shared) === rightPrefix.slice(0, shared)
}

/**
 * Conservatively determines whether two patterns can select a common
 * capability. It returns `false` only when disjointness is PROVABLE: actions
 * that no capability satisfies at once, two literal resources that differ,
 * or literal prefixes that disagree over their shared span. Every
 * relationship the syntactic checks cannot settle, including any run of text
 * behind a `*` or a `?`, answers `true`.
 *
 * That asymmetry is the opposite of `subsumes` and is the point. A
 * caller asks `subsumes` before widening a grant, so an unprovable
 * answer must not grant; a caller asks this before dropping a restriction,
 * so an unprovable answer must keep the restriction alive. Reading "cannot
 * prove coverage" as "does not apply" is how a `deny` rule falls through to
 * a later `allow`.
 *
 * The question is symmetric: `mayOverlap(a, b)` equals `mayOverlap(b, a)`.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const mayOverlap = (left: CapabilityPattern, right: CapabilityPattern): boolean =>
  (actionSubsumes(left.action, right.action) || actionSubsumes(right.action, left.action)) &&
  resourcesMayOverlap(left.resource, right.resource)
