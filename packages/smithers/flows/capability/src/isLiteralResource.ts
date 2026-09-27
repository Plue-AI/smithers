/**
 * The grammar's own answer to whether a resource is literal text.
 *
 * @since 0.1.0
 */

import { metacharacters } from "./internal/metacharacters.ts"

/**
 * Reports whether the glob grammar reads a resource as literal text, so it
 * selects that resource and nothing else.
 *
 * This predicate is the grammar's own answer to "does this string carry a
 * metacharacter". Callers deciding whether a resource names one capability
 * or a set must ask here rather than scan for `*` and `?` themselves, so a
 * later metacharacter cannot leave a caller reading a glob as a literal.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const isLiteralResource = (resource: string): boolean =>
  !metacharacters.some((metacharacter) => resource.includes(metacharacter))
