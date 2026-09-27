/**
 * Declared package manager for PACKAGE.ts targets.
 *
 * A package-manager declaration names which manager a workspace installs and
 * runs tools with, the version it requires, and the runtime that manager runs
 * under. It is inert data: the constructors validate and perform no I/O, so
 * PACKAGE.ts evaluation stays pure.
 *
 * Before this module every target spelled `["pnpm", "exec", ...]` into its own
 * argv. That made the manager an undeclared constant of the target catalog: a
 * workspace on another manager could not use these targets at all, and no key
 * recorded which manager produced a result. A target now takes the declaration
 * as an attr and asks this module for the argv, so the manager is both
 * swappable and covered by key material.
 *
 * The declaration is discriminated by manager `name`. Classic variants retain
 * their reviewed version enumerations; tagged resolved variants also admit
 * requirements read from the workspace's declared manifest.
 * The Bun variant additionally types its `runtime` as the Bun runtime, so a Bun
 * manager declared against a Node runtime is not a value a PACKAGE.ts file can
 * write. The variant list is deliberately short — pnpm and Bun are what this
 * workspace pins and exercises — and it grows the same way the version lists
 * do: by review.
 *
 * The declaration carries tool identity only. It deliberately does not carry
 * the lockfile: the lockfile is produced by the `Lockfile` target and consumed
 * by the `Install` target, and a target cannot be keyed on a file it produces.
 * Targets that need the installed tree depend on the `Install` target instead,
 * whose own key covers the lockfile.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Runtime from "./Runtime.ts"

/**
 * Schema for the supported package managers.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Name = Schema.Literals(["pnpm", "bun"])

/**
 * The supported package managers.
 *
 * @category models
 * @since 0.1.0
 */
export type Name = typeof Name.Type

/**
 * Maximum length of a declared executable name.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumExecutableLength = 256

/**
 * Schema for the pnpm versions this workspace supports.
 *
 * The entries are reviewed toolchain releases. The newest is the version the
 * root workspace pins; retaining an older supported pin lets existing
 * workspaces upgrade Smithers without rewriting their toolchain in the same
 * change.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PnpmVersion = Schema.Literals(["11.21.0", "11.25.0"])

/**
 * The pnpm versions this workspace supports.
 *
 * @category models
 * @since 0.1.0
 */
export type PnpmVersion = typeof PnpmVersion.Type

/**
 * Schema for a declared pnpm.
 *
 * `executable` is what gets spawned; it defaults to the manager name and is
 * overridable for hosts that install a manager under another name.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PnpmPackageManager = Schema.Struct({
  name: Schema.Literal("pnpm"),
  version: PnpmVersion,
  executable: Schema.NonEmptyString,
  runtime: Runtime.Runtime
})

/**
 * One declared pnpm.
 *
 * @category models
 * @since 0.1.0
 */
export type PnpmPackageManager = typeof PnpmPackageManager.Type

/**
 * Schema for a declared Bun package manager.
 *
 * `runtime` is the Bun runtime specifically, not the runtime union: Bun the
 * package manager is the same program as Bun the runtime, so a declaration
 * pairing it with Node is not a thing that exists.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BunPackageManager = Schema.Struct({
  name: Schema.Literal("bun"),
  version: Runtime.BunVersion,
  executable: Schema.NonEmptyString,
  runtime: Runtime.BunRuntime
})

/**
 * One declared Bun package manager.
 *
 * @category models
 * @since 0.1.0
 */
export type BunPackageManager = typeof BunPackageManager.Type

/**
 * Schema for pnpm resolved from a workspace manifest or explicit requirement.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ResolvedPnpmPackageManager = Schema.TaggedStruct("ResolvedPnpmPackageManager", {
  name: Schema.Literal("pnpm"),
  version: Runtime.VersionRequirement,
  executable: Schema.NonEmptyString,
  runtime: Runtime.Runtime
})

/**
 * One resolved pnpm declaration.
 *
 * @category models
 * @since 1.0.0
 */
export type ResolvedPnpmPackageManager = typeof ResolvedPnpmPackageManager.Type

/**
 * Schema for Bun acting as package manager under a resolved runtime pin.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ResolvedBunPackageManager = Schema.TaggedStruct("ResolvedBunPackageManager", {
  name: Schema.Literal("bun"),
  version: Runtime.VersionRequirement,
  executable: Schema.NonEmptyString,
  runtime: Schema.Union([Runtime.BunRuntime, Runtime.ResolvedBunRuntime])
})

/**
 * One resolved Bun package-manager declaration.
 *
 * @category models
 * @since 1.0.0
 */
export type ResolvedBunPackageManager = typeof ResolvedBunPackageManager.Type

/**
 * Schema for one declared package manager.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PackageManager = Schema.Union([
  PnpmPackageManager,
  BunPackageManager,
  ResolvedPnpmPackageManager,
  ResolvedBunPackageManager
])

/**
 * One declared package manager.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageManager = typeof PackageManager.Type

/**
 * Options accepted by a package-manager constructor.
 *
 * `Version` is the variant's own enumeration, so an unsupported pin is a type
 * error at the call site rather than a throw at evaluation.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<Version extends string> {
  /** The version the workspace requires. */
  readonly version: Version
  /** The runtime the manager itself runs under. */
  readonly runtime: Runtime.Runtime
  /** @default the manager name */
  readonly executable?: string | undefined
}

const controlCharacter = /[\u0000-\u001f\u007f]/

/**
 * Validates one declared text field.
 *
 * A control character in an executable name would reach a child-process argv.
 * `version` needs no such check: its schema enumerates every value it can hold.
 */
const usable = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`)
  if (
    value.length > maximumExecutableLength ||
    !value.isWellFormed() ||
    controlCharacter.test(value)
  ) throw new Error(`${what} must be bounded well-formed text without control characters`)
  const trimmed = value.trim()
  if (trimmed === "") throw new Error(`${what} must not be empty`)
  return trimmed
}

/** The executable a declaration spawns, defaulting to the manager name. */
const executableFor = (name: Name, executable: string | undefined): string =>
  executable === undefined ? name : usable(executable, `${name} executable`)

/**
 * Options accepted by the WORKSPACE.ts form of {@link Pnpm}.
 *
 * @category models
 * @since 0.1.0
 */
export interface PnpmWorkspaceOptions {
  readonly manifest: Input.File
  readonly lockfile: Input.File
  readonly audit?: { readonly severity: string; readonly recursive?: boolean } | undefined
  readonly version?: string | undefined
  readonly workspaces?: Input.File | undefined
}

/**
 * Declares pnpm as the workspace package manager.
 *
 * Two forms, one per era. The WORKSPACE.ts form mirrors {@link Yarn}:
 * `{ manifest, lockfile, version?, audit?, workspaces? }`, no `runtime` —
 * the Workspace declares the runtime once and the manager reads it from
 * there. The PACKAGE.ts form keeps `{ version, runtime }` for PACKAGE.ts users.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const packageManager = S.PackageManager.Pnpm({
 *   manifest: S.file("//package.json"),
 *   lockfile: S.file("//pnpm-lock.yaml"),
 *   version: "8"
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function Pnpm(options: PnpmWorkspaceOptions): PnpmDeclaration
export function Pnpm(options: Options<PnpmVersion>): PnpmPackageManager
export function Pnpm(
  options: PnpmWorkspaceOptions | Options<PnpmVersion>
): PnpmDeclaration | PnpmPackageManager {
  if ("manifest" in options || "lockfile" in options) {
    const workspace = options as PnpmWorkspaceOptions
    return PnpmDeclaration.make({
      manifest: workspace.manifest,
      lockfile: workspace.lockfile,
      ...(workspace.audit === undefined ? {} : { audit: { ...workspace.audit } }),
      ...(workspace.version === undefined ? {} : { version: usable(workspace.version, "pnpm version") }),
      ...(workspace.workspaces === undefined ? {} : { workspaces: workspace.workspaces })
    })
  }
  const classic = options
  if (!Runtime.isRuntime(classic.runtime)) {
    throw new TypeError(`pnpm requires a declared runtime, for example Runtime.Node({ version: ">=26.4.0" })`)
  }
  return PnpmPackageManager.make({
    name: "pnpm",
    version: classic.version,
    executable: executableFor("pnpm", classic.executable),
    runtime: classic.runtime
  })
}

/**
 * Declares Bun as the workspace package manager.
 *
 * Bun is its own runtime, so this constructor takes no separate version: the
 * manager version is the runtime version, and declaring them apart would let a
 * PACKAGE.ts file state two versions of one program.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const runtime = Smithers.Runtime.Bun({ version: ">=1.4.0" })
 *
 * export const packageManager = Smithers.PackageManager.BunPackages({ runtime })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function BunPackages(options: {
  readonly runtime: Runtime.BunRuntime
  /** @default the runtime executable */
  readonly executable?: string | undefined
}): BunPackageManager
export function BunPackages(options: {
  readonly runtime: Runtime.BunRuntime | Runtime.ResolvedBunRuntime
  /** @default the runtime executable */
  readonly executable?: string | undefined
}): BunPackageManager | ResolvedBunPackageManager
export function BunPackages(options: {
  readonly runtime: Runtime.BunRuntime | Runtime.ResolvedBunRuntime
  readonly executable?: string | undefined
}): BunPackageManager | ResolvedBunPackageManager {
  const fields = {
    name: "bun",
    version: options.runtime.version,
    executable: executableFor("bun", options.executable ?? options.runtime.executable),
    runtime: options.runtime
  } as const
  return "_tag" in options.runtime
    ? ResolvedBunPackageManager.make(fields)
    : BunPackageManager.make({ ...fields, version: options.runtime.version, runtime: options.runtime })
}

/**
 * Schema for the audit policy a WORKSPACE.ts Yarn declaration may carry.
 *
 * @category schemas
 * @since 0.1.0
 */
export const YarnAudit = Schema.Struct({
  severity: Schema.NonEmptyString,
  recursive: Schema.optional(Schema.Boolean)
})

/**
 * Schema for the WORKSPACE.ts Yarn package-manager declaration.
 *
 * Unlike the PACKAGE.ts variants above, the Artsy workspace form pins the
 * manager through the repository's own manifest and lockfile rather than an
 * enumerated version, so its identity is content, not a version literal.
 *
 * @category schemas
 * @since 0.1.0
 */
export const YarnDeclaration = Schema.TaggedStruct("YarnPackageManager", {
  manifest: Input.File,
  lockfile: Input.File,
  audit: Schema.optional(YarnAudit),
  version: Schema.optional(Schema.NonEmptyString)
})

/**
 * One WORKSPACE.ts Yarn package-manager declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type YarnDeclaration = typeof YarnDeclaration.Type

/**
 * Checks whether a value is a WORKSPACE.ts Yarn declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isYarnDeclaration: (value: unknown) => value is YarnDeclaration = Schema.is(YarnDeclaration)

/**
 * Declares Yarn as the workspace package manager, WORKSPACE.ts form.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const packageManager = S.PackageManager.Yarn({
 *   manifest: S.file("//package.json"),
 *   lockfile: S.file("//yarn.lock"),
 *   audit: { severity: "critical", recursive: true }
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Yarn = (options: {
  readonly manifest: Input.File
  readonly lockfile: Input.File
  readonly audit?: { readonly severity: string; readonly recursive?: boolean } | undefined
  readonly version?: string | undefined
}): YarnDeclaration =>
  YarnDeclaration.make({
    manifest: options.manifest,
    lockfile: options.lockfile,
    ...(options.audit === undefined ? {} : { audit: { ...options.audit } }),
    ...(options.version === undefined ? {} : { version: usable(options.version, "yarn version") })
  })

/**
 * Schema for the WORKSPACE.ts Pnpm package-manager declaration.
 *
 * Like {@link YarnDeclaration}, the workspace form pins the manager through
 * the repository's own manifest and lockfile rather than an enumerated
 * version literal, and it carries no `runtime`: the runtime is declared once
 * on the Workspace and wired to the manager by requirement. `workspaces` is
 * the optional `pnpm-workspace.yaml` graph input (package globs, catalog
 * pins, overrides), so an override bump invalidates targets that resolve
 * through it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PnpmDeclaration = Schema.TaggedStruct("PnpmPackageManager", {
  manifest: Input.File,
  lockfile: Input.File,
  audit: Schema.optional(YarnAudit),
  version: Schema.optional(Schema.NonEmptyString),
  workspaces: Schema.optional(Input.File)
})

/**
 * One WORKSPACE.ts Pnpm package-manager declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type PnpmDeclaration = typeof PnpmDeclaration.Type

/**
 * Checks whether a value is a WORKSPACE.ts Pnpm declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPnpmDeclaration: (value: unknown) => value is PnpmDeclaration = Schema.is(PnpmDeclaration)

/**
 * The workspace package manager's own binary as an inert tool reference,
 * `S.PackageManager.bin`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const bin: Reference.PackageManagerBin = Reference.packageManagerBin

/**
 * Checks whether a value is a declared package manager.
 *
 * The guard is the schema itself, so it admits exactly the values a
 * constructor or resolver can produce: a supported `name`, a reviewed legacy
 * or tagged resolved requirement, a non-empty `executable`, and a runtime the
 * variant allows.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPackageManager: (value: unknown) => value is PackageManager = Schema.is(PackageManager)

/**
 * The manager a rule runs its tool through, refusing an unresolved one.
 *
 * Every rule below takes the declaration as `PackageManager | undefined`
 * because a PACKAGE.ts no longer writes it: the workspace declares the manager
 * once and the executor fills the attr in before it runs the body. `undefined`
 * therefore means the workspace declared no Node package manager at all, which
 * is a refusal with a name rather than a spawn of whatever is on PATH.
 *
 * @category constructors
 * @since 0.1.0
 */
export const required = (manager: PackageManager | undefined): PackageManager => {
  if (manager === undefined) {
    throw new TypeError(
      "no package manager is available: declare one on the workspace " +
        "(packageManager: S.PackageManager.Pnpm({ ... }) in WORKSPACE.ts) " +
        "or pass packageManager: on this target"
    )
  }
  return manager
}

/**
 * The manager that runs a workspace tool under `runtime`.
 *
 * A declaration overrides the interpreter its tool runs under by naming a
 * `runtime`, not by restating the workspace's package manager: Bun is its own
 * manager, so `runtime: S.Runtime.Bun({ ... })` is the whole override, and
 * every other runtime keeps the workspace manager. This is what lets the Bun
 * compatibility matrix re-run a package's suite under a second interpreter
 * without a PACKAGE.ts declaring a package manager.
 *
 * @category constructors
 * @since 0.1.0
 */
export const under = (
  manager: PackageManager | undefined,
  runtime: Runtime.Runtime | undefined
): PackageManager | undefined => runtime !== undefined && runtime.name === "bun" ? BunPackages({ runtime }) : manager

/**
 * The lockfile each manager writes.
 *
 * This is a convention, not key material: it names where the `Lockfile` target
 * writes and where the `Install` target reads.
 *
 * @category constructors
 * @since 0.1.0
 */
export const lockfileName = (declared: PackageManager | undefined): string => {
  const manager = required(declared)
  switch (manager.name) {
    case "pnpm":
      return "pnpm-lock.yaml"
    case "bun":
      return "bun.lock"
  }
}

/**
 * Builds the argv that runs a workspace-installed tool.
 *
 * Every manager resolves a locally installed binary, and each spells it
 * differently.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const packageManager = Smithers.PackageManager.Pnpm({
 *   version: "11.21.0",
 *   runtime: Smithers.Runtime.Node({ version: ">=26.4.0" })
 * })
 *
 * // ["pnpm", "exec", "vitest", "run"]
 * const argv = Smithers.PackageManager.exec(packageManager, ["vitest", "run"])
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const exec = (declared: PackageManager | undefined, argv: ReadonlyArray<string>): Array<string> => {
  const manager = required(declared)
  switch (manager.name) {
    case "pnpm":
      return [manager.executable, "exec", ...argv]
    case "bun":
      // Installed tools often have a Node shebang; honor the declared runtime.
      return [manager.executable, "x", "--bun", ...argv]
  }
}

/**
 * Builds the argv that runs a tool the workspace has not installed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const dlx = (declared: PackageManager | undefined, argv: ReadonlyArray<string>): Array<string> => {
  const manager = required(declared)
  switch (manager.name) {
    case "pnpm":
      return [manager.executable, "dlx", ...argv]
    case "bun":
      // `bun x` and `bunx` are the same command, and this is the spelling that
      // honours a declared `executable`: a wrapper script, an absolute path, or
      // a sandbox shim is what the declaration asked to spawn.
      return [manager.executable, "x", ...argv]
  }
}

/**
 * Builds the argv that publishes the package in the working directory.
 *
 * @category constructors
 * @since 0.1.0
 */
export const publish = (declared: PackageManager | undefined, args: ReadonlyArray<string> = []): Array<string> => [
  required(declared).executable,
  "publish",
  ...args
]

/**
 * Options accepted by {@link install}.
 *
 * @category models
 * @since 0.1.0
 */
export interface InstallOptions {
  /** Refuse to update the lockfile. @default true */
  readonly frozen?: boolean | undefined
  /** Resolve and write the lockfile without linking a tree. @default false */
  readonly lockfileOnly?: boolean | undefined
  /** Refuse to run package lifecycle scripts. @default true */
  readonly ignoreScripts?: boolean | undefined
}

/**
 * Builds the argv that installs the workspace.
 *
 * A frozen install is the default because an install that may rewrite the
 * lockfile is not reproducible, and because the lockfile is a generated file
 * with its own target.
 *
 * @category constructors
 * @since 0.1.0
 */
export const install = (declared: PackageManager | undefined, options: InstallOptions = {}): Array<string> => {
  const manager = required(declared)
  const frozen = options.frozen ?? true
  const lockfileOnly = options.lockfileOnly ?? false
  const ignoreScripts = options.ignoreScripts ?? true
  const argv: Array<string> = [manager.executable, "install"]
  if (frozen) argv.push("--frozen-lockfile")
  if (lockfileOnly) argv.push("--lockfile-only")
  if (ignoreScripts) argv.push("--ignore-scripts")
  return argv
}
