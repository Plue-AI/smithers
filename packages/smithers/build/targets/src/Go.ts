/**
 * Go workspace toolchain, tools, package operands, and executable rules.
 *
 * @since 0.1.0
 */

/* eslint-disable jsdoc/require-description, jsdoc/no-restricted-syntax */
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Compose from "./Compose.ts"
import * as Input from "./Input.ts"
import * as Mise from "./Mise.ts"
import * as Reference from "./Reference.ts"
import * as Stamp from "./Stamp.ts"
import * as Target from "./Target.ts"
import * as WorkspaceToolchain from "./Toolchain.ts"

/** */
export interface ToolchainDeclaration extends WorkspaceToolchain.Declaration<"GoToolchain"> {
  readonly mod: Input.File
  readonly sum: Input.File
  readonly versions: WorkspaceToolchain.Declaration | Mise.Declaration
  readonly cgo: boolean | undefined
  readonly experiments: ReadonlyArray<string>
}

/** */
export const Toolchain = (options: {
  readonly mod: Input.File
  readonly sum: Input.File
  readonly versions: WorkspaceToolchain.Declaration | Mise.Declaration
  readonly cgo?: boolean | undefined
  readonly experiments?: ReadonlyArray<string> | undefined
}): ToolchainDeclaration => {
  if (typeof options !== "object" || options === null) throw new TypeError("Go.Toolchain options must be an object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!["mod", "sum", "versions", "cgo", "experiments"].includes(key)) {
      throw new TypeError(`Go.Toolchain received unknown option ${JSON.stringify(key)}`)
    }
  }
  if (options.mod?._tag !== "File" || options.sum?._tag !== "File") {
    throw new TypeError("Go.Toolchain mod and sum must be S.file declarations")
  }
  if (!WorkspaceToolchain.isDeclaration(options.versions) && !Mise.isDeclaration(options.versions)) {
    throw new TypeError("Go.Toolchain versions must be a toolchain declaration")
  }
  if (options.cgo !== undefined && typeof options.cgo !== "boolean") {
    throw new TypeError("Go.Toolchain cgo must be boolean")
  }
  if (
    options.experiments !== undefined &&
    !options.experiments.every((entry) => typeof entry === "string" && entry !== "")
  ) {
    throw new TypeError("Go.Toolchain experiments must be non-empty strings")
  }
  return WorkspaceToolchain.declare({
    _tag: "GoToolchain",
    mod: options.mod,
    sum: options.sum,
    versions: options.versions,
    cgo: options.cgo,
    experiments: Object.freeze([...(options.experiments ?? [])])
  })
}

/** */
export const bin = Reference.goBin
/** */
export const run = Reference.goRun

/** */
export const PackagesAttrs = Schema.Struct({ pkgs: Schema.Array(Schema.NonEmptyString) })
const packagesDefinition = Target.make("Go.Packages", {
  attrs: PackagesAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Go.Packages")
})
/** */
export const Packages = Target.rule(
  packagesDefinition,
  (
    attrs: (typeof PackagesAttrs)["~type.make.in"] & Target.Presentation
  ): Target.AnyTarget & { readonly files: Compose.TargetFiles } => Compose.attachFiles(packagesDefinition(attrs))
)

const packageSelection = Schema.Union([
  Schema.Array(Schema.NonEmptyString),
  Target.Target,
  Compose.FilesDifference
])
const stampValue = Schema.Union([
  Stamp.Value,
  Schema.String
])
/** */
export const StampMap = Schema.Record(Schema.String, stampValue)

const shared = {
  data: Schema.optional(Attr.Data),
  env: Schema.optional(Attr.Env),
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates),
  sandbox: Schema.optional(Attr.Sandbox),
  offline: Schema.optional(Schema.Boolean)
} as const

/** */
export const TestAttrs = Schema.Struct({
  ...shared,
  pkgs: packageSelection,
  runner: Schema.optional(Schema.Literals(["go", "gotestsum"])),
  timeout: Schema.optional(Schema.NonEmptyString),
  parallel: Schema.optional(Schema.Union([Schema.Number, Schema.Literal("cpus")]))
})
const testDefinition = Target.make("Go.Test", {
  attrs: TestAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Go.Test")
})
/** */
export const Test = testDefinition

/** */
export const BinaryAttrs = Schema.Struct({
  ...shared,
  pkg: Schema.NonEmptyString,
  out: Schema.NonEmptyString,
  goos: Schema.optional(Schema.NonEmptyString),
  goarch: Schema.optional(Schema.NonEmptyString),
  cgo: Schema.optional(Schema.Boolean),
  ldflags: Schema.optional(Schema.Array(Schema.String)),
  stamp: Schema.optional(StampMap)
})
// No `outputs` declaration: `DeclaredOutputs.cwd` is workspace-relative, and
// `out` may be package-relative (optimism's `out: "bin/cannon"` in //cannon),
// so a constructor that cannot see its own package directory cannot state the
// path. The planner does know it, and `GoExec.planRule` resolves `out` against
// the package to produce the target's real output directory.
const binaryDefinition = Target.make("Go.Binary", {
  attrs: BinaryAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Go.Binary")
})
/** */
export const Binary = binaryDefinition

/** */
export const ModDownloadAttrs = Schema.Struct({
  mod: Input.File,
  sum: Input.File,
  outDirs: Schema.Array(Schema.NonEmptyString),
  sandbox: Schema.optional(Attr.Sandbox)
})
const modDownloadDefinition = Target.make("Go.ModDownload", {
  attrs: ModDownloadAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Go.ModDownload")
})
/** */
export const ModDownload = modDownloadDefinition

/** */
export const LintAttrs = Schema.Struct({
  ...shared,
  config: Input.File,
  version: Schema.NonEmptyString,
  pkgs: Schema.Array(Schema.NonEmptyString),
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})
const lintDefinition = Target.make("Go.Lint", {
  attrs: LintAttrs,
  kinds: ["lint"],
  implementation: () => Target.notImplemented("Go.Lint")
})
/** */
export const Lint = lintDefinition

/** */
export const GenerateAttrs = Schema.Struct({
  ...shared,
  pkgs: packageSelection,
  tools: Schema.optional(Schema.Array(Reference.Tool)),
  changes: Schema.Array(Schema.NonEmptyString)
})
const generateDefinition = Target.make("Go.Generate", {
  attrs: GenerateAttrs,
  kinds: ["lint", "run"],
  implementation: () => Target.notImplemented("Go.Generate")
})
/** */
export const Generate = generateDefinition

/** */
export const FuzzAttrs = Schema.Struct({
  ...shared,
  fuzz: Schema.NonEmptyString,
  pkg: Schema.NonEmptyString,
  time: Schema.NonEmptyString,
  parallel: Schema.optional(Schema.Number)
})
const fuzzDefinition = Target.make("Go.Fuzz", {
  attrs: FuzzAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Go.Fuzz")
})
/** */
export const Fuzz = fuzzDefinition

/**
 * Renders the same linker flags `Go.Binary` links, as the one string a
 * Dockerfile's `LDFLAGS` build arg takes (`go build -ldflags="${LDFLAGS}"`).
 *
 * Each stamped variable becomes a `-X name=value` pair, which is the only
 * spelling the Go linker accepts. The value is a `Stamp.token`, not a
 * resolved stamp: the string is declaration data, so it must key without
 * reading git or the environment, and the executor substitutes the real
 * value immediately before spawn.
 */
export const ldflags = (
  options: { readonly strip?: boolean; readonly stamp?: Readonly<Record<string, Stamp.Value | string>> }
): string => {
  if (typeof options !== "object" || options === null) throw new TypeError("Go.ldflags options must be an object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "strip" && key !== "stamp") {
      throw new TypeError(`Go.ldflags received unknown option ${JSON.stringify(key)}`)
    }
  }
  const stamp = options.stamp === undefined ? {} : Schema.decodeUnknownSync(StampMap)(options.stamp)
  return [
    ...(options.strip === true ? ["-s", "-w"] : []),
    ...Object.entries(stamp).flatMap((
      [name, value]
    ) => ["-X", `${name}=${Stamp.token(name, value)}`])
  ].join(" ")
}
