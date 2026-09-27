/**
 * Foundry workspace toolchain and forge target declarations.
 *
 * `Foundry.Toolchain` is the workspace layer that binds the repo's
 * foundry.toml to its mise version authority; `Foundry.Build`,
 * `Foundry.Test`, and `Foundry.Fmt` are the forge compile, test, and
 * format rules keyed on that toolchain, the resolved forge identity, and
 * the declared config. Fmt is a check/write rule confined to its declared
 * `changes` write set.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Mise from "./Mise.ts"
import * as Reference from "./Reference.ts"
import * as Shell from "./Shell.ts"
import * as Target from "./Target.ts"

/**
 * Workspace layer binding a foundry config to an optional version authority.
 *
 * @category declarations
 * @since 0.1.0
 */
export const ToolchainDeclaration = Schema.TaggedStruct("FoundryToolchain", {
  config: Input.File,
  versions: Schema.optional(Mise.Declaration)
})

/**
 * Workspace layer binding a foundry config to an optional version authority.
 *
 * @category declarations
 * @since 0.1.0
 */
export type ToolchainDeclaration = typeof ToolchainDeclaration.Type

/**
 * Checks whether a value is a Foundry toolchain declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isToolchainDeclaration: (value: unknown) => value is ToolchainDeclaration = Schema.is(
  ToolchainDeclaration
)

/**
 * Declares the workspace's Foundry configuration and version authority.
 *
 * @category declarations
 * @since 0.1.0
 */
export const Toolchain = (options: {
  readonly config: Input.File
  readonly versions?: Mise.Declaration | undefined
}): ToolchainDeclaration => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Foundry.Toolchain options must be an object")
  }
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "config" && key !== "versions") {
      throw new TypeError(`Foundry.Toolchain received unknown option ${JSON.stringify(key)}`)
    }
  }
  if (options.config?._tag !== "File") throw new TypeError("Foundry.Toolchain config must be an S.file declaration")
  if (options.versions !== undefined && !Mise.isDeclaration(options.versions)) {
    throw new TypeError("Foundry.Toolchain versions must be an S.Mise declaration")
  }
  return Object.freeze(ToolchainDeclaration.make({
    config: options.config,
    ...(options.versions === undefined ? {} : { versions: options.versions })
  }))
}

const shared = {
  config: Schema.optional(Input.File),
  profile: Schema.optional(Schema.NonEmptyString),
  data: Schema.optional(Attr.Data),
  sandbox: Schema.optional(Attr.Sandbox)
} as const

/**
 * Attrs for `S.Foundry.Build`.
 *
 * @category attrs
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  ...shared,
  skip: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  outDirs: Schema.Array(Schema.NonEmptyString)
})

/**
 * Attrs for `S.Foundry.Test`.
 *
 * @category attrs
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({
  ...shared,
  ffi: Schema.optional(Schema.Array(Target.Target)),
  gates: Schema.optional(Attr.Gates),
  services: Schema.optional(Attr.Services)
})

/**
 * Attrs for `S.Foundry.Fmt`.
 *
 * @category attrs
 * @since 0.1.0
 */
export const FmtAttrs = Schema.Struct({
  config: Schema.optional(Input.File),
  data: Schema.optional(Attr.Data),
  changes: Schema.Array(Schema.NonEmptyString),
  sandbox: Schema.optional(Attr.Sandbox)
})

const forge = Reference.hostBin("forge")

const buildDefinition = Target.make("Foundry.Build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  cache: true,
  outputs: (attrs) => ({ cwd: ".", paths: attrs.outDirs }),
  implementation: (attrs) => Exec.runTool(Shell.execPayload({ bin: forge, args: ["build", ...(attrs.skip ?? [])] }))
})

const testDefinition = Target.make("Foundry.Test", {
  attrs: TestAttrs,
  kinds: ["test"],
  cache: true,
  implementation: () => Exec.runTool(Shell.execPayload({ bin: forge, args: ["test"] }))
})

const fmtDefinition = Target.make("Foundry.Fmt", {
  attrs: FmtAttrs,
  kinds: ["lint", "run"],
  cache: (attrs) => attrs.changes.length > 0,
  implementation: () => Exec.runTool(Shell.execPayload({ bin: forge, args: ["fmt", "--check"] }))
})

/**
 * Compiles Solidity sources with forge and captures the declared output directories.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = buildDefinition

/**
 * Runs forge tests under the declared profile and service/data edges.
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = testDefinition

/**
 * Checks or writes forge formatting inside the declared write set.
 *
 * @category targets
 * @since 0.1.0
 */
export const Fmt = fmtDefinition
