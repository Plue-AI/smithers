/**
 * Typed capability construction for host decorators.
 *
 * @since 1.0.0-rc.0
 */

import * as Capability from "@smthrs/capability/Capability"
import { GrantStoreError } from "@smthrs/capability/Permission"
import { Effect } from "effect"

/**
 * Constructs decorator requests without leaking schema failures as defects.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeCapability = (action: Capability.Action, resource: string) =>
  Effect.try({
    try: () => Capability.make(action, resource),
    catch: () =>
      new GrantStoreError({
        code: "invalid_resolution",
        message:
          `capability requires a valid action and a resource within maximumCapabilityResourceLength (${Capability.maxResourceLength} UTF-16 code units)`
      })
  })
