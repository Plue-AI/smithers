/**
 * npm-facing PACKAGE.ts targets.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/** Attrs for an npm pack artifact.
 *
 * @category targets
 * @since 0.1.0
 */
export const PackAttrs = Schema.Struct({
  manifest: Input.File,
  data: Schema.optional(Attr.Data)
})

const packDefinition = Target.make("Npm.Pack", {
  attrs: PackAttrs,
  kinds: ["build"],
  cache: true,
  implementation: () => Target.notImplemented("Npm.Pack")
})

/** Builds the registry tarball named by a package manifest.
 *
 * @category targets
 * @since 0.1.0
 */
export const Pack = packDefinition

/** Attrs for an outward npm publish.
 *
 * @category targets
 * @since 0.1.0
 */
export const PublishAttrs = Schema.Struct({
  pack: Target.Target,
  gates: Attr.Gates,
  distTag: Schema.optional(Schema.NonEmptyString),
  provenance: Schema.optional(Schema.Boolean),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval)
})

const publishDefinition = Target.make("Npm.Publish", {
  attrs: PublishAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Npm.Publish")
})

/** Publishes a declared pack after fresh gates.
 *
 * @category targets
 * @since 0.1.0
 */
export const Publish = publishDefinition

/** Attrs for fetching the currently published package.
 *
 * @category targets
 * @since 0.1.0
 */
export const PublishedAttrs = Schema.Struct({ manifest: Input.File })

const publishedDefinition = Target.make("Npm.Published", {
  attrs: PublishedAttrs,
  kinds: ["build"],
  cache: true,
  implementation: () => Target.notImplemented("Npm.Published")
})

/** Fetches the declaration surface of the last registry version.
 *
 * @category targets
 * @since 0.1.0
 */
export const Published = publishedDefinition

/** Attrs for checking a downstream repository.
 *
 * @category targets
 * @since 0.1.0
 */
export const DownstreamAttrs = Schema.Struct({
  repository: Schema.NonEmptyString,
  overrides: Schema.Record(Schema.String, Target.Target),
  run: Schema.Array(Schema.NonEmptyString),
  sandbox: Schema.optional(Attr.Sandbox)
})

const downstreamDefinition = Target.make("Npm.Downstream", {
  attrs: DownstreamAttrs,
  kinds: ["test"],
  cache: true,
  implementation: () => Target.notImplemented("Npm.Downstream")
})

/** Checks a remote consumer against local package outputs.
 *
 * @category targets
 * @since 0.1.0
 */
export const Downstream = downstreamDefinition
