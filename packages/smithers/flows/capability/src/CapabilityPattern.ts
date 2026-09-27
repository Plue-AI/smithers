/**
 * The wildcard pattern a grant or policy rule selects capabilities with.
 *
 * @since 0.1.0
 */

import { type Brand, Schema } from "effect"
import { PatternResource } from "./internal/PatternResource.ts"
import { PatternAction } from "./PatternAction.ts"

/**
 * An action and resource glob used to grant or deny a family of capabilities.
 * The matcher compares the pattern against the whole resource byte-exactly
 * over UTF-16 code units. It performs no path normalization and no case
 * folding, so `\` is an ordinary character that never matches `/`, and `A:/x`
 * never matches `a:/X`.
 *
 * `*` matches any run of UTF-16 code units, including path separators and
 * newlines. `?` matches exactly one UTF-16 code unit, so an astral character
 * such as an emoji requires two `?` characters. A trailing ` *` also matches
 * the bare resource without trailing argument text. This rule makes a
 * `proc:spawn` command grant such as `npm *` grant bare `npm`.
 *
 * Apart from an identical resource, `subsumes` can prove only the `**`
 * wildcard form. A grant written `/workspace/*` can match `/workspace/src/a.ts`
 * but cannot be proven to cover it; only the identical `/workspace/*` pattern
 * is provable. Use `**` when an envelope must prove coverage of other
 * resources. The grammar has no escape. Callers whose
 * resources can contain `*` or `?`, including URLs with query strings and
 * command lines, must not build patterns by string concatenation. Use
 * `patternFromCapability` to derive exact grants safely.
 *
 * Matching costs O(pattern length times resource length) in the worst case.
 * Both resources are limited to `maxResourceLength`, and
 * `maxMatchWork` remains a fail-closed guard for unchecked structural
 * inputs at the host boundary.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export class CapabilityPattern extends Schema.Class<
  CapabilityPattern,
  Brand.Brand<"@smthrs/capability/CapabilityPattern">
>("@smthrs/capability/CapabilityPattern")({
  action: PatternAction,
  resource: PatternResource
}) {}
