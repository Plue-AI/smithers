/**
 * Changesets PACKAGE.ts targets.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/** Attrs for changesets version calculation.
 *
 * @category targets
 * @since 0.1.0
 */
export const VersionAttrs = Schema.Struct({
  config: Input.File,
  data: Schema.optional(Attr.Data),
  changes: Schema.Array(Schema.NonEmptyString)
})

const versionDefinition = Target.make("Changesets.Version", {
  attrs: VersionAttrs,
  kinds: ["run", "lint"],
  cache: (attrs) => attrs.changes.length > 0,
  implementation: () => Target.notImplemented("Changesets.Version")
})

/** Applies or drift-checks pending changesets.
 *
 * @category targets
 * @since 0.1.0
 */
export const Version = versionDefinition

/** Attrs for an outward changesets publish.
 *
 * @category targets
 * @since 0.1.0
 */
export const PublishAttrs = Schema.Struct({
  config: Input.File,
  pack: Target.Target,
  gates: Attr.Gates,
  provenance: Schema.optional(Schema.Boolean),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval)
})

const publishDefinition = Target.make("Changesets.Publish", {
  attrs: PublishAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Changesets.Publish")
})

/** Publishes a changesets release train after fresh gates.
 *
 * @category targets
 * @since 0.1.0
 */
export const Publish = publishDefinition
