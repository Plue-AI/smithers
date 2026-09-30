/** Declared capability ceilings shared by planning and execution.
 * @since 1.0.0
 */

import * as Capability from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import { Capabilities } from "./Annotations.ts"

/** Returns only explicitly declared ceilings; omission inherits.
 * @category accessors
 * @since 1.0.0
 */
export const capabilityCeilings = (annotations: Context.Context<never>): ReadonlyArray<ReadonlyArray<string>> =>
  annotations.mapUnsafe.has(Capabilities.key) ? [Context.get(annotations, Capabilities)] : []

/** Parses declaration patterns into ceiling groups. Invalid patterns are dropped, so they deny.
 * @category constructors
 * @since 1.0.0
 */
export const parseCapabilityCeilings = (
  groups: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<ReadonlyArray<Capability.CapabilityPattern>> =>
  groups.map((group) =>
    group.flatMap((text) => {
      const parsed = Capability.parsePattern(text)
      return Option.isSome(parsed) ? [parsed.value] : []
    })
  )

/** Applies declaration patterns as an exact conjunction. Invalid patterns deny.
 * @category combinators
 * @since 1.0.0
 */
export const attenuateCapabilities = (groups: ReadonlyArray<ReadonlyArray<string>>) =>
  CapabilitySet.attenuateGroups(parseCapabilityCeilings(groups))
