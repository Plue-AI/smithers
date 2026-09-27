/**
 * Scheduled trigger declarations.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Target from "./Target.ts"

/** Attrs for a package-level schedule trigger.
 *
 * @category targets
 * @since 0.1.0
 */
export const CronAttrs = Schema.Struct({
  schedule: Schema.NonEmptyString,
  refresh: Schema.optional(Schema.Array(Target.Target)),
  run: Schema.Array(Target.Target)
})

const cronDefinition = Target.make("Cron", {
  attrs: CronAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Cron")
})

/** A package-level inert schedule rendered by generated GitHub CI.
 *
 * @category targets
 * @since 0.1.0
 */
export const Cron = cronDefinition

/** Reads validated Cron attrs.
 *
 * @category targets
 * @since 0.1.0
 */
export const attrsOf = (target: Target.AnyTarget): (typeof CronAttrs)["Type"] => {
  const metadata = Target.metadata(target)
  if (metadata.target !== "Cron") throw new TypeError(`expected a Cron target, received ${metadata.target}`)
  return metadata.attrs as (typeof CronAttrs)["Type"]
}
