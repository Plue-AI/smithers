/**
 * Cargo targets for workspace, package, and declared crate-set selections.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Compose from "./Compose.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * Schema for one `[package.metadata]` filter, `S.Cargo.AppSet({ metadata })`.
 *
 * The filter is matched as a subset of a manifest's own metadata table, so
 * `{ aomi: { skip: true } }` selects exactly the crates whose manifest sets
 * `[package.metadata.aomi] skip = true`. The key is the compile driver's
 * existing opt-out, not a new one: a crate set is a view over what the
 * manifests already say.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MetadataFilter = Schema.Record(Schema.String, Schema.Unknown)

/**
 * One `[package.metadata]` filter.
 *
 * @category models
 * @since 0.1.0
 */
export type MetadataFilter = typeof MetadataFilter.Type

/**
 * Schema for a declared crate set: an {@link AppSet} target, or a file-algebra
 * difference of two of them.
 *
 * A crate set settles to the same set type `S.ImportClosure` produces, which
 * is what lets `S.Files.difference` compose over it: subtracting the opted-out
 * crates from every crate is the same operator, one level up.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CrateSet = Schema.Union([Target.Target, Compose.FilesDifference])

/**
 * One declared crate set.
 *
 * @category models
 * @since 0.1.0
 */
export type CrateSet = typeof CrateSet.Type

/**
 * Which crates one planned cargo command runs over.
 *
 * The planner resolves a declaration's crate selector to one of these before
 * rendering argv: a whole workspace, one named package, or one crate's own
 * manifest. A crate-set declaration renders one command per member, so the
 * selection is per command, never per declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type CrateSelection =
  | { readonly _tag: "Workspace" }
  | { readonly _tag: "Package"; readonly name: string }
  | { readonly _tag: "Manifest"; readonly path: string }

/** The three ways a build-system cargo declaration may name its crates. */
const crateSelectors = ["workspace", "package", "crates"] as const

/** The crate-selector fields every build-system cargo rule shares. */
const selectorFields = {
  /** The whole cargo workspace: `--workspace`. */
  workspace: Schema.optional(Schema.Literal(true)),
  /** One named package: `-p <name>`. */
  package: Schema.optional(Schema.NonEmptyString),
  /** A crate set, one command per member: `--manifest-path <manifest>`. */
  crates: Schema.optional(CrateSet)
} as const

/** The edge and confinement fields every build-system cargo rule shares. */
const cargoShared = {
  data: Schema.optional(Attr.Data),
  env: Schema.optional(Attr.Env),
  sandbox: Schema.optional(Attr.Sandbox),
  /** The registry and git hosts the crates this target resolves download from. */
  destinations: Schema.optional(Attr.Destinations)
} as const

/** The dependency-resolution fields every cargo rule that resolves has. */
const resolutionFields = {
  /** Refuse to update the lockfile, so the result does not depend on when it ran. */
  locked: Schema.optional(Schema.Boolean),
  /** Resolve only from what the fetch resource already delivered. */
  offline: Schema.optional(Schema.Boolean)
} as const

/** The feature-selection fields the compiling rules share. */
const featureFields = {
  features: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  allFeatures: Schema.optional(Schema.Boolean)
} as const

/**
 * Attrs for {@link Fetch}: the one network-enabled cargo target.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FetchAttrs = Schema.Struct({
  /** The workspace manifest cargo resolves from. */
  workspace: Schema.optional(Input.File),
  /**
   * A crate set to lock instead of one workspace manifest.
   *
   * A repository whose crates are excluded from the root workspace has one
   * lockfile domain per crate, so one fetch over one manifest cannot deliver
   * what those crates resolve against. Naming the set locks each of them.
   */
  crates: Schema.optional(CrateSet),
  /** Files this resource delivers, workspace-anchored. */
  outFiles: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Directories this resource delivers; the first one becomes `CARGO_HOME`. */
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  ...cargoShared
})

/**
 * Attrs for {@link Fetch}.
 *
 * @category models
 * @since 0.1.0
 */
export type FetchAttrs = typeof FetchAttrs.Type

/**
 * Attrs for the build-system {@link Build}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  ...selectorFields,
  ...featureFields,
  ...resolutionFields,
  ...cargoShared,
  /** Named binary targets: `--bin <name>` apiece. */
  bins: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Library targets only: `--lib`. */
  lib: Schema.optional(Schema.Boolean),
  /** `"release"` renders `--release`; any other name renders `--profile <name>`. */
  profile: Schema.optional(Schema.NonEmptyString),
  /** Rust compilation target triple. */
  target: Schema.optional(Schema.NonEmptyString),
  /** Cross-compilation driver requested by the declaration. */
  container: Schema.optional(Schema.Literal("docker")),
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * Attrs for the build-system {@link Build}.
 *
 * @category models
 * @since 0.1.0
 */
export type BuildAttrs = typeof BuildAttrs.Type

/**
 * Attrs for the build-system {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PackageTestAttrs = Schema.Struct({
  ...selectorFields,
  ...featureFields,
  ...resolutionFields,
  ...cargoShared,
  bins: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  lib: Schema.optional(Schema.Boolean),
  /** Compile the tests without running them: `--no-run`. */
  noRun: Schema.optional(Schema.Boolean),
  gates: Schema.optional(Attr.Gates)
})

/**
 * Attrs for the build-system {@link Test}.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageTestAttrs = typeof PackageTestAttrs.Type

/**
 * Attrs for cargo-nextest over a workspace, package, or crate set.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NextestAttrs = PackageTestAttrs

/**
 * Attrs for cargo-deny.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DenyAttrs = Schema.Struct({
  config: Input.File,
  ...cargoShared
})

/**
 * Attrs for the build-system {@link Clippy}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PackageClippyAttrs = Schema.Struct({
  ...selectorFields,
  ...featureFields,
  ...resolutionFields,
  ...cargoShared,
  lib: Schema.optional(Schema.Boolean),
  allTargets: Schema.optional(Schema.Boolean),
  /** Promote every warning to an error, which is what makes clippy a gate. */
  denyWarnings: Schema.optional(Schema.Boolean)
})

/**
 * Attrs for the build-system {@link Clippy}.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageClippyAttrs = typeof PackageClippyAttrs.Type

/**
 * Attrs for the build-system {@link Fmt}.
 *
 * There is no `locked` or `offline` field: rustfmt reads sources and never
 * resolves a dependency, so it is the one cargo rule with no edge on the fetch
 * resource and nothing for those flags to mean.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FmtAttrs = Schema.Struct({
  workspace: Schema.optional(Schema.Literal(true)),
  crates: Schema.optional(CrateSet),
  ...cargoShared,
  /** The write set `--write`/`--fix` is confined to; check mode diffs instead. */
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** Optional rustup toolchain override, rendered as `cargo +<toolchain>`. */
  toolchain: Schema.optional(Schema.NonEmptyString)
})

/**
 * Attrs for the build-system {@link Fmt}.
 *
 * @category models
 * @since 0.1.0
 */
export type FmtAttrs = typeof FmtAttrs.Type

/**
 * Attrs for {@link Doc}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DocAttrs = Schema.Struct({
  ...selectorFields,
  ...featureFields,
  ...resolutionFields,
  ...cargoShared,
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/**
 * Attrs for {@link Doc}.
 *
 * @category models
 * @since 0.1.0
 */
export type DocAttrs = typeof DocAttrs.Type

/**
 * Attrs for {@link AppSet}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const AppSetAttrs = Schema.Struct({
  /** Manifest globs, resolved against the declaring PACKAGE.ts directory. */
  manifests: Schema.Union([Input.Glob, Schema.Array(Input.Glob)]),
  metadata: Schema.optional(MetadataFilter)
})

/**
 * Attrs for {@link AppSet}.
 *
 * @category models
 * @since 0.1.0
 */
export type AppSetAttrs = typeof AppSetAttrs.Type

/**
 * The rule id every build-system cargo target reports.
 *
 * @category constants
 * @since 0.1.0
 */
export const packageRules = [
  "Cargo.Fetch",
  "Cargo.Build",
  "Cargo.Test",
  "Cargo.Nextest",
  "Cargo.Clippy",
  "Cargo.Fmt",
  "Cargo.Doc",
  "Cargo.AppSet",
  "Cargo.Deny"
] as const

/**
 * One build-system cargo rule id.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageRule = (typeof packageRules)[number]

const optionalArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const selectionArgs = (selection: CrateSelection): ReadonlyArray<string> => {
  switch (selection._tag) {
    case "Workspace":
      return ["--workspace"]
    case "Package":
      return ["-p", selection.name]
    case "Manifest":
      return ["--manifest-path", selection.path]
  }
}

const featureArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> => {
  if (attrs["allFeatures"] === true) return ["--all-features"]
  const features = optionalArray(attrs["features"])
  return features.length === 0 ? [] : ["--features", features.join(",")]
}

const profileArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> => {
  const profile = attrs["profile"]
  if (typeof profile !== "string" || profile === "dev") return []
  return profile === "release" ? ["--release"] : ["--profile", profile]
}

const compilationTargetArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> =>
  typeof attrs["target"] === "string" ? ["--target", attrs["target"]] : []

const resolutionArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> => [
  ...(attrs["locked"] === true ? ["--locked"] : []),
  ...(attrs["offline"] === true ? ["--offline"] : [])
]

const targetArgs = (attrs: Record<string, unknown>): ReadonlyArray<string> => [
  ...(attrs["lib"] === true ? ["--lib"] : []),
  ...(attrs["allTargets"] === true ? ["--all-targets"] : []),
  ...optionalArray(attrs["bins"]).flatMap((bin) => ["--bin", bin])
]

/**
 * Renders the cargo arguments one planned command runs, without the
 * executable.
 *
 * The planner prepends the cargo path it resolved from the workspace toolchain
 * layer, so the executable is never in the declaration and never in this
 * rendering. Argument order is fixed here rather than at any call site, which
 * is what makes two declarations that say the same thing key the same.
 *
 * `mode` selects between the checking and applying forms of a rule that has
 * both: `Cargo.Fmt` renders `-- --check` in `check` mode and nothing in
 * `write` mode. Every other rule ignores it.
 *
 * @category rendering
 * @since 0.1.0
 */
export const packageArgs = (
  rule: string,
  attrs: unknown,
  selection: CrateSelection,
  mode: "check" | "write" | "execute" = "execute"
): ReadonlyArray<string> => {
  const values = (typeof attrs === "object" && attrs !== null ? attrs : {}) as Record<string, unknown>
  switch (rule) {
    case "Cargo.Fetch":
      // A fetch names one manifest or none; there is no `--workspace` for it.
      return ["fetch", ...(selection._tag === "Manifest" ? ["--manifest-path", selection.path] : [])]
    case "Cargo.Build":
      return [
        "build",
        ...selectionArgs(selection),
        ...targetArgs(values),
        ...featureArgs(values),
        ...profileArgs(values),
        ...compilationTargetArgs(values),
        ...resolutionArgs(values)
      ]
    case "Cargo.Test":
      return [
        "test",
        ...selectionArgs(selection),
        ...targetArgs(values),
        ...featureArgs(values),
        ...(values["noRun"] === true ? ["--no-run"] : []),
        ...resolutionArgs(values)
      ]
    case "Cargo.Nextest":
      return [
        "nextest",
        "run",
        ...selectionArgs(selection),
        ...targetArgs(values),
        ...featureArgs(values),
        ...(values["noRun"] === true ? ["--no-run"] : []),
        ...resolutionArgs(values)
      ]
    case "Cargo.Clippy":
      return [
        "clippy",
        ...selectionArgs(selection),
        ...targetArgs(values),
        ...featureArgs(values),
        ...resolutionArgs(values),
        // `-D warnings` is a rustc flag, so it goes after the separator:
        // passed before it, cargo reads it as one of its own and rejects it.
        ...(values["denyWarnings"] === true ? ["--", "-D", "warnings"] : [])
      ]
    case "Cargo.Fmt":
      return [
        ...(typeof values["toolchain"] === "string" ? [`+${values["toolchain"]}`] : []),
        "fmt",
        ...(selection._tag === "Manifest" ? ["--manifest-path", selection.path] : []),
        "--all",
        ...(mode === "write" ? [] : ["--", "--check"])
      ]
    case "Cargo.Doc":
      return ["doc", ...selectionArgs(selection), ...featureArgs(values), ...resolutionArgs(values)]
    case "Cargo.Deny":
      return ["deny", "--config", (values["config"] as Input.File).path, "check"]
    default:
      throw new Error(`${rule} is not a build-system cargo rule`)
  }
}

/**
 * The workspace-relative paths of the binaries one {@link Build} declaration
 * produces.
 *
 * A build that names its bins under a known profile produces known paths,
 * which is what lets another target take it as a tool edge
 * (`S.Shell.Build({ bin: sdk.buildCli })`). A build that names none produces
 * nothing addressable, and the planner refuses the tool edge by name rather
 * than guessing.
 *
 * @category accessors
 * @since 0.1.0
 */
export const binaries = (attrs: unknown): ReadonlyArray<string> => {
  const values = (typeof attrs === "object" && attrs !== null ? attrs : {}) as Record<string, unknown>
  const profile = typeof values["profile"] === "string" ? values["profile"] : "dev"
  const directory = profile === "dev" || profile === "test" ? "debug" : profile === "bench" ? "release" : profile
  const target = typeof values["target"] === "string" ? values["target"] : undefined
  const suffix = target === undefined
    ? process.platform === "win32" ? ".exe" : ""
    : /-windows(?:-|$)/.test(target)
    ? ".exe"
    : ""
  return optionalArray(values["bins"]).map((bin) =>
    `target/${target === undefined ? "" : `${target}/`}${directory}/${bin}${suffix}`
  )
}

/**
 * The `[package.metadata]` filter one {@link AppSet} declaration carries.
 *
 * @category accessors
 * @since 0.1.0
 */
export const appSetFilter = (attrs: unknown): MetadataFilter | undefined => {
  const values = (typeof attrs === "object" && attrs !== null ? attrs : {}) as Record<string, unknown>
  const metadata = values["metadata"]
  return typeof metadata === "object" && metadata !== null ? metadata as MetadataFilter : undefined
}

/**
 * Table nesting a metadata filter or a parsed manifest may reach.
 *
 * A manifest is not first-party content: crate-set expansion reads
 * `Cargo.toml` files under `vendor/` and git submodules. Bounding the walk
 * keeps a hostile manifest from turning a subset match into unbounded
 * recursion.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumMetadataDepth = 32

/**
 * Keys one metadata filter may compare, counted across the whole tree.
 *
 * The depth bound alone leaves a filter that is wide rather than deep
 * unbounded: 64 keys at each of 32 levels is one shallow declaration and
 * millions of comparisons against every manifest in a crate set. The budget is
 * spent per key compared, so both shapes are bounded by one number.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumMetadataMembers = 10_000

/**
 * Table keys a parsed manifest may never carry.
 *
 * `__proto__`, `constructor`, and `prototype` are the three keys that reach
 * `Object.prototype` through an ordinary property write. A manifest naming one
 * is refused rather than silently reshaped, because a reader that quietly
 * dropped it would report a metadata table the file does not describe.
 */
const reservedMetadataKeys = new Set(["__proto__", "constructor", "prototype"])

/**
 * Whether a manifest's metadata table satisfies a declared filter.
 *
 * The filter matches as a subset: every key it names must be present with the
 * same value, and keys it does not name are ignored. Nested tables recurse;
 * scalars compare by value.
 *
 * Both bounds are enforced, {@link maximumMetadataDepth} and
 * {@link maximumMetadataMembers}: a breach raises rather than returning
 * `false`, because a filter that outran its budget has not been evaluated and
 * reporting "no match" would silently drop crates from the set.
 *
 * @category matching
 * @since 0.1.0
 */
export const metadataMatches = (
  metadata: unknown,
  filter: unknown,
  depth = 0,
  budget: { count: number } = { count: 0 }
): boolean => {
  if (depth > maximumMetadataDepth) throw new RangeError("cargo metadata filter is too deep")
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return metadata === filter
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false
  const subject = metadata as Record<string, unknown>
  for (const [key, expected] of Object.entries(filter as Record<string, unknown>)) {
    budget.count += 1
    if (budget.count > maximumMetadataMembers) {
      throw new RangeError("cargo metadata filter compares more keys than the declaration bound")
    }
    // Own properties only: an inherited `toString` or `constructor` must never
    // satisfy a filter the manifest never declared.
    if (!Object.hasOwn(subject, key)) return false
    if (!metadataMatches(subject[key], expected, depth + 1, budget)) return false
  }
  return true
}

/**
 * The crate name and `[package.metadata]` table one `Cargo.toml` declares.
 *
 * This reads exactly the two things a crate set needs and nothing else: the
 * planner never resolves a dependency graph out of a manifest, and a manifest
 * feature this does not understand is ignored rather than guessed at. Table
 * headers, bare and quoted keys, and the scalar value forms TOML spells the
 * same way JSON does are read; arrays, inline tables, and multi-line strings
 * are skipped, because no crate-set decision has ever depended on one.
 *
 * @category parsing
 * @since 0.1.0
 */
export const manifestFacts = (
  text: string
): { readonly name: string | undefined; readonly metadata: Record<string, unknown> } => {
  let name: string | undefined
  const metadata: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let path: ReadonlyArray<string> | undefined
  const refuseReserved = (segment: string): void => {
    if (reservedMetadataKeys.has(segment)) {
      throw new Error(`Cargo.toml names the reserved key ${JSON.stringify(segment)} under [package.metadata]`)
    }
  }
  const unquote = (token: string): string =>
    (token.startsWith("\"") && token.endsWith("\"") && token.length >= 2) ||
      (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
      ? token.slice(1, -1)
      : token
  const splitHeader = (header: string): ReadonlyArray<string> => {
    const parts: Array<string> = []
    let current = ""
    let quote: string | undefined
    for (const character of header) {
      if (quote !== undefined) {
        if (character === quote) quote = undefined
        else current += character
        continue
      }
      if (character === "\"" || character === "'") {
        quote = character
        continue
      }
      if (character === ".") {
        parts.push(current.trim())
        current = ""
        continue
      }
      current += character
    }
    parts.push(current.trim())
    return parts
  }
  const scalar = (raw: string): unknown => {
    const token = raw.trim()
    if (token === "true") return true
    if (token === "false") return false
    if (/^-?\d+$/.test(token)) return Number(token)
    if (/^-?\d+\.\d+$/.test(token)) return Number(token)
    if (
      (token.startsWith("\"") && token.endsWith("\"") && token.length >= 2) ||
      (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
    ) return token.slice(1, -1)
    return undefined
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    if (line.startsWith("[")) {
      const end = line.indexOf("]")
      if (end === -1) continue
      // `[[array.of.tables]]` is not a table this reader models.
      path = line.startsWith("[[") ? undefined : splitHeader(line.slice(1, end))
      continue
    }
    const separator = line.indexOf("=")
    if (separator === -1 || path === undefined) continue
    const key = unquote(line.slice(0, separator).trim())
    // A `#` inside a quoted value is not a comment; strip only a trailing one.
    const rest = line.slice(separator + 1)
    const quoted = /^\s*(?:"[^"]*"|'[^']*')/.exec(rest)
    const value = scalar(quoted === null ? rest.split("#")[0]! : quoted[0])
    if (value === undefined) continue
    if (path.length === 1 && path[0] === "package" && key === "name" && typeof value === "string") {
      name = value
      continue
    }
    if (path.length < 3 || path[0] !== "package" || path[1] !== "metadata") continue
    if (path.length - 2 > maximumMetadataDepth) throw new RangeError("Cargo.toml metadata table is too deep")
    refuseReserved(key)
    let table = metadata
    for (const segment of path.slice(2)) {
      refuseReserved(segment)
      // Own properties only: a plain read would follow the prototype chain and
      // hand the walk an object it is about to write through.
      const existing = Object.hasOwn(table, segment) ? table[segment] : undefined
      if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        table = existing as Record<string, unknown>
      } else {
        const created: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        table[segment] = created
        table = created
      }
    }
    table[key] = value
  }
  return { name, metadata }
}

/**
 * Refuses a declaration that names more than one crate selector.
 *
 * `Cargo.Fetch` is the one rule that may name none — `cargo fetch` with no
 * `--manifest-path` resolves the manifest in the directory it runs from,
 * which is the workspace root every target spawns from — so it asks for at
 * most one rather than exactly one. Naming two would say two different things
 * about which lockfile domains the resource locks.
 */
const requireAtMostOneSelector = (id: string, attrs: unknown, selectors: ReadonlyArray<string>): void => {
  if (attrs === undefined) return
  if (typeof attrs !== "object" || attrs === null) throw new TypeError(`${id} attrs must be an object`)
  const values = attrs as Record<string, unknown>
  const present = selectors.filter((selector) => values[selector] !== undefined)
  if (present.length > 1) {
    throw new Error(`${id} requires at most one of ${selectors.join(", ")}; received ${present.join(", ")}`)
  }
}

const requireOneSelector = (id: string, attrs: unknown, selectors: ReadonlyArray<string>): void => {
  if (typeof attrs !== "object" || attrs === null) throw new TypeError(`${id} attrs must be an object`)
  const values = attrs as Record<string, unknown>
  const present = selectors.filter((selector) => values[selector] !== undefined)
  if (present.length !== 1) {
    throw new Error(
      `${id} requires exactly one of ${selectors.join(", ")}; received ${
        present.length === 0 ? "none" : present.join(", ")
      }`
    )
  }
  if (values["features"] !== undefined && values["allFeatures"] === true) {
    throw new Error(`${id} declares both features and allFeatures; cargo accepts one or the other`)
  }
}

const fetchDefinition = Target.make("Cargo.Fetch", {
  attrs: FetchAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Cargo.Fetch")
})

const buildDefinition = Target.make("Cargo.Build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Cargo.Build")
})

const packageTestDefinition = Target.make("Cargo.Test", {
  attrs: PackageTestAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Cargo.Test")
})

const nextestDefinition = Target.make("Cargo.Nextest", {
  attrs: NextestAttrs,
  kinds: ["test"],
  implementation: () => Target.notImplemented("Cargo.Nextest")
})

const denyDefinition = Target.make("Cargo.Deny", {
  attrs: DenyAttrs,
  kinds: ["lint"],
  implementation: () => Target.notImplemented("Cargo.Deny")
})

const packageClippyDefinition = Target.make("Cargo.Clippy", {
  attrs: PackageClippyAttrs,
  kinds: ["lint"],
  implementation: () => Target.notImplemented("Cargo.Clippy")
})

const packageFmtDefinition = Target.make("Cargo.Fmt", {
  attrs: FmtAttrs,
  kinds: ["lint"],
  implementation: () => Target.notImplemented("Cargo.Fmt")
})

const docDefinition = Target.make("Cargo.Doc", {
  attrs: DocAttrs,
  kinds: ["build", "docs"],
  implementation: () => Target.notImplemented("Cargo.Doc")
})

const appSetDefinition = Target.make("Cargo.AppSet", {
  attrs: AppSetAttrs,
  kinds: [],
  implementation: () => Target.notImplemented("Cargo.AppSet")
})

/**
 * The single network-enabled cargo target: `cargo fetch`.
 *
 * The lockfile and the vendored registry are declared deliverables, so every
 * other cargo target consumes them offline through a `data` edge on this one.
 * Its first declared `outDirs` entry is the `CARGO_HOME` the planner pins for
 * this target and for every dependent, which is what makes `--offline` mean
 * "read what the fetch delivered" rather than "read whatever the host has".
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const fetch = S.Cargo.Fetch({
 *   workspace: S.file("//Cargo.toml"),
 *   outFiles: ["//Cargo.lock"],
 *   outDirs: ["//.cargo-home"],
 *   sandbox: { network: true }
 * })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Fetch = Target.guard(
  fetchDefinition,
  (attrs) => requireAtMostOneSelector("Cargo.Fetch", attrs, ["workspace", "crates"])
)

/**
 * A `cargo build` over a workspace, one package, or a crate set.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = Target.guard(
  buildDefinition,
  (attrs) => requireOneSelector("Cargo.Build", attrs, crateSelectors)
)

/**
 * Runs cargo-nextest over the selected crates.
 *
 * @category targets
 * @since 0.1.0
 */
export const Nextest = Target.guard(
  nextestDefinition,
  (attrs) => requireOneSelector("Cargo.Nextest", attrs, crateSelectors)
)

/**
 * Runs cargo-deny against the declared policy.
 *
 * @category targets
 * @since 0.1.0
 */
export const Deny = denyDefinition

/**
 * A `cargo doc` build over a workspace, one package, or a crate set.
 *
 * @category targets
 * @since 0.1.0
 */
export const Doc = Target.guard(
  docDefinition,
  (attrs) => requireOneSelector("Cargo.Doc", attrs, crateSelectors)
)

/**
 * A crate set computed from manifest globs, filterable by
 * `[package.metadata]`.
 *
 * The set is a value, not a run: it participates in no verb and produces no
 * process. `S.Files.difference(all, skipped)` subtracts one set from another,
 * and the cargo rules take the result as their `crates` selector.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const allApps = S.Cargo.AppSet({ manifests: S.glob(["*\/Cargo.toml"]) })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const AppSet = appSetDefinition

/**
 * Checks whether a value is a declared crate set.
 *
 * @category guards
 * @since 0.1.0
 */
export const isAppSet = (value: unknown): value is Target.AnyTarget =>
  Target.isTarget(value) && Target.metadata(value).target === "Cargo.AppSet"

const fmtRule = (
  attrs: (typeof FmtAttrs)["~type.make.in"] & Target.Presentation
): ReturnType<typeof packageFmtDefinition> => {
  requireAtMostOneSelector("Cargo.Fmt", attrs, ["workspace", "crates"])
  return packageFmtDefinition(attrs)
}

/**
 * The `cargo fmt` gate checks by default and applies under `--write`/`--fix`,
 * confined to the declared `changes` write set. It is the one cargo rule with
 * no `locked`/`offline` attrs, because rustfmt never resolves a dependency.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const format = S.Cargo.Fmt({ workspace: true, data: [], changes: ["**\/*.rs"] })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Fmt = Target.rule(packageFmtDefinition, fmtRule)

const clippyRule = (
  attrs: (typeof PackageClippyAttrs)["~type.make.in"] & Target.Presentation
): ReturnType<typeof packageClippyDefinition> => {
  requireOneSelector("Cargo.Clippy", attrs, crateSelectors)
  return packageClippyDefinition(attrs)
}

/**
 * The `cargo clippy` gate for one declared crate selection.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const clippy = S.Cargo.Clippy({ workspace: true, lib: true, denyWarnings: true, locked: true })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Clippy = Target.rule(packageClippyDefinition, clippyRule)

const testRule = (
  attrs: (typeof PackageTestAttrs)["~type.make.in"] & Target.Presentation
): ReturnType<typeof packageTestDefinition> => {
  requireOneSelector("Cargo.Test", attrs, crateSelectors)
  return packageTestDefinition(attrs)
}

/**
 * The `cargo test` gate for one declared crate selection.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const test = S.Cargo.Test({ package: "aomi-sdk", locked: true, offline: true })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = Target.rule(packageTestDefinition, testRule)

/**
 * The crate selection one declaration fixes on its own, or undefined when the
 * planner has to expand a crate set to find it.
 *
 * `Cargo.Fetch` names its manifest as a declared file, so its selection is
 * that manifest; `workspace: true` and `package: "<name>"` are the two
 * selectors a declaration settles by itself.
 *
 * @category accessors
 * @since 0.1.0
 */
export const selectionOf = (attrs: unknown): CrateSelection | undefined => {
  const values = (typeof attrs === "object" && attrs !== null ? attrs : {}) as Record<string, unknown>
  const workspace = values["workspace"]
  if (workspace === true) return { _tag: "Workspace" }
  if (
    typeof workspace === "object" && workspace !== null &&
    (workspace as { readonly _tag?: unknown })._tag === "File" &&
    typeof (workspace as { readonly path?: unknown }).path === "string"
  ) return { _tag: "Manifest", path: (workspace as { readonly path: string }).path }
  if (typeof values["package"] === "string") return { _tag: "Package", name: values["package"] }
  return undefined
}
