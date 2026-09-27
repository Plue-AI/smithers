/**
 * Cross-repository target declarations for opaque local Smithers workspaces.
 *
 * The declaration records a child repository and an absolute child label.
 * The build-system loader resolves its kinds and refusal state by querying the
 * child CLI; execution remains a child CLI process rather than merging graphs.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as LocalRepository from "./LocalRepository.ts"
import * as TargetDeclaration from "./Target.ts"

/**
 * Attrs carried by {@link Target}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TargetAttrs = Schema.Struct({
  repo: Schema.Union([LocalRepository.Declaration, Schema.NonEmptyString]),
  label: Schema.NonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
  data: Schema.optional(Attr.Data),
  gates: Schema.optional(Attr.Gates),
  sandbox: Schema.optional(Attr.Sandbox)
})

/**
 * Validated attrs carried by a repository target.
 *
 * @category models
 * @since 0.1.0
 */
export type TargetAttrs = typeof TargetAttrs.Type

const definition = TargetDeclaration.make("Repo.Target", {
  attrs: TargetAttrs,
  kinds: [],
  implementation: () => TargetDeclaration.notImplemented("Repo.Target")
})

/** Validates the absolute exact child-label spelling accepted by this rule. */
const childLabel = (value: string): string => {
  if (!value.startsWith("//")) {
    throw new Error(`Repo.Target label must start with //; relative :name labels are not allowed: ${value}`)
  }
  const body = value.slice(2)
  const separator = body.indexOf(":")
  if (separator < 0 || body.indexOf(":", separator + 1) >= 0 || body.slice(separator + 1) === "") {
    throw new Error(`Repo.Target label must be an exact //package:name label: ${value}`)
  }
  const packagePath = body.slice(0, separator)
  if (
    packagePath !== "" &&
    packagePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Repo.Target label contains an invalid child package path: ${value}`)
  }
  return value
}

/**
 * Declares an edge to one target in an opaque local repository.
 *
 * The child graph is queried and executed by the same build CLI from the
 * child repository directory. `args` are appended after the child label.
 *
 * @category targets
 * @since 0.1.0
 */
export const Target = (
  repo: LocalRepository.Declaration | string,
  label: string,
  options: {
    readonly args?: ReadonlyArray<string> | undefined
    readonly data?: TargetAttrs["data"] | undefined
    readonly gates?: TargetAttrs["gates"] | undefined
    readonly sandbox?: TargetAttrs["sandbox"] | undefined
  } = {}
): TargetDeclaration.AnyTarget =>
  definition({
    repo,
    label: childLabel(label),
    ...(options.args === undefined ? {} : { args: [...options.args] }),
    ...(options.data === undefined ? {} : { data: options.data }),
    ...(options.gates === undefined ? {} : { gates: options.gates }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox })
  })

/**
 * Reads the validated attrs of one repository target.
 *
 * @category accessors
 * @since 0.1.0
 */
export const attrsOf = (target: TargetDeclaration.AnyTarget): TargetAttrs => {
  const metadata = TargetDeclaration.metadata(target)
  if (metadata.target !== "Repo.Target") throw new TypeError("target is not a Repo.Target")
  return metadata.attrs as TargetAttrs
}
