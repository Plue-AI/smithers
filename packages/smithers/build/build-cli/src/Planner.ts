/**
 * Target graph planning and content cache keys.
 *
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Target from "@smthrs/targets/Target"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { createHash } from "node:crypto"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import * as NodeUtil from "node:util/types"
import { byCodeUnit } from "./internal/Text.ts"
import type * as Workspace from "./Workspace.ts"

/**
 * One direct target dependency edge.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Edge {
  readonly from: string
  readonly to: string
}

/**
 * The four cache-key material fields defined by the Smithers step-key law.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface KeyMaterial {
  readonly body: unknown
  readonly inputs: unknown
  readonly layers: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
}

/**
 * One target in dependency-first plan order.
 *
 * `attrs` are the verb-effective attrs from `Target.Metadata.forKind`: what the
 * executor passes to the target Flow. A generator target maps the `lint` verb
 * to its drift-check form here, so its key material, declared inputs, and
 * cacheability differ between `build` and `lint` plans.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface PlannedTarget {
  readonly label: string
  readonly target: string
  readonly kinds: ReadonlyArray<Target.Kind>
  readonly attrs: unknown
  readonly dependencies: ReadonlyArray<string>
  readonly declaredInputs: ReadonlyArray<Workspace.ExpandedInput>
  /**
   * The target's declared output roots for the verb being planned, or undefined
   * for a target that declares none. It is target metadata, never a value read back
   * out of attrs, so a cached entry cannot choose which paths get verified.
   */
  readonly declaredOutputs: Target.DeclaredOutputs | undefined
  readonly cacheable: boolean
  readonly cacheLookup: "not-wired"
  readonly wouldRun: true
  readonly keyMaterial: KeyMaterial
  readonly keyPreview: string
  /**
   * The resolved Nix environment the target's tools run from, when its
   * package declares one and the verb executes. The store hash is already
   * in `keyMaterial.layers` as `nix:<hash>`; `closure` is every store path
   * the environment references, so a sandbox can bind-mount exactly the
   * toolchain the key names as its read set.
   */
  readonly nixEnvironment?: PlannedEnvironment | undefined
}

/**
 * The resolved Nix environment recorded on a planned target.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlannedEnvironment {
  readonly storePath: string
  readonly hash: string
  readonly closure: ReadonlyArray<string>
  readonly path: ReadonlyArray<string>
  readonly variables: Readonly<Record<string, string>>
}

/**
 * A complete inert target plan.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Plan {
  readonly verb: Target.Kind | "graph" | "query"
  readonly pattern: string
  readonly roots: ReadonlyArray<string>
  readonly targets: ReadonlyArray<PlannedTarget>
  readonly edges: ReadonlyArray<Edge>
  readonly warnings: ReadonlyArray<string>
}

/**
 * Global cache-key salt for executor semantics.
 *
 * Increment this integer whenever execution or cache-admission semantics
 * change without otherwise changing target key material. Bumped to 3 when key
 * encoding became type tagged and injective and cache admission started
 * enforcing target identity, exact declared outputs, and input revalidation.
 * Version 5 removes timing from semantic exec results, narrows inherited tool
 * environments, and makes custom targets non-cacheable unless they opt in.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export const EXECUTION_FORMAT = 5

/**
 * Orders strings by UTF-16 code unit. `localeCompare` answers differently
 * under different host locales and ICU versions, which would let one target
 * hash to different cache keys on different machines; code-unit order is the
 * same everywhere.
 */

/**
 * One value in key material could not be encoded injectively.
 *
 * The encoder never guesses. Material it cannot represent without losing the
 * distinction between two different values fails the plan, because a key that
 * two different actions can share is worse than no key at all.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class KeyMaterialError extends Data.TaggedError("smithers-build/KeyMaterialError")<{
  readonly path: string
  readonly message: string
}> {
  constructor(path: string, reason: string) {
    super({ path, message: `cache key material at ${path === "" ? "the root" : path} ${reason}` })
  }
}

/**
 * An exact target exists but does not participate in the requested verb.
 *
 * `ci` uses this type to ignore only the expected per-verb refusal while it
 * merges the other verb plans. Matching error text would also swallow an
 * unrelated planner or filesystem failure that happened to contain the same
 * words.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class UnsupportedVerbError extends Data.TaggedError("smithers-build/UnsupportedVerbError")<{
  readonly pattern: string
  readonly verb: Target.Kind
  readonly message: string
}> {
  constructor(pattern: string, verb: Target.Kind) {
    super({ pattern, verb, message: `target selected by ${pattern} does not support the ${verb} verb` })
  }
}

/** Renders a traversal step for a {@link KeyMaterialError} path. */
const step = (path: string, key: string): string => path === "" ? key : `${path}.${key}`

/** Refuses text whose UTF-8 encoding would replace an unpaired surrogate. */
const assertWellFormed = (value: string, path: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        continue
      }
      throw new KeyMaterialError(path, "contains an unpaired UTF-16 surrogate")
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new KeyMaterialError(path, "contains an unpaired UTF-16 surrogate")
    }
  }
}

/** Reads reflective object state without letting a hostile proxy escape as an arbitrary defect. */
const reflect = <A>(path: string, operation: () => A): A => {
  try {
    return operation()
  } catch {
    throw new KeyMaterialError(path, "could not be inspected without executing hostile object behavior")
  }
}

/**
 * Appends the type-tagged encoding of one value.
 *
 * Every form carries a distinct leading tag and every variable-length form
 * carries its own length, so the encoding is injective: no two distinct values
 * can produce the same byte string, and no value can be forged to look like
 * another by embedding a separator. `JSON.stringify` fails all three tests at
 * once — it maps `undefined`, `NaN`, and `Infinity` onto `null` inside
 * containers, drops undefined object members entirely, and renders a string
 * that can be made to look like a nested structure.
 *
 * Anything the encoding cannot represent exactly fails closed: a cycle, a
 * non-finite number, a bigint, a symbol, a function, an accessor property, a
 * non-enumerable or symbol-keyed own property, a sparse array, and any object
 * whose prototype is neither `Object.prototype` nor null (a `Date`, a `Map`, a
 * class instance) are all refused rather than flattened into something that
 * collides with a legitimate value.
 */
const encode = (value: unknown, out: Array<string>, seen: Set<object>, path: string): void => {
  if (value === undefined) return void out.push("u")
  if (value === null) return void out.push("n")
  switch (typeof value) {
    case "boolean":
      return void out.push(value ? "t" : "f")
    case "number": {
      if (!Number.isFinite(value)) throw new KeyMaterialError(path, `is the non-finite number ${String(value)}`)
      // Object.is separates -0 from 0; String renders them identically.
      return void out.push(`d${Object.is(value, -0) ? "-0" : String(value)};`)
    }
    case "string":
      assertWellFormed(value, path)
      return void out.push(`s${value.length}:${value}`)
    case "bigint":
      throw new KeyMaterialError(path, "is a bigint, which has no stable encoding here")
    case "symbol":
      throw new KeyMaterialError(path, "is a symbol")
    case "function":
      throw new KeyMaterialError(path, "is a function")
    case "object":
      break
    default:
      throw new KeyMaterialError(path, `is an unsupported ${typeof value} value`)
  }
  const object = value
  if (NodeUtil.isProxy(object)) throw new KeyMaterialError(path, "is a Proxy")
  if (seen.has(object)) throw new KeyMaterialError(path, "closes a reference cycle")
  const prototype = reflect(path, () => Object.getPrototypeOf(object))
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      if (prototype !== Array.prototype) throw new KeyMaterialError(path, "is an array subclass instance")
      const names = reflect(path, () => Object.getOwnPropertyNames(object))
      if (names.length !== object.length + 1 || names.at(-1) !== "length") {
        throw new KeyMaterialError(path, "is a sparse array or carries extra own properties")
      }
      if (reflect(path, () => Object.getOwnPropertySymbols(object)).length > 0) {
        throw new KeyMaterialError(path, "carries symbol-keyed own properties")
      }
      out.push(`a${object.length}:`)
      for (let index = 0; index < object.length; index += 1) {
        const memberPath = step(path, String(index))
        if (names[index] !== String(index)) {
          throw new KeyMaterialError(path, "is a sparse array or carries extra own properties")
        }
        const descriptor = reflect(memberPath, () => Object.getOwnPropertyDescriptor(object, String(index)))
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new KeyMaterialError(memberPath, "is an accessor property")
        }
        encode(descriptor.value, out, seen, memberPath)
      }
      return
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new KeyMaterialError(path, "is an object whose prototype is not a plain object")
    }
    if (reflect(path, () => Object.getOwnPropertySymbols(object)).length > 0) {
      throw new KeyMaterialError(path, "carries symbol-keyed own properties")
    }
    const keys = reflect(path, () => Object.getOwnPropertyNames(object))
    out.push(`o${keys.length}:`)
    for (const key of [...keys].sort(byCodeUnit)) {
      assertWellFormed(key, step(path, key))
      const descriptor = reflect(step(path, key), () => Object.getOwnPropertyDescriptor(object, key))
      if (descriptor === undefined || descriptor.enumerable !== true) {
        throw new KeyMaterialError(step(path, key), "is a non-enumerable own property")
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new KeyMaterialError(step(path, key), "is an accessor property")
      }
      out.push(`s${key.length}:${key}`)
      encode(descriptor.value, out, seen, step(path, key))
    }
  } finally {
    // Removing on the way out keeps a value that legitimately appears twice in
    // a tree from being reported as a cycle.
    seen.delete(object)
  }
}

/**
 * Encodes key material into the injective byte string {@link keyOf} hashes.
 *
 * Exported so the encoding itself stays directly testable.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export const encodeKeyMaterial = (material: KeyMaterial): string => {
  const out: Array<string> = ["smithers-build-key/1\u0000"]
  encode(
    {
      body: material.body,
      capabilities: material.capabilities,
      inputs: material.inputs,
      layers: material.layers
    },
    out,
    new Set(),
    ""
  )
  return out.join("")
}

/**
 * Hashes key material into the sha256 content key an executor caches on.
 *
 * The encoding is type tagged, length delimited, and injective, and object
 * keys sort by code unit, so equal material always hashes to the same key on
 * every host while values of different types never collide. Material the
 * encoding cannot represent exactly raises a {@link KeyMaterialError} rather
 * than hashing an approximation of it.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export const keyOf = (material: KeyMaterial): string =>
  createHash("sha256").update(encodeKeyMaterial(material), "utf8").digest("hex")

/**
 * Builds the persistent body identity for one target.
 *
 * `Target.Metadata.implementationDigest` is deliberately absent. It contains
 * process-local entropy for ordinary closures, so persisting it makes equal
 * declarations miss across processes. The ambient implementation fingerprint
 * covers the shipped source bytes that implement every catalog target.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export const targetKeyBody = (
  target: Target.AnyTarget,
  metadata: Target.Metadata,
  outputs: Target.DeclaredOutputs | undefined
): unknown => ({
  flow: target._tag,
  target: metadata.target,
  schemas: metadata.schemaIdentity,
  outputs: outputs === undefined ? null : { cwd: outputs.cwd, paths: [...outputs.paths] },
  executionFormat: EXECUTION_FORMAT
})

/**
 * One source tree that contributes to the implementation fingerprint.
 *
 * `name` is the logical prefix recorded in the digest. `directory` is the host
 * path the bytes are read from and never reaches the digest.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export interface SourceRoot {
  readonly name: string
  readonly directory: string
}

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]

const skippedSourceDirectories = new Set(["node_modules", "dist", ".git"])

/** Hard work limits for one implementation-source fingerprint. */
const maximumSourceFiles = 100_000
const maximumSourceDirectories = 50_000
const maximumSourceEntries = 1_000_000
const maximumSourceDepth = 128
/**
 * Maximum bytes admitted from one implementation source file.
 *
 * @category limits
 * @since 0.1.0
 * @slop
 */
export const maximumSourceFileBytes = 16 * 1024 * 1024
const maximumSourceRootBytes = 512 * 1024 * 1024
const maximumImplementationBytes = 1024 * 1024 * 1024

/**
 * How many implementation source files are stat-ed and digested at once.
 *
 * Every file costs a confined `resolveFile` plus a streamed `digestFile`, and
 * both are latency-bound rather than CPU-bound: measured over the fifteen
 * production source roots, one-at-a-time digesting spends ~25 ms per file and
 * ~28 s in total, while eight in flight finishes the same bytes in ~4 s.
 * Sixteen measured no faster, so the pool stays small enough to leave a CI
 * host's file descriptors and disk queue to the rest of the run.
 */
const sourceDigestConcurrency = 8

interface SourceDigest {
  readonly path: string
  readonly digest: string
  readonly size: number
}

interface SourceCandidate {
  readonly path: string
  readonly absolute: string
}

interface AdmittedSource {
  readonly candidate: SourceCandidate
  /** The exact regular-file entry whose size passed the root admission pass. */
  readonly entry: SafeFs.Entry
  readonly size: number
}

interface SourceListing {
  readonly root: string
  readonly sources: ReadonlyArray<AdmittedSource>
}

type SourceMeasurement =
  | {
    readonly _tag: "measured"
    readonly entry: SafeFs.Entry | undefined
    readonly digest: string | undefined
    readonly size: number
  }
  | { readonly _tag: "failed"; readonly cause: unknown }

/**
 * Resolves one candidate under the same confinement the serial walk used.
 * Its own size cap is enforced before any byte is read, and a file that
 * vanished between the listing and the inspection reports an absent entry
 * rather than throwing here.
 */
const inspectSource = async (
  candidate: SourceCandidate,
  root: string,
  signal: AbortSignal | undefined
): Promise<Omit<Extract<SourceMeasurement, { _tag: "measured" }>, "digest">> => {
  signal?.throwIfAborted()
  const resolved = await SafeFs.resolveFile(candidate.absolute, {
    root,
    signal,
    symlinks: "reject",
    what: "implementation source file"
  })
  if (resolved === undefined) return { _tag: "measured", entry: undefined, size: 0 }
  const size = Number(resolved.stats.size)
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumSourceFileBytes) {
    throw new Error(
      `implementation source file is larger than ${maximumSourceFileBytes} bytes: ${candidate.absolute}`
    )
  }
  return { _tag: "measured", entry: resolved, size }
}

/** Digests the exact entry whose confined size passed the admission pass. */
const digestSource = async (
  source: AdmittedSource,
  root: string,
  signal: AbortSignal | undefined
): Promise<Extract<SourceMeasurement, { _tag: "measured" }>> => {
  signal?.throwIfAborted()
  const digest = await SafeFs.digestEntry(source.entry, {
    root,
    signal,
    maximumBytes: maximumSourceFileBytes,
    symlinks: "reject",
    what: "implementation source file"
  })
  return { _tag: "measured", entry: source.entry, digest, size: source.size }
}

/**
 * Inspects or digests every candidate with a bounded pool, keeping results
 * indexed by walk position.
 *
 * Each measurement retains its failure as a result, so
 * one file's error cannot pre-empt an earlier file's error and cannot leave a
 * sibling's rejection unhandled. The caller replays the outcomes in walk order,
 * which is what makes the reported error identical to the one the previous
 * one-file-at-a-time walk reported. The only observable difference is that
 * files after the offending one have already been read by the time it is
 * reported; the fingerprint and the error are unchanged.
 */
const measureSources = (
  candidates: ReadonlyArray<SourceCandidate> | ReadonlyArray<AdmittedSource>,
  root: string,
  signal: AbortSignal | undefined,
  phase: "inspect" | "digest"
): Promise<ReadonlyArray<SourceMeasurement>> =>
  Effect.runPromise(Effect.forEach(
    candidates,
    (candidate) =>
      Effect.tryPromise({
        try: async () =>
          phase === "inspect"
            ? { ...(await inspectSource(candidate as SourceCandidate, root, signal)), digest: undefined }
            : await digestSource(candidate as AdmittedSource, root, signal),
        catch: (cause) => cause
      }).pipe(Effect.match({
        onFailure: (cause): SourceMeasurement => ({ _tag: "failed", cause }),
        onSuccess: (value) => value
      })),
    { concurrency: sourceDigestConcurrency }
  ))

/** Refuses names Node may have decoded lossily or which are not one path component. */
const validateSourceName = (name: string, directory: string): void => {
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    name.includes("\ufffd") ||
    name.includes("/") ||
    name.includes("\\") ||
    !name.isWellFormed()
  ) {
    throw new Error(`implementation source tree returned an invalid entry name in ${directory}`)
  }
}

/**
 * Lists and admits one source tree's files without reading their bytes, or
 * returns undefined when the tree is absent. Symbolic links are skipped rather
 * than followed, so the digest covers the tree as it is laid out rather than
 * wherever a link points.
 */
const listSources = async (
  directory: string,
  signal?: AbortSignal | undefined
): Promise<SourceListing | undefined> => {
  let root: string
  try {
    root = await SafeFs.canonicalRoot(directory)
  } catch (cause) {
    const code = SafeFs.errorCode(cause)
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw cause
  }
  const rootEntry = await SafeFs.resolveDirectory(root, {
    root,
    signal,
    what: "implementation source root"
  })
  if (rootEntry === undefined) return undefined
  const candidates: Array<SourceCandidate> = []
  let directories = 0
  let entriesSeen = 0
  let bytesSeen = 0
  const visit = async (
    absolute: string,
    relative: string,
    expected: SafeFs.Entry,
    depth: number
  ): Promise<void> => {
    signal?.throwIfAborted()
    directories += 1
    if (directories > maximumSourceDirectories) {
      throw new Error(`implementation source tree contains more than ${maximumSourceDirectories} directories`)
    }
    if (depth > maximumSourceDepth) {
      throw new Error(`implementation source tree exceeds its maximum depth of ${maximumSourceDepth}`)
    }
    const entries = await SafeFs.listDirectory(absolute, expected, {
      root,
      signal,
      what: "implementation source directory"
    })
    entriesSeen += entries.length
    if (entriesSeen > maximumSourceEntries) {
      throw new Error(`implementation source tree contains more than ${maximumSourceEntries} entries`)
    }
    const sortedEntries = [...entries].sort((left, right) => byCodeUnit(left.name, right.name))
    for (const entry of sortedEntries) {
      signal?.throwIfAborted()
      validateSourceName(entry.name, absolute)
      if (entry.isSymbolicLink()) continue
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`
      const childAbsolute = NodePath.join(absolute, entry.name)
      if (entry.isDirectory()) {
        if (skippedSourceDirectories.has(entry.name)) continue
        const childEntry = await SafeFs.resolveDirectory(childAbsolute, {
          root,
          signal,
          what: "implementation source directory"
        })
        if (childEntry === undefined) {
          throw new Error(`implementation source directory changed while it was being fingerprinted: ${childAbsolute}`)
        }
        await visit(childAbsolute, child, childEntry, depth + 1)
      } else if (entry.isFile() && sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
        if (candidates.length >= maximumSourceFiles) {
          throw new Error(`implementation source tree contains more than ${maximumSourceFiles} source files`)
        }
        candidates.push({ path: child, absolute: childAbsolute })
      }
    }
  }
  await visit(root, "", rootEntry, 0)
  // First inspect every file in the bounded pool. This is deliberately a
  // metadata-only pass: it establishes the root's cumulative byte limit
  // before the separate bounded digest pool can read any source bytes.
  const inspected = await measureSources(candidates, root, signal, "inspect")
  const admitted: Array<AdmittedSource> = []
  for (const [index, candidate] of candidates.entries()) {
    const outcome = inspected[index]!
    if (outcome._tag === "failed") throw outcome.cause
    if (outcome.entry === undefined) {
      throw new Error(
        `implementation source file changed while it was being fingerprinted: ${candidate.absolute}`
      )
    }
    bytesSeen += outcome.size
    if (!Number.isSafeInteger(bytesSeen) || bytesSeen > maximumSourceRootBytes) {
      throw new Error(`implementation source root exceeds ${maximumSourceRootBytes} source bytes: ${root}`)
    }
    admitted.push({ candidate, entry: outcome.entry, size: outcome.size })
  }
  return { root, sources: admitted }
}

/** Hashes a source listing only after every root has passed byte admission. */
const digestSources = async (
  listing: SourceListing,
  signal: AbortSignal | undefined
): Promise<ReadonlyArray<SourceDigest>> => {
  const measured = await measureSources(listing.sources, listing.root, signal, "digest")
  const found: Array<SourceDigest> = []
  let digestedBytesSeen = 0
  for (const [index, source] of listing.sources.entries()) {
    const outcome = measured[index]!
    if (outcome._tag === "failed") throw outcome.cause
    if (outcome.entry === undefined || outcome.digest === undefined) {
      throw new Error(
        `implementation source file changed while it was being fingerprinted: ${source.candidate.absolute}`
      )
    }
    digestedBytesSeen += outcome.size
    if (!Number.isSafeInteger(digestedBytesSeen) || digestedBytesSeen > maximumSourceRootBytes) {
      throw new Error(`implementation source root exceeds ${maximumSourceRootBytes} source bytes: ${listing.root}`)
    }
    found.push({ path: source.candidate.path, digest: outcome.digest, size: outcome.size })
  }
  return found.sort((left, right) => byCodeUnit(left.path, right.path))
}

/** Adds one length-delimited UTF-8 string to a source fingerprint. */
const updateSourceField = (hash: ReturnType<typeof createHash>, value: string): void => {
  assertWellFormed(value, "implementation source identity")
  hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8")
  hash.update(value, "utf8")
}

/**
 * Digests the bytes of the implementation that will execute the plan.
 *
 * Only logical names — the root's name plus the tree-relative path — and file
 * bytes enter the digest, never an absolute path, so two checkouts of the same
 * sources at different locations produce the same fingerprint and can share a
 * cache. An absent tree contributes a distinct `absent` marker rather than
 * silently contributing nothing.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export const fingerprintSources = async (
  roots: ReadonlyArray<SourceRoot>,
  options: { readonly signal?: AbortSignal | undefined } = {}
): Promise<string> => {
  const listings: Array<{ readonly sourceRoot: SourceRoot; readonly listing: SourceListing | undefined }> = []
  let admittedBytes = 0
  for (const sourceRoot of roots) {
    options.signal?.throwIfAborted()
    const listing = await listSources(sourceRoot.directory, options.signal)
    if (listing !== undefined) {
      for (const source of listing.sources) {
        admittedBytes += source.size
        if (!Number.isSafeInteger(admittedBytes) || admittedBytes > maximumImplementationBytes) {
          throw new Error(`implementation sources exceed ${maximumImplementationBytes} bytes in aggregate`)
        }
      }
    }
    listings.push({ sourceRoot, listing })
  }
  const hash = createHash("sha256")
  hash.update("smithers-build-implementation/2\u0000")
  for (const { sourceRoot, listing } of listings) {
    options.signal?.throwIfAborted()
    hash.update("root\u0000")
    updateSourceField(hash, sourceRoot.name)
    if (listing === undefined) {
      hash.update("absent\u0000")
      continue
    }
    const files = await digestSources(listing, options.signal)
    hash.update(`present\u0000${files.length}\u0000`)
    for (const file of files) {
      hash.update("file\u0000")
      updateSourceField(hash, file.path)
      hash.update(file.digest, "ascii")
      hash.update("\u0000")
    }
  }
  return hash.digest("hex")
}

const cliSourceDirectory = NodePath.dirname(fileURLToPath(import.meta.url))

const loadedModuleRoot = (name: string, specifier: string): SourceRoot => ({
  name,
  directory: NodePath.dirname(fileURLToPath(import.meta.resolve(specifier)))
})

/**
 * The source trees whose bytes decide what an execution actually does: the CLI
 * that schedules and admits, the target catalog, the execution libraries, and
 * the pinned runtime dependencies they load.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export const productionSourceRoots = (): ReadonlyArray<SourceRoot> => [
  { name: "cli", directory: cliSourceDirectory },
  loadedModuleRoot("targets", "@smthrs/targets"),
  loadedModuleRoot("build", "@smthrs/build"),
  loadedModuleRoot("canonical", "@smthrs/canonical"),
  loadedModuleRoot("crypto", "@smthrs/crypto"),
  loadedModuleRoot("engine", "@smthrs/engine"),
  loadedModuleRoot("flow", "@smthrs/flow"),
  loadedModuleRoot("keys", "@smthrs/keys"),
  loadedModuleRoot("plan", "@smthrs/plan"),
  loadedModuleRoot("effect", "effect"),
  loadedModuleRoot("effect-platform-node", "@effect/platform-node"),
  loadedModuleRoot("effect-platform-node-shared", "@effect/platform-node-shared"),
  loadedModuleRoot("ignore", "ignore"),
  loadedModuleRoot("minimatch", "minimatch"),
  loadedModuleRoot("tsx", "tsx")
]

let fingerprint: string | undefined

/**
 * The memoized fingerprint of the loaded implementation sources.
 *
 * `Target.Metadata.implementationDigest` distinguishes callback identity within
 * one process and includes process-local entropy for ordinary closures, so it
 * cannot be a persistent cache identity. It is also blind to every helper those
 * functions call, every action layer that implements their nodes, and the
 * executor's own admission logic. This fingerprint is the persistent identity:
 * it changes whenever any byte of the shipped implementation changes, with no
 * salt to remember to bump.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export const implementationFingerprint = async (signal?: AbortSignal | undefined): Promise<string> => {
  if (fingerprint !== undefined) return fingerprint
  const measured = await fingerprintSources(productionSourceRoots(), { signal })
  fingerprint ??= measured
  return fingerprint
}

/**
 * Canonicalizes target attrs into key material: target references become
 * dependency keys and declared inputs become content digests.
 *
 * Exported for the build-system planner, so both planners canonicalize attrs
 * identically and every key still flows through the one injective encoder.
 *
 * @category keys
 * @since 0.1.0
 * @slop
 */
export const attrsValue = (
  value: unknown,
  depKeys: ReadonlyMap<Target.AnyTarget, string>,
  inputDigests: ReadonlyMap<Input.Declared, string>,
  seen: Set<object> = new Set(),
  path = "attrs"
): unknown => {
  if (
    (typeof value === "object" && value !== null || typeof value === "function") &&
    NodeUtil.isProxy(value)
  ) {
    throw new KeyMaterialError(path, "is a Proxy")
  }
  if (Target.isTarget(value)) {
    const key = depKeys.get(value)
    if (key === undefined) throw new Error("attrs reference a target that was not planned as a dependency")
    return { _tag: "Target", key }
  }
  if (Input.isDeclared(value)) {
    return { _tag: value._tag, digest: inputDigests.get(value) ?? null }
  }
  if (value === null || typeof value !== "object") return value
  // A cycle in attrs used to collapse to the `"<cycle>"` string, which is a
  // legitimate attr value: two different declarations could reach one key.
  // The rewrite is refused instead, and the traversal marker is released on
  // the way out so a value that legitimately appears twice is not a cycle.
  if (seen.has(value)) throw new KeyMaterialError(path, "closes a reference cycle")
  seen.add(value)
  try {
    const prototype = reflect(path, () => Object.getPrototypeOf(value))
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return value
      const names = reflect(path, () => Object.getOwnPropertyNames(value))
      if (
        names.length !== value.length + 1 ||
        names.at(-1) !== "length" ||
        reflect(path, () => Object.getOwnPropertySymbols(value)).length > 0
      ) return value
      const output: Array<unknown> = []
      for (let index = 0; index < value.length; index += 1) {
        if (names[index] !== String(index)) return value
        const memberPath = step(path, String(index))
        const descriptor = reflect(memberPath, () => Object.getOwnPropertyDescriptor(value, String(index)))
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          descriptor.enumerable !== true
        ) return value
        output.push(attrsValue(descriptor.value, depKeys, inputDigests, seen, memberPath))
      }
      return output
    }
    if (prototype !== Object.prototype && prototype !== null) return value
    if (reflect(path, () => Object.getOwnPropertySymbols(value)).length > 0) return value
    const output = Object.create(prototype) as Record<string, unknown>
    for (const key of reflect(path, () => Object.getOwnPropertyNames(value)).sort(byCodeUnit)) {
      const memberPath = step(path, key)
      const descriptor = reflect(memberPath, () => Object.getOwnPropertyDescriptor(value, key))
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) return value
      output[key] = attrsValue(descriptor.value, depKeys, inputDigests, seen, memberPath)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

/** Targets whose execution resolves a package-manager and runtime layer. */
