/**
 * Inert authoring references for PACKAGE.ts and WORKSPACE.ts declarations.
 *
 * A reference names a tool, an agent, a flag, a commit, or a payload input
 * without resolving it. Constructing one performs no I/O and never creates a
 * target: references are plain frozen records that ride inside target attrs
 * and are resolved by the executor (tools), the package index (agents,
 * flags), or the invoker (payload inputs).
 *
 * This module is a leaf: it imports nothing from the target catalog, so every
 * other module may use its schemas without creating an import cycle.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Schema for a package-local binary reference, `S.NodeModule.Bin(pkg, bin?)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeModuleBin = Schema.TaggedStruct("NodeModuleBin", {
  package: Schema.NonEmptyString,
  bin: Schema.optional(Schema.NonEmptyString)
})

/**
 * A package-local binary reference.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeModuleBin = typeof NodeModuleBin.Type

/**
 * Schema for an installed-module dependency reference, `S.NodeModule(pkg)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NodeModuleDep = Schema.TaggedStruct("NodeModule", {
  package: Schema.NonEmptyString
})

/**
 * An installed-module dependency reference.
 *
 * @category models
 * @since 0.1.0
 */
export type NodeModuleDep = typeof NodeModuleDep.Type

/**
 * Schema for a host binary reference, `S.Host.bin(name)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const HostBin = Schema.TaggedStruct("HostBin", {
  name: Schema.NonEmptyString
})

/**
 * A host binary reference.
 *
 * @category models
 * @since 0.1.0
 */
export type HostBin = typeof HostBin.Type

/**
 * Schema for the workspace package manager's own binary,
 * `S.PackageManager.bin`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PackageManagerBin = Schema.TaggedStruct("PackageManagerBin", {})

/**
 * The workspace package manager's own binary.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageManagerBin = typeof PackageManagerBin.Type

/**
 * Schema for the workspace runtime's own binary, `S.Runtime.bin`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RuntimeBin = Schema.TaggedStruct("RuntimeBin", {})

/**
 * The workspace runtime's own binary.
 *
 * @category models
 * @since 0.1.0
 */
export type RuntimeBin = typeof RuntimeBin.Type

/**
 * Schema for the workspace Rust toolchain's cargo binary.
 *
 * The reference names no executable path: the planner resolves it against the
 * workspace `toolchains` layer, so a workspace without one refuses every cargo
 * target by name instead of running whatever `cargo` is on PATH.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CargoBin = Schema.TaggedStruct("CargoBin", {})

/**
 * The workspace Rust toolchain's cargo binary.
 *
 * @category models
 * @since 0.1.0
 */
export type CargoBin = typeof CargoBin.Type

/**
 * Schema for an npx-style one-shot tool reference, `S.Runtime.npx(spec)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RuntimeNpx = Schema.TaggedStruct("RuntimeNpx", {
  spec: Schema.NonEmptyString
})

/**
 * An npx-style one-shot tool reference.
 *
 * @category models
 * @since 0.1.0
 */
export type RuntimeNpx = typeof RuntimeNpx.Type

/**
 * Schema for a tool whose version authority is the workspace's mise config.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MiseBin = Schema.TaggedStruct("MiseBin", {
  name: Schema.NonEmptyString
})

/**
 * A tool whose version authority is the workspace's mise config.
 *
 * @category models
 * @since 0.1.0
 */
export type MiseBin = typeof MiseBin.Type

/**
 * Schema for the selected Go toolchain binary.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GoBin = Schema.TaggedStruct("GoBin", {})
/**
 * A selected Go toolchain binary reference.
 *
 * @category models
 * @since 0.1.0
 */
export type GoBin = typeof GoBin.Type
/**
 * Schema for a versioned one-shot Go tool reference.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GoRun = Schema.TaggedStruct("GoRun", { spec: Schema.NonEmptyString })
/**
 * A versioned one-shot Go tool reference.
 *
 * @category models
 * @since 0.1.0
 */
export type GoRun = typeof GoRun.Type
/**
 * Schema for a binary supplied by a Nix development shell.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NixBin = Schema.TaggedStruct("NixBin", { name: Schema.NonEmptyString })
/**
 * A binary supplied by a Nix development shell.
 *
 * @category models
 * @since 0.1.0
 */
export type NixBin = typeof NixBin.Type
const targetTypeId = Symbol.for("smithers-build/Target")
/**
 * Structural view admitted when a build target is used as a tool.
 *
 * @category models
 * @since 0.1.0
 */
export interface TargetTool {
  readonly _tag: string
}
/**
 * Schema for a build target used as an executable tool edge.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TargetTool = Schema.declare<TargetTool>((value): value is TargetTool =>
  (typeof value === "object" && value !== null || typeof value === "function") &&
  typeof (value as { readonly _tag?: unknown })._tag === "string" &&
  Object.getOwnPropertyDescriptor(value, targetTypeId)?.value !== undefined
)

/**
 * Schema for every executable tool reference an attrs `bin` or `using` slot
 * accepts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Tool = Schema.Union([
  NodeModuleBin,
  HostBin,
  PackageManagerBin,
  RuntimeBin,
  RuntimeNpx,
  MiseBin,
  GoBin,
  GoRun,
  NixBin,
  TargetTool,
  CargoBin
])

/**
 * Every executable tool reference.
 *
 * @category models
 * @since 0.1.0
 */
export type Tool = typeof Tool.Type

const boundedName = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`)
  const trimmed = value.trim()
  if (trimmed === "" || trimmed.length > 512 || !trimmed.isWellFormed() || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${what} must be bounded well-formed text without control characters`)
  }
  return trimmed
}

const makeNodeModule = (packageName: string): NodeModuleDep =>
  Object.freeze(NodeModuleDep.make({ package: boundedName(packageName, "NodeModule package") }))

/**
 * References an installed module (`S.NodeModule(pkg)`) or one of its binaries
 * (`S.NodeModule.Bin(pkg, bin?)`).
 *
 * @category constructors
 * @since 0.1.0
 */
export const NodeModule: {
  (packageName: string): NodeModuleDep
  readonly Bin: (packageName: string, bin?: string) => NodeModuleBin
} = Object.assign(makeNodeModule, {
  Bin: (packageName: string, bin?: string): NodeModuleBin =>
    Object.freeze(NodeModuleBin.make({
      package: boundedName(packageName, "NodeModule.Bin package"),
      ...(bin === undefined ? {} : { bin: boundedName(bin, "NodeModule.Bin binary") })
    }))
})

/**
 * References a binary the workspace `S.Host({ bins })` declaration names.
 *
 * @category constructors
 * @since 0.1.0
 */
export const hostBin = (name: string): HostBin =>
  Object.freeze(HostBin.make({ name: boundedName(name, "Host.bin name") }))

/**
 * The workspace package manager's binary as an inert reference value.
 *
 * @category constructors
 * @since 0.1.0
 */
export const packageManagerBin: PackageManagerBin = Object.freeze(PackageManagerBin.make({}))

/**
 * The workspace runtime's binary as an inert reference value.
 *
 * @category constructors
 * @since 0.1.0
 */
export const runtimeBin: RuntimeBin = Object.freeze(RuntimeBin.make({}))

/**
 * References a one-shot npx tool run under the workspace runtime.
 *
 * @category constructors
 * @since 0.1.0
 */
export const runtimeNpx = (spec: string): RuntimeNpx =>
  Object.freeze(RuntimeNpx.make({ spec: boundedName(spec, "Runtime.npx spec") }))

/**
 * References one binary pinned by the workspace's `S.Mise` config.
 *
 * @category constructors
 * @since 0.1.0
 */
export const miseBin = (name: string): MiseBin =>
  Object.freeze(MiseBin.make({ name: boundedName(name, "Mise.bin name") }))

/**
 * References the selected Go toolchain binary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const goBin: GoBin = Object.freeze(GoBin.make({}))
/**
 * References a versioned one-shot Go tool.
 *
 * @category constructors
 * @since 0.1.0
 */
export const goRun = (spec: string): GoRun => Object.freeze(GoRun.make({ spec: boundedName(spec, "Go.run spec") }))
/**
 * References a binary supplied by a Nix development shell.
 *
 * @category constructors
 * @since 0.1.0
 */
export const nixBin = (name: string): NixBin => Object.freeze(NixBin.make({ name: boundedName(name, "Nix.bin name") }))

/**
 * Schema for a declared symlink emit value, `S.symlink(path)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Symlink = Schema.TaggedStruct("Symlink", {
  path: Schema.NonEmptyString
})

/**
 * A declared symlink emit value.
 *
 * @category models
 * @since 0.1.0
 */
export type Symlink = typeof Symlink.Type

/**
 * Declares that a generated file is a symbolic link to `path`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const symlink = (path: string): Symlink =>
  Object.freeze(Symlink.make({ path: boundedName(path, "symlink path") }))

/**
 * Schema for a git commit reference, `S.gitCommit(ref)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const GitCommit = Schema.TaggedStruct("GitCommit", {
  ref: Schema.NonEmptyString
})

/**
 * A git commit reference.
 *
 * @category models
 * @since 0.1.0
 */
export type GitCommit = typeof GitCommit.Type

/**
 * References one git commit without invoking git.
 *
 * @category constructors
 * @since 0.1.0
 */
export const gitCommit = (ref: string): GitCommit =>
  Object.freeze(GitCommit.make({ ref: boundedName(ref, "gitCommit ref") }))

/**
 * Schema for a declared MCP server reachable over HTTP, `S.Mcp.Http(name, url)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const McpHttp = Schema.TaggedStruct("McpHttp", {
  name: Schema.NonEmptyString,
  url: Schema.NonEmptyString
})

/**
 * A declared MCP server reachable over HTTP.
 *
 * @category models
 * @since 0.1.0
 */
export type McpHttp = typeof McpHttp.Type

/**
 * Declared MCP servers.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Mcp = Object.freeze({
  Http: (name: string, url: string): McpHttp =>
    Object.freeze(McpHttp.make({ name: boundedName(name, "Mcp.Http name"), url: boundedName(url, "Mcp.Http url") }))
})

/**
 * Schema for an agent reference, `S.Agents.<name>`.
 *
 * The reference is resolved against the workspace `S.Agents({ ... })`
 * declaration when the package index loads; an unknown name fails the graph
 * load rather than an execution.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AgentRef = Schema.TaggedStruct("AgentRef", {
  name: Schema.NonEmptyString
})

/**
 * An agent reference.
 *
 * @category models
 * @since 0.1.0
 */
export type AgentRef = typeof AgentRef.Type

/** Inline agent declarations accepted anywhere an agent selector is used.
 *
 * @category targets
 * @since 0.1.0
 */
export const InlineAgent = Schema.Union([
  Schema.TaggedStruct("AgentClaudeCode", { model: Schema.NonEmptyString }),
  Schema.TaggedStruct("AgentCodex", { model: Schema.NonEmptyString }),
  Schema.TaggedStruct("AgentPool", { agents: Schema.Array(Schema.NonEmptyString) })
])

/** A workspace agent reference or an inline declaration.
 *
 * @category targets
 * @since 0.1.0
 */
export const AgentSelection = Schema.Union([AgentRef, InlineAgent])
/** A workspace agent reference or an inline declaration.
 *
 * @category targets
 * @since 0.1.0
 */
export type AgentSelection = typeof AgentSelection.Type

/**
 * Schema for a flag reference, `S.Flags.<name>`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FlagRef = Schema.TaggedStruct("FlagRef", {
  name: Schema.NonEmptyString
})

/**
 * A flag reference.
 *
 * @category models
 * @since 0.1.0
 */
export type FlagRef = typeof FlagRef.Type

/** Names a property access must never turn into a reference. */
const reservedProperties: ReadonlySet<string> = new Set([
  "apply",
  "arguments",
  "bind",
  "call",
  "caller",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "length",
  "name",
  "prototype",
  "propertyIsEnumerable",
  "then",
  "toLocaleString",
  "toString",
  "valueOf"
])

const referenceName = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Wraps a declaration constructor so property access mints inert references.
 *
 * This is the one sanctioned Proxy in the authoring surface, and it exists
 * because `S.Agents` and `S.Flags` are both a constructor
 * (`S.Agents({ ... })` in the workspace tree) and a reference surface
 * (`S.Agents.luna` in a PACKAGE.ts) whose names are workspace-defined and
 * therefore cannot be precomputed. The Proxy never reaches target attrs: a
 * property access returns a fresh frozen plain record, so `Target.make`'s
 * attr walk — which rejects Proxies outright — only ever sees inert data.
 * Symbols, function-prototype names, and names outside the reference grammar
 * fall through to the underlying function untouched.
 *
 * @category constructors
 * @since 0.1.0
 */
export const callableReferences = <F extends object, R>(
  constructor: F,
  make: (name: string) => R
): F & Record<string, R> =>
  new Proxy(constructor, {
    get(target, property, receiver) {
      if (
        typeof property !== "string" ||
        reservedProperties.has(property) ||
        !referenceName.test(property) ||
        Object.prototype.hasOwnProperty.call(target, property)
      ) {
        return Reflect.get(target, property, receiver)
      }
      return make(property)
    }
  }) as F & Record<string, R>

/**
 * Schema for a required string payload input, `S.Input.String(description)`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InputString = Schema.TaggedStruct("InputString", {
  description: Schema.NonEmptyString
})

/**
 * A required string payload input.
 *
 * @category models
 * @since 0.1.0
 */
export type InputString = typeof InputString.Type

/**
 * Schema for an enumerated payload input, `S.Input.Literals([...])`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InputLiterals = Schema.TaggedStruct("InputLiterals", {
  values: Schema.Array(Schema.NonEmptyString)
})

/**
 * An enumerated payload input.
 *
 * @category models
 * @since 0.1.0
 */
export type InputLiterals = typeof InputLiterals.Type

/**
 * Schema for an optional payload input, `S.Input.Optional(inner)`.
 *
 * The inner declaration is a non-optional input spec; nesting Optional inside
 * Optional is meaningless and rejected by the union.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InputOptional = Schema.TaggedStruct("InputOptional", {
  inner: Schema.Union([InputString, InputLiterals])
})

/**
 * An optional payload input.
 *
 * @category models
 * @since 0.1.0
 */
export type InputOptional = typeof InputOptional.Type

/**
 * Schema for every payload input declaration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InputSpec = Schema.Union([InputString, InputLiterals, InputOptional])

/**
 * Every payload input declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type InputSpec = typeof InputSpec.Type

/**
 * Declares a required string payload input.
 *
 * @category constructors
 * @since 0.1.0
 */
export const inputString = (description: string): InputString =>
  Object.freeze(InputString.make({ description: boundedName(description, "Input.String description") }))

/**
 * Declares an enumerated payload input.
 *
 * @category constructors
 * @since 0.1.0
 */
export const inputLiterals = (values: ReadonlyArray<string>): InputLiterals =>
  Object.freeze(InputLiterals.make({ values: values.map((value) => boundedName(value, "Input.Literals value")) }))

/**
 * Declares an optional payload input wrapping a required one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const inputOptional = (inner: InputString | InputLiterals): InputOptional =>
  Object.freeze(InputOptional.make({ inner }))

/**
 * Maximum length of one target label reference.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumLabelLength = 512

/**
 * The shape of an exact target label: `//pkg/path:name` or `//:name`, the
 * one spelling that names exactly one target. Patterns (`//...`, a bare
 * `//pkg`) are not references; a declaration that wants one target says
 * which.
 *
 * @category constants
 * @since 1.0.0
 */
export const labelPattern =
  /^\/\/(?:(?!\.\.?(?:\/|:))[A-Za-z0-9._-]+(?:\/(?!\.\.?(?:\/|:))[A-Za-z0-9._-]+)*)?:[A-Za-z0-9._-]+$/

/**
 * Schema for an inert target label reference, `S.label("//:ci")`.
 *
 * A factory declaration in `.smithers/FACTORY.ts` never imports a
 * `PACKAGE.ts`; it names the targets it needs by label, and the index
 * resolves the reference against the registry when a field that takes one
 * is read.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Label = Schema.TaggedStruct("Label", {
  label: Schema.NonEmptyString.check(Schema.isMaxLength(maximumLabelLength), Schema.isPattern(labelPattern))
})

/**
 * An inert target label reference.
 *
 * @category models
 * @since 1.0.0
 */
export type Label = typeof Label.Type

/**
 * Declares a reference to exactly one target by its label.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const ci = S.label("//:ci")
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const label = (path: string): Label => {
  if (typeof path !== "string" || !path.isWellFormed()) throw new TypeError("label must be a well-formed string")
  if (path.length > maximumLabelLength || !labelPattern.test(path)) {
    throw new TypeError(`label must name exactly one target as //pkg:name or //:name: ${JSON.stringify(path)}`)
  }
  return Object.freeze(Label.make({ label: path }))
}
