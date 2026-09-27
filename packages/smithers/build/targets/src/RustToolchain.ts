/**
 * Declared Rust toolchain for PACKAGE.ts targets.
 *
 * A Rust toolchain declaration names how a workspace obtains `rustc` and
 * `cargo`, and where the pin that fixes their version lives. It is inert data:
 * the constructors validate and perform no I/O, so PACKAGE.ts evaluation stays
 * pure.
 *
 * The declaration exists for the same reason {@link Runtime} does. Before it,
 * the only way to say "CI installs the pinned Rust toolchain and then runs
 * clippy" was a pair of shell strings in a PACKAGE.ts file, which put an argv
 * outside every target implementation and left the toolchain undeclared key
 * material. A declaration makes the pin a content-digested input:
 * {@link CargoCheck} takes it as an attr and asks this module for the argv, and
 * the CI generator derives its bootstrap step from the same value.
 *
 * The declaration is a discriminated union, one variant per way of obtaining a
 * toolchain, discriminated by `name`. Only `pinned` exists today: `rustup`
 * reads `rust-toolchain.toml` and installs exactly what it pins, components and
 * targets included, so the pin cannot drift from what runs. A workspace that
 * needs a channel it does not pin adds a variant here, which is the point — the
 * set of toolchains a PACKAGE.ts file may declare is reviewed, not free text.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"

/**
 * Schema for the supported ways of obtaining a Rust toolchain.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Name = Schema.Literals(["pinned"])

/**
 * The supported ways of obtaining a Rust toolchain.
 *
 * @category models
 * @since 0.1.0
 */
export type Name = typeof Name.Type

/**
 * Maximum length of a declared executable or text channel.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumTextLength = 256

/**
 * Schema for a toolchain obtained from a checked-in `rustup` pin.
 *
 * `pin` is the workspace-relative file `rustup` reads. Its content digest is
 * key material, so changing its channel cannot reuse Cargo results produced by
 * a different compiler.
 *
 * Durable key change: the pin content digest now participates in every
 * `S.Cargo.*` target key. Existing keys intentionally move because their cached
 * compiler identity was incomplete. Operators should expect one full Cargo
 * rebuild on the first build after this lands, then normal cache reuse until
 * the pin contents change.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PinnedRustToolchain = Schema.Struct({
  name: Schema.Literal("pinned"),
  pin: Input.File,
  rustup: Schema.NonEmptyString,
  cargo: Schema.NonEmptyString
})

/**
 * One toolchain obtained from a checked-in `rustup` pin.
 *
 * @category models
 * @since 0.1.0
 */
export type PinnedRustToolchain = typeof PinnedRustToolchain.Type

/**
 * Schema for one declared Rust toolchain.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RustToolchain = Schema.Union([PinnedRustToolchain])

/**
 * One declared Rust toolchain.
 *
 * @category models
 * @since 0.1.0
 */
export type RustToolchain = typeof RustToolchain.Type

/**
 * Options accepted by {@link Pinned}.
 *
 * @category models
 * @since 0.1.0
 */
export interface PinnedOptions {
  /** @default Input.file("//rust-toolchain.toml") */
  readonly pin?: Input.File | undefined
  /** @default "rustup" */
  readonly rustup?: string | undefined
  /** @default "cargo" */
  readonly cargo?: string | undefined
}

const controlCharacter = /[\u0000-\u001f\u007f]/

/**
 * Validates one declared text field.
 *
 * Bounded, well-formed, and control-free are the same three conditions every
 * other declaration in this package applies, and for the same reason: a control
 * character in an executable name would reach a child-process argv.
 */
const usable = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`)
  if (
    value.length > maximumTextLength ||
    !value.isWellFormed() ||
    controlCharacter.test(value)
  ) throw new Error(`${what} must be bounded well-formed text without control characters`)
  const trimmed = value.trim()
  if (trimmed === "") throw new Error(`${what} must not be empty`)
  return trimmed
}

const declaredFile = (value: unknown, what: string): Input.File => {
  if (
    typeof value !== "object" || value === null ||
    (value as { readonly _tag?: unknown })._tag !== "File" ||
    typeof (value as { readonly path?: unknown }).path !== "string"
  ) throw new TypeError(`${what} must be an S.file declaration`)
  return value as Input.File
}

/**
 * Declares the toolchain a checked-in `rustup` pin fixes.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const rust = Smithers.Rust.Pinned({})
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Pinned = (options: PinnedOptions = {}): PinnedRustToolchain =>
  PinnedRustToolchain.make({
    name: "pinned",
    // Cargo targets may live below the workspace root. Anchoring keeps the
    // imported declaration from digesting a package-local file instead.
    pin: options.pin === undefined
      ? Input.file("//rust-toolchain.toml")
      : declaredFile(options.pin, "rust toolchain pin"),
    rustup: options.rustup === undefined ? "rustup" : usable(options.rustup, "rustup executable"),
    cargo: options.cargo === undefined ? "cargo" : usable(options.cargo, "cargo executable")
  })

/**
 * Builds the argv that installs the declared toolchain.
 *
 * A bare `rustup toolchain install` reads the pin, so the components and
 * targets the pin names are installed with it and nothing restates them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const install = (toolchain: RustToolchain): Array<string> => [toolchain.rustup, "toolchain", "install"]

/**
 * Builds the argv that runs one cargo subcommand under the declared toolchain.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cargo = (toolchain: RustToolchain, args: ReadonlyArray<string>): Array<string> => [
  toolchain.cargo,
  ...args
]

/**
 * Schema for the workspace Rust toolchain layer, `S.Rust.Toolchain`.
 *
 * The layer is what a Cargo workspace declares instead of a JavaScript
 * runtime and package manager: it names the cargo and rustup executables
 * every `S.Cargo.*` target resolves against, and the pin that fixes their
 * version. Two forms exist because two design partners pin differently. A
 * repository with a checked-in `rust-toolchain.toml` names that file
 * (`toolchain`) and, when it commits one, its lockfile; a repository whose CI
 * pins the channel by hand names the channel as declared text (`channel`)
 * beside the workspace manifest the pin applies to. Exactly one of the two is
 * present, so a declaration can never say two different things about which
 * compiler runs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ToolchainDeclaration = Schema.TaggedStruct("RustToolchain", {
  workspace: Schema.optional(Input.File),
  channel: Schema.optional(Schema.NonEmptyString),
  toolchain: Schema.optional(Input.File),
  lockfile: Schema.optional(Input.File),
  versions: Schema.optional(
    Schema.declare<{ readonly _tag: string }>((value): value is { readonly _tag: string } =>
      typeof value === "object" && value !== null && typeof (value as { readonly _tag?: unknown })._tag === "string"
    )
  ),
  rustup: Schema.NonEmptyString,
  cargo: Schema.NonEmptyString
})

/**
 * One declared workspace Rust toolchain layer.
 *
 * @category models
 * @since 0.1.0
 */
export type ToolchainDeclaration = typeof ToolchainDeclaration.Type

/**
 * Options accepted by {@link Toolchain}.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolchainOptions {
  /** The Cargo workspace manifest the pin applies to. */
  readonly workspace?: Input.File | undefined
  /** The channel this workspace pins as declared text, for example `"1.91"`. */
  readonly channel?: string | undefined
  /** The checked-in `rustup` pin file. */
  readonly toolchain?: Input.File | undefined
  /** The committed lockfile, when the repository commits one. */
  readonly lockfile?: Input.File | undefined
  /** An enclosing Mise/Nix version authority. */
  readonly versions?: { readonly _tag: string } | undefined
  /** @default "rustup" */
  readonly rustup?: string | undefined
  /** @default "cargo" */
  readonly cargo?: string | undefined
}

const toolchainOptionNames: ReadonlySet<string> = new Set([
  "workspace",
  "channel",
  "toolchain",
  "lockfile",
  "versions",
  "rustup",
  "cargo"
])

/**
 * Declares the workspace Rust toolchain layer.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const rust = S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.91" })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Toolchain = (options: ToolchainOptions = {}): ToolchainDeclaration => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Rust.Toolchain options must be an object")
  }
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!toolchainOptionNames.has(key)) {
      throw new TypeError(`Rust.Toolchain received unknown option ${JSON.stringify(key)}`)
    }
  }
  const named = [
    options.channel === undefined ? undefined : "channel",
    options.toolchain === undefined
      ? undefined
      : "toolchain"
  ].filter((entry) => entry !== undefined)
  if (named.length !== 1) {
    throw new Error(
      `Rust.Toolchain requires exactly one of channel, toolchain; received ${
        named.length === 0 ? "none" : named.join(", ")
      }`
    )
  }
  return Object.freeze(ToolchainDeclaration.make({
    ...(options.workspace === undefined
      ? {}
      : { workspace: declaredFile(options.workspace, "Rust.Toolchain workspace") }),
    ...(options.channel === undefined ? {} : { channel: usable(options.channel, "rust toolchain channel") }),
    ...(options.toolchain === undefined
      ? {}
      : { toolchain: declaredFile(options.toolchain, "Rust.Toolchain toolchain") }),
    ...(options.lockfile === undefined ? {} : { lockfile: declaredFile(options.lockfile, "Rust.Toolchain lockfile") }),
    ...(options.versions === undefined ? {} : { versions: options.versions }),
    rustup: options.rustup === undefined ? "rustup" : usable(options.rustup, "rustup executable"),
    cargo: options.cargo === undefined ? "cargo" : usable(options.cargo, "cargo executable")
  }))
}

/**
 * Checks whether a value is a workspace Rust toolchain layer declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isToolchainDeclaration: (value: unknown) => value is ToolchainDeclaration = Schema.is(
  ToolchainDeclaration
)

/**
 * Builds the argv that installs the declared toolchain layer.
 *
 * The channel form names the channel, so a host without it installs exactly
 * what the workspace pinned. The pin-file form installs bare: `rustup` reads
 * the file and brings the components and targets it names with it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const toolchainInstall = (declaration: ToolchainDeclaration): ReadonlyArray<string> =>
  declaration.channel === undefined
    ? [declaration.rustup, "toolchain", "install"]
    : [declaration.rustup, "toolchain", "install", declaration.channel]

/**
 * The declared files a toolchain layer contributes as key material.
 *
 * @category accessors
 * @since 0.1.0
 */
export const toolchainInputs = (declaration: ToolchainDeclaration): ReadonlyArray<Input.File> =>
  [
    declaration.workspace,
    declaration.toolchain,
    declaration.lockfile,
    ...(declaration.versions === undefined
      ? []
      : [
        (declaration.versions as { readonly config?: Input.File }).config,
        (declaration.versions as { readonly flake?: Input.File }).flake,
        (declaration.versions as { readonly lock?: Input.File }).lock
      ])
  ].filter((entry) => entry !== undefined)

/**
 * The key-material identity of one toolchain layer: what fixes the compiler,
 * without the executable paths the planner resolves separately.
 *
 * @category accessors
 * @since 0.1.0
 */
export const toolchainIdentity = (declaration: ToolchainDeclaration): unknown => ({
  tag: "RustToolchain",
  channel: declaration.channel ?? null,
  toolchain: declaration.toolchain?.path ?? null,
  lockfile: declaration.lockfile?.path ?? null,
  workspace: declaration.workspace?.path ?? null,
  versions: declaration.versions ?? null,
  cargo: declaration.cargo,
  rustup: declaration.rustup
})
