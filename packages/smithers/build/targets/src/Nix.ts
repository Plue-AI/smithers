/**
 * Nix environment declarations and tool references.
 *
 * A workspace declares the Nix closure its tools come from once, the way it
 * declares a runtime version or an installed `node_modules` tree, and every
 * tool-running target resolves executables from that closure. The
 * declaration is inert data: constructing it performs no I/O, so PACKAGE.ts
 * and WORKSPACE.ts evaluation stay pure. Resolving it to a store path, its
 * `PATH`, and its transitive closure is the planner's job, in
 * `@smthrs/build-cli`.
 *
 * Two forms exist. A flake form names `flake.nix` and its lock and, when the
 * shell is not the default, the dev shell attribute. A file form names a
 * plain Nix expression, such as `.smithers/environment.nix`, that evaluates
 * to one derivation. Both carry their files as declared inputs, so an edit to
 * the flake, its lock, or the expression re-keys every target that runs
 * under the environment.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Toolchain from "./Toolchain.ts"

/**
 * A dev shell whose flake and lock are the version authority for one or more
 * `S.Nix.bin` references.
 *
 * `DevShell` predates {@link Environment} and stays as the narrow form a
 * `toolchains` list carries when a workspace pins only a few tools. A
 * workspace that wants every tool from the closure declares an
 * {@link Environment} instead.
 *
 * @category declarations
 * @since 0.1.0
 */
export interface DevShellDeclaration extends Toolchain.Declaration<"NixDevShell"> {
  readonly flake: Input.File
  readonly lock: Input.File
}

/**
 * Declares a Nix dev shell as a version authority for `S.Nix.bin` references.
 *
 * @category declarations
 * @since 0.1.0
 */
export const DevShell = (options: { readonly flake: Input.File; readonly lock: Input.File }): DevShellDeclaration => {
  if (typeof options !== "object" || options === null) throw new TypeError("Nix.DevShell options must be an object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "flake" && key !== "lock") {
      throw new TypeError(`Nix.DevShell received unknown option ${JSON.stringify(key)}`)
    }
  }
  if (options.flake?._tag !== "File" || options.lock?._tag !== "File") {
    throw new TypeError("Nix.DevShell flake and lock must be S.file declarations")
  }
  return Toolchain.declare({ _tag: "NixDevShell", flake: options.flake, lock: options.lock })
}

/**
 * Maximum length of a declared dev shell attribute.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumAttrLength = 256

/**
 * A dev shell attribute: a bare shell name such as `ci`, or a full flake
 * output path such as `devShells.x86_64-linux.ci`.
 *
 * @category constants
 * @since 0.1.0
 */
export const attrShape = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/

/**
 * Schema for the workspace Nix environment declaration.
 *
 * Exactly one of `flake` and `file` is set. `lock` and `attr` accompany a
 * flake only.
 *
 * @category schemas
 * @since 0.1.0
 */
export const EnvironmentDeclaration = Schema.TaggedStruct("NixEnvironment", {
  flake: Schema.optional(Input.File),
  lock: Schema.optional(Input.File),
  file: Schema.optional(Input.File),
  attr: Schema.optional(Schema.NonEmptyString)
})

/**
 * The workspace Nix environment declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = typeof EnvironmentDeclaration.Type

/**
 * Checks whether a value is a Nix environment declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isEnvironment = (value: unknown): value is Environment => {
  if (!Schema.is(EnvironmentDeclaration)(value)) return false
  // The schema leaves both forms optional so one struct can carry either;
  // a declaration is one of them, never neither and never both.
  return (value.flake !== undefined) !== (value.file !== undefined)
}

/**
 * Options accepted by {@link Environment}: the flake form or the file form.
 *
 * @category models
 * @since 0.1.0
 */
export type EnvironmentOptions =
  | {
    /** The flake that defines the dev shell. */
    readonly flake: Input.File
    /** @default the `flake.lock` beside the flake */
    readonly lock?: Input.File | undefined
    /**
     * The dev shell to enter: a bare name resolves to `devShells.<system>.<name>`
     * for the host system, a dotted path is used as written.
     *
     * @default the default dev shell for the host system
     */
    readonly attr?: string | undefined
    readonly file?: never
  }
  | {
    /** A Nix expression that evaluates to one derivation. */
    readonly file: Input.File
    readonly flake?: never
    readonly lock?: never
    readonly attr?: never
  }

const declaredFile = (value: unknown, what: string): Input.File => {
  if (
    typeof value !== "object" || value === null ||
    (value as { readonly _tag?: unknown })._tag !== "File" ||
    typeof (value as { readonly path?: unknown }).path !== "string"
  ) throw new TypeError(`${what} must be an S.file declaration`)
  return value as Input.File
}

/** The `flake.lock` declaration beside one declared `flake.nix`. */
const lockBeside = (flake: Input.File): Input.File => {
  const slash = flake.path.lastIndexOf("/")
  const directory = slash === -1 ? "" : flake.path.slice(0, slash + 1)
  return Input.file(`${directory}flake.lock`)
}

const knownOptions: ReadonlySet<string> = new Set(["flake", "lock", "file", "attr"])

const makeEnvironment = (options: EnvironmentOptions): Environment => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Nix.Environment options must be an object")
  }
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!knownOptions.has(key)) throw new TypeError(`Nix.Environment received unknown option ${JSON.stringify(key)}`)
  }
  const { attr, file, flake, lock } = options as {
    readonly flake?: unknown
    readonly lock?: unknown
    readonly file?: unknown
    readonly attr?: unknown
  }
  if (flake !== undefined && file !== undefined) {
    throw new Error("Nix.Environment takes a flake or a file, not both")
  }
  if (flake === undefined && file === undefined) {
    throw new Error("Nix.Environment requires a flake or a file")
  }
  if (file !== undefined) {
    if (lock !== undefined || attr !== undefined) {
      throw new Error("Nix.Environment lock and attr accompany a flake, not a file")
    }
    return Object.freeze(EnvironmentDeclaration.make({ file: declaredFile(file, "Nix.Environment file") }))
  }
  const flakeFile = declaredFile(flake, "Nix.Environment flake")
  const lockFile = lock === undefined ? lockBeside(flakeFile) : declaredFile(lock, "Nix.Environment lock")
  if (attr !== undefined) {
    if (typeof attr !== "string") throw new TypeError("Nix.Environment attr must be a string")
    if (attr.length > maximumAttrLength || !attr.isWellFormed() || !attrShape.test(attr)) {
      throw new Error(`Nix.Environment attr must be a shell name or a dotted attribute path: ${JSON.stringify(attr)}`)
    }
  }
  return Object.freeze(EnvironmentDeclaration.make({
    flake: flakeFile,
    lock: lockFile,
    ...(attr === undefined ? {} : { attr })
  }))
}

/**
 * The declared inputs an environment contributes to key material: the flake
 * and its lock, or the expression file.
 *
 * @category accessors
 * @since 0.1.0
 */
export const environmentInputs = (environment: Environment): ReadonlyArray<Input.File> => {
  if (environment.file !== undefined) return [environment.file]
  const inputs: Array<Input.File> = []
  if (environment.flake !== undefined) inputs.push(environment.flake)
  if (environment.lock !== undefined) inputs.push(environment.lock)
  return inputs
}

/**
 * The workspace-relative directory a flake-form environment's flake lives in,
 * `""` for the workspace root.
 *
 * @category accessors
 * @since 0.1.0
 */
export const flakeDirectory = (environment: Environment): string => {
  if (environment.flake === undefined) return ""
  const path = Input.resolvePath("", environment.flake.path)
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

/**
 * The flake output attribute a flake-form environment's `attr` names for one
 * host system, or undefined when the environment names no attribute and the
 * default dev shell applies.
 *
 * A bare name becomes `devShells.<system>.<name>`; a dotted path is used as
 * written.
 *
 * @category accessors
 * @since 0.1.0
 */
export const outputAttribute = (environment: Environment, system: string): string | undefined => {
  if (environment.attr === undefined) return undefined
  return environment.attr.includes(".") ? environment.attr : `devShells.${system}.${environment.attr}`
}

/**
 * The installable argument `nix develop` takes for an environment, relative
 * to the workspace root, for a generated CI script.
 *
 * A flake form renders as `./<dir>` or `./<dir>#<attr>`; `nix develop`
 * resolves a bare attr against `devShells.<system>` itself. A file form
 * renders as `--file <path>`.
 *
 * @category accessors
 * @since 0.1.0
 */
export const developArguments = (environment: Environment): ReadonlyArray<string> => {
  if (environment.file !== undefined) return ["--file", `./${Input.resolvePath("", environment.file.path)}`]
  const directory = flakeDirectory(environment)
  const reference = directory === "" ? "." : `./${directory}`
  return [environment.attr === undefined ? reference : `${reference}#${environment.attr}`]
}

/**
 * `S.Nix.Environment(options)`: the workspace Nix environment.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const environment = Smithers.Nix.Environment({
 *   flake: Smithers.file("//flake.nix")
 * })
 * ```
 *
 * @category declarations
 * @since 0.1.0
 */
export const Environment: (options: EnvironmentOptions) => Environment = makeEnvironment

/**
 * A binary supplied by the workspace Nix environment or dev shell.
 *
 * @category constructors
 * @since 0.1.0
 */
export const bin = Reference.nixBin
