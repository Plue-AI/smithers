/**
 * Workflow packs: a directory of flows with a manifest, a content address, and
 * a merge order.
 *
 * `Discovery` already answers "what flows are in this directory". A pack adds
 * the three things a shareable directory needs and a bare directory cannot
 * carry: a *name and version* so a descriptor can say where it came from, a
 * *content address* so a lock file can pin exactly the bytes that were
 * installed, and a *compatibility range* so a pack written against a newer
 * runtime is refused at load rather than halfway through a run.
 *
 * The old smithers verbs (`pack add | remove | list | update | eject`) are the
 * CLI half and are not here. This module is the runtime contract underneath
 * them. It holds one filesystem policy: every contributed source must remain
 * inside its pack root. Discovery checks descended directories and selected
 * entry files against that root when the host can resolve real paths.
 * Packs are third-party content, so callers cannot be trusted to have
 * validated manifest paths or symlink targets first.
 *
 * Precedence is `local` before `installed`, by name. That is the one rule the
 * old pack system had that a plain source list cannot express: two sources
 * merge first-found in scan order, so an installed pack listed first would win
 * a name a project pack defines. Here the origin decides, and the loser is
 * reported as a {@link module:Descriptor.DiscoveryWarning} naming both packs
 * rather than dropped silently.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { DiscoveryWarning, FlowDescriptor, Provenance, type Source } from "./Descriptor.ts"
import type { RegistryError } from "./RegistryError.ts"
import { registryError } from "./RegistryError.ts"

/**
 * Where a pack was installed from, and therefore which one wins a name.
 *
 * `local` is a pack the project owns: checked in, or linked into the working
 * tree. `installed` is one a package manager or `pack add` put there. A local
 * flow shadows an installed flow of the same name, never the other way round.
 *
 * @category models
 * @since 0.1.0
 */
export const Origin = Schema.Literals(["local", "installed"])

/**
 * Where a pack was installed from.
 *
 * @category models
 * @since 0.1.0
 */
export type Origin = typeof Origin.Type

/**
 * The runtime range a pack declares it needs.
 *
 * Only `smithers` is named. A pack is a set of flow declarations, and the one
 * thing that can make them unloadable is the runtime that reads them.
 *
 * @category models
 * @since 0.1.0
 */
export const Requires = Schema.Struct({ smithers: Schema.String })

/**
 * The runtime range a pack declares it needs.
 *
 * @category models
 * @since 0.1.0
 */
export type Requires = typeof Requires.Type

const isPackRelativePath = (value: string): boolean =>
  value.length > 0 &&
  !value.includes("\0") &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")

const PackRelativePath = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) => isPackRelativePath(value) || "must be a safe pack-relative path without traversal or empty segments",
    { title: "PackRelativePath" }
  )
)

const normalizePackRelativePath = (value: string): string => {
  if (!isPackRelativePath(value)) {
    throw new TypeError(`Pack path ${JSON.stringify(value)} is not a safe pack-relative path`)
  }
  return value
}

/**
 * A pack manifest, as it is written in `pack.json`.
 *
 * `flows` and `skills` are directory paths relative to the pack root, each
 * scanned exactly the way an ordinary registry source is. They are paths and
 * not flow names on purpose: a manifest that listed names would have to be
 * re-edited every time a flow was added, and the digest would then not change
 * when one was.
 *
 * @category models
 * @since 0.1.0
 */
export class Manifest extends Schema.Class<Manifest>("flows/registry/Pack/Manifest")({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  flows: Schema.Array(PackRelativePath),
  skills: Schema.optional(Schema.Array(PackRelativePath)),
  requires: Schema.optional(Requires)
}) {}

/**
 * One pack the host has decided to load, and where it came from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Installed {
  readonly manifest: Manifest
  /** The pack root. Every manifest path is resolved against it. */
  readonly dir: string
  readonly origin: Origin
  /**
   * The manifest diagnostics {@link read} produced, carried so a registry
   * built from this pack reports them from `registry.warnings()`. A host that
   * constructs an `Installed` by hand has none, so it is optional: spreading
   * `read`'s result and adding `origin` is what carries them across.
   */
  readonly warnings?: ReadonlyArray<DiscoveryWarning> | undefined
}

/**
 * One file's contribution to a pack's content address.
 *
 * @category models
 * @since 0.1.0
 */
export interface File {
  /** The path relative to the pack root, in the manifest's own vocabulary. */
  readonly path: string
  readonly contents: string
}

/** The manifest file every pack root carries. */
const manifestFileName = "pack.json"

const decodeManifest = Schema.decodeUnknownEffect(Manifest)

const manifestRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const unsafeManifestEntry = (
  value: unknown
): { readonly field: "flows" | "skills"; readonly entry: string } | undefined => {
  const record = manifestRecord(value)
  if (record === undefined) return undefined
  for (const field of ["flows", "skills"] as const) {
    const entries = record[field]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry === "string" && !isPackRelativePath(entry)) return { field, entry }
    }
  }
  return undefined
}

const knownManifestKeys = new Set(["name", "version", "flows", "skills", "requires"])

/**
 * Reads and decodes one pack's manifest.
 *
 * A pack whose manifest is missing, unparseable, or incomplete fails
 * `RegistryError { code: "invalid_pack" }` here rather than producing a
 * half-loaded registry: the manifest is what names the pack in every
 * descriptor's provenance, so there is nothing useful to do without it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const read = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string
): Effect.Effect<
  {
    readonly manifest: Manifest
    readonly dir: string
    readonly warnings: ReadonlyArray<DiscoveryWarning>
  },
  RegistryError
> =>
  Effect.gen(function*() {
    const location = path.join(dir, manifestFileName)
    const invalid = (description: string, cause?: unknown) =>
      registryError({
        code: "invalid_pack",
        module: "Pack",
        method: "read",
        path: location,
        description,
        cause
      })
    const text = yield* fs.readFileString(location).pipe(
      Effect.mapError((cause) => invalid(`the pack manifest at "${location}" could not be read`, cause))
    )
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => invalid(`the pack manifest at "${location}" is not valid JSON`, cause)
    })
    const unsafe = unsafeManifestEntry(parsed)
    if (unsafe !== undefined) {
      return yield* Effect.fail(
        invalid(
          `the pack manifest at "${location}" contains unsafe ${unsafe.field} entry ${JSON.stringify(unsafe.entry)}`
        )
      )
    }
    const manifest = yield* decodeManifest(parsed).pipe(
      Effect.mapError((cause) => invalid(`the pack manifest at "${location}" is not a valid manifest`, cause))
    )
    const warnings = Object.keys(parsed as Record<string, unknown>).flatMap((key) =>
      knownManifestKeys.has(key)
        ? []
        : [
          new DiscoveryWarning({
            code: "unknown_pack_key",
            path: location,
            message: `Unknown pack manifest key: ${key}`
          })
        ]
    )
    return { manifest, dir, warnings }
  })

/**
 * The content address of one pack, as a lock file records it.
 *
 * The digest covers the manifest and every file measured by the CLI pack
 * verbs, each by its own content hash under a validated pack-relative path.
 * File contents are UTF-8 text; measuring binary resources is outside this
 * contract. Unsafe paths throw a `TypeError`. Duplicate paths are retained and
 * ordered by their content digest, so no input ordering can change the result.
 * Two installs of the same bytes therefore produce the same digest whatever
 * order the files were read in, and editing one flow body changes it.
 *
 * @category identity
 * @since 0.1.0
 */
export const digest = (manifest: Manifest, files: ReadonlyArray<File>): string => {
  const measured = files
    .map((file) => ({
      path: normalizePackRelativePath(file.path),
      contents: Digest.digest(file.contents)
    }))
    .sort((left, right) => {
      const pathOrder = left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      return pathOrder !== 0
        ? pathOrder
        : left.contents < right.contents
        ? -1
        : left.contents > right.contents
        ? 1
        : 0
    })
  return Digest.digest(
    Digest.canonical({
      name: manifest.name,
      version: manifest.version,
      flows: [...manifest.flows],
      skills: manifest.skills === undefined ? [] : [...manifest.skills],
      requires: manifest.requires === undefined ? null : { smithers: manifest.requires.smithers },
      files: measured
    })
  )
}

interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

/**
 * Reads one to three numeric version components, zero-filling omitted
 * components and ignoring any prerelease or build suffix.
 *
 * A pack's compatibility question is about the release line, and this runtime
 * ships as `1.0.0-rc.N`. Comparing the prerelease tag as well would refuse
 * every release candidate from a range written against its own release, which
 * is the opposite of what the range means.
 */
const parseVersion = (value: string): Version | undefined => {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) }
}

const compare = (left: Version, right: Version): number =>
  left.major !== right.major
    ? left.major - right.major
    : left.minor !== right.minor
    ? left.minor - right.minor
    : left.patch - right.patch

type Operator = ">=" | "<=" | ">" | "<" | "=" | "^" | "~"

interface Comparator {
  readonly operator: Operator | undefined
  readonly bound: Version
}

const satisfiesComparator = (comparator: Comparator, version: Version): boolean => {
  const order = compare(version, comparator.bound)
  switch (comparator.operator) {
    case ">=":
      return order >= 0
    case "<=":
      return order <= 0
    case ">":
      return order > 0
    case "<":
      return order < 0
    case "^":
      // Caret allows anything up to the next bump of the LEFT-MOST NON-ZERO
      // field, which is the major only on a released line. On `0.x` the minor
      // is that field and on `0.0.x` the patch is, because a pre-1.0 line
      // makes no compatibility promise across them: `^0.2.3` is
      // `>=0.2.3 <0.3.0` and `^0.0.3` is `>=0.0.3 <0.0.4`. Pinning only the
      // major there would load a pack written for 0.2 against 0.9.
      return order >= 0 && version.major === comparator.bound.major &&
        (comparator.bound.major !== 0 ||
          (version.minor === comparator.bound.minor &&
            (comparator.bound.minor !== 0 || version.patch === comparator.bound.patch)))
    case "~":
      return order >= 0 && version.major === comparator.bound.major && version.minor === comparator.bound.minor
    default:
      // A bare version and an explicit `=` mean the same thing.
      return order === 0
  }
}

const versionPattern = "\\d+(?:\\.\\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?"
const hyphenRangePattern = new RegExp(`^(${versionPattern})\\s+-\\s+(${versionPattern})$`)
const comparatorPattern = new RegExp(`^(>=|<=|>|<|=|\\^|~)?\\s*(${versionPattern})(?=\\s|$)`)

const parseRange = (range: string): ReadonlyArray<Comparator> | undefined => {
  const trimmed = range.trim()
  if (trimmed === "") return undefined
  if (trimmed === "*") return []

  const hyphen = hyphenRangePattern.exec(trimmed)
  if (hyphen !== null) {
    const lower = parseVersion(hyphen[1]!)!
    const upper = parseVersion(hyphen[2]!)!
    return [{ operator: ">=", bound: lower }, { operator: "<=", bound: upper }]
  }

  const comparators: Array<Comparator> = []
  let remaining = trimmed
  while (remaining !== "") {
    const match = comparatorPattern.exec(remaining)
    if (match === null) return undefined
    const bound = parseVersion(match[2]!)!
    comparators.push({ operator: match[1] as Operator | undefined, bound })
    remaining = remaining.slice(match[0].length).trimStart()
  }
  return comparators
}

const satisfiesRange = (range: ReadonlyArray<Comparator>, version: Version): boolean =>
  range.every((comparator) => satisfiesComparator(comparator, version))

/**
 * Whether a runtime version satisfies a pack's declared range.
 *
 * The supported grammar is `*`, inclusive hyphen ranges, and whitespace-
 * separated conjunctions of bare, `=`, `>=`, `>`, `<=`, `<`, `^`, and `~`
 * comparators. Whitespace may separate an operator from its version. Versions
 * have one to three numeric components and omitted components are zero-filled.
 * `x`, `*` components, and `||` unions are unreadable; only a standalone `*`
 * is accepted. An unreadable range returns false rather than being guessed.
 *
 * @category refinements
 * @since 0.1.0
 */
export const compatible = (range: string, runtimeVersion: string): boolean => {
  const version = parseVersion(runtimeVersion)
  const parsed = parseRange(range)
  return version !== undefined && parsed !== undefined && satisfiesRange(parsed, version)
}

/**
 * The registry sources one pack contributes, in manifest order.
 *
 * Every path in `flows` and `skills` becomes a confined source rooted inside
 * the pack, so a pack is discovered by exactly the pipeline a project
 * directory is. Lexical containment is always enforced. When the pack root's
 * real path resolves, a source must resolve inside it or not exist yet; any
 * other `realPath` failure is refused. Hosts that cannot resolve the root use
 * the lexical verdict. `confinementRoot` carries the pack root into discovery so descended
 * directories and selected entry files receive the same real-path check.
 * This defense is repeated because callers may construct `Installed`
 * values without decoding a manifest. `source` carries the pack name, which
 * is what a `DiscoveryWarning` about a pack file reads back.
 *
 * @category conversions
 * @since 0.1.0
 */
export const sources = (
  pack: Installed,
  path: Path.Path
): Effect.Effect<ReadonlyArray<Source>, RegistryError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = path.resolve(pack.dir)
    const location = path.join(pack.dir, manifestFileName)
    const invalid = (entry: string) =>
      registryError({
        code: "invalid_pack",
        module: "Pack",
        method: "sources",
        path: location,
        description:
          `pack "${pack.manifest.name}@${pack.manifest.version}" at "${location}" declares unsafe source entry ${
            JSON.stringify(entry)
          }`
      })
    const contains = (parent: string, candidate: string): boolean => {
      const resolvedParent = path.resolve(parent)
      const resolvedCandidate = path.resolve(candidate)
      const prefix = path.join(resolvedParent, path.sep)
      return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(prefix)
    }
    const output: Array<Source> = []
    for (const relative of [...pack.manifest.flows, ...(pack.manifest.skills ?? [])]) {
      if (!isPackRelativePath(relative)) return yield* Effect.fail(invalid(relative))
      const sourcePath = path.resolve(pack.dir, relative)
      if (!contains(root, sourcePath)) return yield* Effect.fail(invalid(relative))

      const [realRoot, realSource] = yield* Effect.all([
        Effect.result(fs.realPath(root)),
        Effect.result(fs.realPath(sourcePath))
      ])
      // A root that will not resolve means the host cannot answer `realPath`,
      // so the lexical verdict stands. Once it resolves, a source must either
      // resolve inside it or not exist yet; any other failure (a looping or
      // unreadable link) is refused rather than trusted lexically.
      if (Result.isSuccess(realRoot)) {
        if (Result.isSuccess(realSource)) {
          if (!contains(realRoot.success, realSource.success)) return yield* Effect.fail(invalid(relative))
        } else if (realSource.failure.reason._tag !== "NotFound") {
          return yield* Effect.fail(invalid(relative))
        }
      }
      output.push({
        source: `pack:${pack.manifest.name}`,
        root: sourcePath,
        confinementRoot: root,
        naming: "path"
      })
    }
    return output
  })

/**
 * Stamps a descriptor with the pack it was discovered in.
 *
 * @category conversions
 * @since 0.1.0
 */
export const attribute = (descriptor: FlowDescriptor, pack: Installed): FlowDescriptor =>
  new FlowDescriptor({
    ...descriptor,
    provenance: new Provenance({
      source: descriptor.provenance.source,
      root: descriptor.provenance.root,
      pack: { name: pack.manifest.name, version: pack.manifest.version, origin: pack.origin }
    })
  })

/** How a pack is named in a shadowing warning. */
const label = (pack: Installed): string => `${pack.manifest.name}@${pack.manifest.version} (${pack.origin})`

/** Local packs first, each group keeping the caller's own order. */
const ordered = <A extends { readonly pack: Installed }>(scans: ReadonlyArray<A>): ReadonlyArray<A> => [
  ...scans.filter((scan) => scan.pack.origin === "local"),
  ...scans.filter((scan) => scan.pack.origin === "installed")
]

/**
 * One pack's scan, ready to merge.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scan {
  readonly pack: Installed
  readonly entries: ReadonlyArray<FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}

/**
 * Merges scanned packs into one descriptor set, local packs first.
 *
 * A name defined by more than one pack keeps the highest-precedence
 * definition and reports a `shadowed` warning naming both packs, so an
 * operator can see which pack lost and why rather than discovering it from a
 * flow that behaves unexpectedly.
 *
 * @category combinators
 * @since 0.1.0
 */
export const merge = (
  scans: ReadonlyArray<Scan>
): {
  readonly entries: ReadonlyArray<FlowDescriptor>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
} => {
  const kept = new Map<string, { readonly descriptor: FlowDescriptor; readonly pack: Installed }>()
  const entries: Array<FlowDescriptor> = []
  const warnings: Array<DiscoveryWarning> = []
  for (const scan of ordered(scans)) {
    warnings.push(...scan.warnings)
    for (const entry of scan.entries) {
      const attributed = attribute(entry, scan.pack)
      const existing = kept.get(entry.name)
      if (existing !== undefined) {
        warnings.push(
          new DiscoveryWarning({
            code: "shadowed",
            path: entry.path,
            name: entry.name,
            message: `Flow "${entry.name}" from ${label(existing.pack)} shadows the one from ${
              label(scan.pack)
            }; the shadowed definition is not loaded`
          })
        )
        continue
      }
      kept.set(entry.name, { descriptor: attributed, pack: scan.pack })
      entries.push(attributed)
    }
  }
  return { entries, warnings }
}

/**
 * Refuses a pack whose declared runtime range this runtime does not satisfy.
 * The grammar is the one documented by {@link compatible}. An unreadable
 * declaration fails `unreadable_pack_range`; a readable but unsatisfied one
 * fails `incompatible_pack`. The manifest path a failure names is spelled by
 * the caller's `Path` service, which is the one {@link read} and
 * {@link sources} already use.
 *
 * @category refinements
 * @since 0.1.0
 */
export const checkCompatible = (
  pack: Installed,
  path: Path.Path,
  runtimeVersion: string
): Effect.Effect<void, RegistryError> => {
  if (pack.manifest.requires === undefined) return Effect.void
  const range = pack.manifest.requires.smithers
  const parsed = parseRange(range)
  const location = path.join(pack.dir, manifestFileName)
  if (parsed === undefined) {
    return Effect.fail(
      registryError({
        code: "unreadable_pack_range",
        module: "Pack",
        method: "checkCompatible",
        path: location,
        description: `pack "${pack.manifest.name}@${pack.manifest.version}" requires smithers range ${
          JSON.stringify(range)
        }, which could not be parsed`
      })
    )
  }
  const version = parseVersion(runtimeVersion)
  return version !== undefined && satisfiesRange(parsed, version)
    ? Effect.void
    : Effect.fail(
      registryError({
        code: "incompatible_pack",
        module: "Pack",
        method: "checkCompatible",
        path: location,
        description:
          `pack "${pack.manifest.name}@${pack.manifest.version}" requires smithers ${range}, and this runtime is ${runtimeVersion}`
      })
    )
}
