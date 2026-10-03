/**
 * Declared JavaScript runtime for PACKAGE.ts targets.
 *
 * A runtime declaration names which interpreter a workspace runs its tools
 * under, and the version it requires. It is inert data: the constructors
 * perform no I/O, so PACKAGE.ts evaluation stays pure.
 *
 * The declaration exists because the interpreter is key material. `node -e`
 * and `bun -e` do not evaluate the same program, and two Node versions do not
 * produce the same `tsc` output. Before this module every target spelled `node`
 * into its own argv, which made the interpreter an undeclared ambient fact
 * that no key covered and no PACKAGE.ts file could change.
 *
 * Classic declarations enumerate the reviewed workspace floors. Tagged
 * resolved declarations also carry exact pins and manifest requirements through
 * the same target schemas. Every variant names its interpreter explicitly;
 * resolving a manifest never changes which program a target selects.
 *
 * A declaration is a requirement, not a measurement. `packages/smithers/build`
 * carries the matching `Runtime` service, which measures the host interpreter
 * and refuses to execute when it does not satisfy what the workspace declared.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"

/**
 * Schema for the supported JavaScript runtimes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Name = Schema.Literals(["node", "bun"])

/**
 * The supported JavaScript runtimes.
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
 * Schema for the Node version requirements this workspace supports.
 *
 * The single entry matches the root `package.json` `engines.node`. A workspace
 * that wants another floor adds it here, which is the point: the set of
 * requirements a PACKAGE.ts file may write is reviewed, not free text.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeVersion = Schema.Literals([">=26.4.0"])

/**
 * The Node version requirements this workspace supports.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeVersion = typeof NodeVersion.Type

/**
 * Schema for the Bun version requirements this workspace supports.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BunVersion = Schema.Literals([">=1.4.0"])

/**
 * The Bun version requirements this workspace supports.
 *
 * @category models
 * @since 0.1.0
 */
export type BunVersion = typeof BunVersion.Type

/**
 * Schema for a declared Node runtime.
 *
 * `executable` is what gets spawned; it defaults to the runtime name and is
 * overridable for hosts that install an interpreter under another name.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeRuntime = Schema.Struct({
  name: Schema.Literal("node"),
  version: NodeVersion,
  executable: Schema.NonEmptyString
})

/**
 * One declared Node runtime.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeRuntime = typeof NodeRuntime.Type

/**
 * Schema for a declared Bun runtime.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BunRuntime = Schema.Struct({
  name: Schema.Literal("bun"),
  version: BunVersion,
  executable: Schema.NonEmptyString
})

/**
 * One declared Bun runtime.
 *
 * @category models
 * @since 0.1.0
 */
export type BunRuntime = typeof BunRuntime.Type

/**
 * A bounded printable requirement resolved from a workspace declaration.
 * The runtime service verifies its exact-version or single-comparator syntax.
 *
 * @category schemas
 * @since 1.0.0
 */
export const VersionRequirement = Schema.NonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[\x21-\x7e][\x20-\x7e]*(?![\s\S])/)
)

/**
 * Schema for a Node requirement resolved from a literal or manifest.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ResolvedNodeRuntime = Schema.TaggedStruct("ResolvedNodeRuntime", {
  name: Schema.Literal("node"),
  version: VersionRequirement,
  executable: Schema.NonEmptyString
})

/**
 * One resolved Node runtime.
 *
 * @category models
 * @since 1.0.0
 */
export type ResolvedNodeRuntime = typeof ResolvedNodeRuntime.Type

/**
 * Schema for a Bun requirement resolved from an exact workspace pin.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ResolvedBunRuntime = Schema.TaggedStruct("ResolvedBunRuntime", {
  name: Schema.Literal("bun"),
  version: VersionRequirement,
  executable: Schema.NonEmptyString
})

/**
 * One resolved Bun runtime.
 *
 * @category models
 * @since 1.0.0
 */
export type ResolvedBunRuntime = typeof ResolvedBunRuntime.Type

/**
 * Schema for one declared JavaScript runtime.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Runtime = Schema.Union([NodeRuntime, BunRuntime, ResolvedNodeRuntime, ResolvedBunRuntime])

/**
 * One declared JavaScript runtime.
 *
 * @category models
 * @since 0.1.0
 */
export type Runtime = typeof Runtime.Type

/**
 * Options accepted by a runtime constructor.
 *
 * `Version` is the variant's own enumeration, so an unsupported requirement is
 * a type error at the call site rather than a throw at evaluation.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<Version extends string> {
  /** The version requirement the workspace declares. */
  readonly version: Version
  /** @default the runtime name */
  readonly executable?: string | undefined
}

const controlCharacter = /[\u0000-\u001f\u007f]/

/**
 * Validates one declared text field.
 *
 * Bounded, well-formed, and control-free are the same three conditions every
 * other declaration in this package applies. A control character in an
 * executable name would reach a child-process argv. `version` needs no such
 * check: its schema enumerates every value it can hold.
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

/** The executable a declaration spawns, defaulting to the runtime name. */
const executableFor = (name: Name, executable: string | undefined): string =>
  executable === undefined ? name : usable(executable, "runtime executable")

/**
 * Schema for the WORKSPACE.ts Node runtime declaration.
 *
 * The Artsy workspace API pins the runtime either to a literal version
 * (`S.Runtime.Node({ version: "26" })`) or derives it from a manifest's
 * `engines` field (`S.Runtime.Node({ manifest: packageJson })`). The two
 * options are an exclusive union.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeDeclaration = Schema.TaggedStruct("NodeRuntimeDeclaration", {
  version: Schema.optional(Schema.NonEmptyString),
  manifest: Schema.optional(Input.File)
})

/**
 * One WORKSPACE.ts Node runtime declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeDeclaration = typeof NodeDeclaration.Type

/**
 * Checks whether a value is a WORKSPACE.ts Node runtime declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isNodeDeclaration: (value: unknown) => value is NodeDeclaration = Schema.is(NodeDeclaration)

/** A WORKSPACE/PACKAGE declaration for an exact Bun toolchain version.
 *
 * @category targets
 * @since 0.1.0
 */
export const BunDeclaration = Schema.TaggedStruct("BunRuntimeDeclaration", {
  version: Schema.NonEmptyString,
  executable: Schema.NonEmptyString
})

/** One exact-version Bun declaration outside the BUILD-era enumeration.
 *
 * @category targets
 * @since 0.1.0
 */
export type BunDeclaration = typeof BunDeclaration.Type

/** Checks whether a value is an exact-version Bun declaration.
 *
 * @category targets
 * @since 0.1.0
 */
export const isBunDeclaration: (value: unknown) => value is BunDeclaration = Schema.is(BunDeclaration)

/**
 * Declares Node as the workspace runtime.
 *
 * The PACKAGE.ts form (`{ version: ">=26.4.0" }`, one of the reviewed
 * {@link NodeVersion} requirements) keeps returning the classic
 * {@link NodeRuntime}. The WORKSPACE.ts forms — an exclusive
 * `{ manifest }` | `{ version }` union with a free-form version string —
 * return a branded {@link NodeDeclaration}.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function Node(options: Options<NodeVersion>): NodeRuntime
export function Node(
  options: { readonly manifest: Input.File; readonly version?: never } | {
    readonly version: string
    readonly manifest?: never
  }
): NodeDeclaration
export function Node(
  options: Options<NodeVersion> | { readonly manifest?: Input.File; readonly version?: string }
): NodeRuntime | NodeDeclaration {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Runtime.Node options must be an object")
  }
  const manifest = "manifest" in options ? options.manifest : undefined
  const version = "version" in options ? options.version : undefined
  if (manifest !== undefined && version !== undefined) {
    throw new Error("Runtime.Node accepts a manifest or a version, not both")
  }
  if (manifest !== undefined) {
    return NodeDeclaration.make({ manifest })
  }
  if (version === undefined) {
    throw new Error("Runtime.Node requires a manifest or a version")
  }
  if (version === ">=26.4.0") {
    return NodeRuntime.make({
      name: "node",
      version,
      executable: executableFor("node", (options as Options<NodeVersion>).executable)
    })
  }
  return NodeDeclaration.make({ version: usable(version, "runtime version") })
}

/**
 * The workspace runtime's own binary as an inert tool reference,
 * `S.Runtime.bin`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const bin: Reference.RuntimeBin = Reference.runtimeBin

/**
 * References a one-shot npx tool run under the workspace runtime,
 * `S.Runtime.npx(spec)`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const npx = Reference.runtimeNpx

/**
 * Declares Bun as the workspace runtime.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const runtime = Smithers.Runtime.Bun({ version: ">=1.4.0" })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export function Bun(options: Options<BunVersion>): BunRuntime
export function Bun(options: Options<string>): BunRuntime | ResolvedBunRuntime
export function Bun(options: Options<string>): BunRuntime | ResolvedBunRuntime {
  const version = usable(options.version, "runtime version")
  const executable = executableFor("bun", options.executable)
  if (version === ">=1.4.0") return BunRuntime.make({ name: "bun", version, executable })
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`unsupported Bun runtime requirement: ${version}`)
  }
  return ResolvedBunRuntime.make({ name: "bun", version, executable })
}

/**
 * Checks whether a value is a declared runtime.
 *
 * The guard is the schema itself, so it admits exactly the values a
 * constructor or resolver can produce: a supported `name`, a reviewed legacy
 * requirement or a tagged resolved requirement, and a non-empty `executable`.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRuntime: (value: unknown) => value is Runtime = Schema.is(Runtime)

/**
 * The runtime a rule spawns under, refusing an unresolved one.
 *
 * The three argv builders below take `Runtime | undefined` because a
 * PACKAGE.ts no longer writes the interpreter: the workspace declares it once
 * and the executor fills the attr in before it runs the body. `undefined`
 * therefore means the workspace declared no runtime at all, which is a refusal
 * with a name rather than a spawn of whatever is on PATH.
 *
 * @category constructors
 * @since 0.1.0
 */
export const required = (runtime: Runtime | undefined): Runtime => {
  if (runtime === undefined) {
    throw new TypeError(
      "no runtime is available: declare one on the workspace " +
        "(runtime: S.Runtime.Node({ ... }) in WORKSPACE.ts) or pass runtime: on this target"
    )
  }
  return runtime
}

/**
 * Builds the argv that runs one script under the declared runtime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const run = (runtime: Runtime | undefined, args: ReadonlyArray<string>): Array<string> => [
  required(runtime).executable,
  ...args
]

/**
 * Builds the argv that evaluates one inline program under the declared
 * runtime.
 *
 * Both supported runtimes spell inline evaluation as `-e`. A target that needs
 * a throwaway program calls this rather than spelling an interpreter flag into
 * its own argv.
 *
 * @category constructors
 * @since 0.1.0
 */
export const evaluate = (
  runtime: Runtime | undefined,
  program: string,
  args: ReadonlyArray<string> = []
): Array<string> => [required(runtime).executable, "-e", program, ...args]

/**
 * Builds the argv that runs declared test files under the runtime's own test
 * runner.
 *
 * Both supported runtimes ship one, and each spells it differently: Node takes
 * `--test` before the files, Bun takes a `test` subcommand. A target that runs
 * a test file calls this rather than spelling an interpreter flag into its own
 * argv, which is what lets the workspace switch interpreters by editing one
 * declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const test = (
  declared: Runtime | undefined,
  files: ReadonlyArray<string>,
  options: { readonly isolate?: boolean | undefined } = {}
): Array<string> => {
  const runtime = required(declared)
  switch (runtime.name) {
    case "node":
      return [runtime.executable, "--test", ...files]
    case "bun":
      return [runtime.executable, "test", ...(options.isolate === true ? ["--isolate"] : []), ...files]
  }
}
