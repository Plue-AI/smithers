/**
 * Hermetic step boundary contracts, the filesystem-backed production
 * implementation, and the deterministic test implementation.
 *
 * @since 0.1.0
 */

import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Sha256 } from "@smthrs/crypto"
import { FileBoundary } from "@smthrs/flow/FileBoundary"
import { FileInput } from "@smthrs/flow/FileInput"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Workspace as KernelWorkspace } from "@smthrs/kernel/Workspace"
import { DerivedKey } from "@smthrs/keys"
import * as FileSet from "@smthrs/plan/FileSet"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as FileBoundarySnapshot from "./internal/FileBoundarySnapshot.ts"
import * as FileEnumeration from "./internal/FileEnumeration.ts"
import { compareText } from "./internal/Ordering.ts"

/**
 * A file boundary that has been measured but not yet run: the caller's
 * declaration, paired with what the host actually found on disk for it.
 *
 * `prepare` produces one of these before a step executes and `settle` consumes
 * it afterwards, which is what lets the boundary say whether the world moved
 * underneath the declaration. Check it with {@link readSetMatches}.
 *
 * @since 0.1.0
 * @category schemas
 */
export const PreparedBoundary = Schema.Struct({
  descriptor: FileBoundary,
  /**
   * What the host actually measured for the declared read set at prepare
   * time. The declared digests are caller metadata folded into the step key;
   * this is the evidence that they still describe reality, and a sealed
   * cache hit is refused when the two disagree (issue #90).
   */
  readSnapshot: Schema.Array(FileInput)
})

/**
 * The value form of {@link PreparedBoundary}.
 *
 * @since 0.1.0
 * @category models
 */
export type PreparedBoundary = typeof PreparedBoundary.Type

/**
 * Exact read inputs from a boundary after ignoring declarations that still need expansion.
 *
 * @category accessors
 * @since 0.1.0
 */
export const exactReads = (descriptor: FileBoundary): ReadonlyArray<FileInput> =>
  descriptor.readSet.filter((entry): entry is FileInput => !FileSet.isGlob(entry))

/**
 * Whether every declared read still matches what the host measured.
 *
 * Reads the host reports but the declaration never claimed are ignored: the
 * declaration is the dependency edge set, and an incidental extra read is not
 * one of its edges. A declared path missing from the measurement counts as a
 * mismatch — its value is unknown, so reuse cannot be justified.
 *
 * @since 0.1.0
 * @category predicates
 */
export const readSetMatches = (prepared: PreparedBoundary): boolean => {
  const digestsByPath = new Map<string, Set<string>>()
  for (const measured of prepared.readSnapshot) {
    const digests = digestsByPath.get(measured.path)
    if (digests === undefined) digestsByPath.set(measured.path, new Set([measured.digest]))
    else digests.add(measured.digest)
  }
  return prepared.descriptor.readSet.every((entry) =>
    !FileSet.isGlob(entry) &&
    digestsByPath.get(entry.path)?.has(entry.digest) === true
  )
}

/**
 * The paths a step wrote that its `expected` write set did not name, together
 * with the diff identity they were observed under.
 *
 * An expected-mode boundary reports these rather than failing: the declaration
 * is a prediction, and a wrong prediction is evidence to journal, not an
 * error. A hard-mode boundary raises {@link UndeclaredWrite} for the same
 * observation.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ExpectedSetDeviation = Schema.TaggedStruct("ExpectedSetDeviation", {
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.NonEmptyString
})

/**
 * Declared writes an expected-mode step did not produce, and did not declare
 * as removals.
 *
 * The absence itself is the defect: recording it as valid evidence caches the
 * claim "this file should not exist", which `replayOutputs` then acts on by
 * deleting the path on a workspace that never ran the step. A hard-mode
 * boundary raises {@link MissingDeclaredOutput} for the same observation.
 *
 * Expected mode records it rather than failing because the declaration there is
 * a prediction — and because a deviation of any variant already bars the
 * evidence from the shared cache (`ActionPersistence` gates `recordCache` on
 * `deviation === undefined`), so an unexplained absence never reaches another
 * host either way.
 *
 * @since 0.1.0
 * @category schemas
 */
export const MissingOutputDeviation = Schema.TaggedStruct("MissingDeclaredOutput", {
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.NonEmptyString
})

/**
 * Declared removals an expected-mode step left in place.
 *
 * The dual of {@link MissingOutputDeviation}: a removal is a promise about the
 * post-state exactly as a write is. A path that was promised absent but is
 * still present — possibly mutated — must not settle as valid evidence, or
 * the mutation is cached under a declaration that disclaimed it and replay
 * materializes it everywhere. A hard-mode boundary raises
 * {@link SurvivingDeclaredRemoval} for the same observation.
 *
 * @since 0.1.0
 * @category schemas
 */
export const SurvivingRemovalDeviation = Schema.TaggedStruct("SurvivingDeclaredRemoval", {
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.NonEmptyString
})

/**
 * What a settled boundary observed that its declaration did not predict.
 *
 * @since 0.1.0
 * @category schemas
 */
export const BoundaryDeviation = Schema.Union([ExpectedSetDeviation, MissingOutputDeviation, SurvivingRemovalDeviation])

/**
 * The value form of {@link BoundaryDeviation}.
 *
 * @since 0.1.0
 * @category models
 */
export type BoundaryDeviation = typeof BoundaryDeviation.Type

/**
 * What a settled boundary proved about a step's writes — the record the
 * journal keeps and a later cache hit is justified against.
 *
 * `diffIdentity` names the post-state the step produced; `declaredOutputs`
 * carries whatever the implementation needs to reproduce it on a workspace
 * that never ran the step. The two optional fields are the honest gaps:
 * `wholeTreeWritesVerified` is present only when the boundary could observe
 * the entire execution tree, and `deviation` only when it saw writes the
 * declaration did not predict.
 *
 * @since 0.1.0
 * @category schemas
 */
export const BoundaryEvidence = Schema.Struct({
  declaredOutputs: Schema.Unknown,
  diffIdentity: Schema.NonEmptyString,
  /**
   * The boundary observed the whole execution tree and proved that every
   * write was covered by the descriptor's write set. Only evidence carrying
   * this explicit proof may enter the cross-run cache. Older evidence and
   * boundaries that can inspect declared paths only omit it.
   */
  wholeTreeWritesVerified: Schema.optional(Schema.Literal(true)),
  /** The body could observe only declared filesystem inputs. */
  hermeticReadsVerified: Schema.optional(Schema.Literal(true)),
  deviation: Schema.optional(BoundaryDeviation)
})

/**
 * The value form of {@link BoundaryEvidence}.
 *
 * @since 0.1.0
 * @category models
 */
export type BoundaryEvidence = typeof BoundaryEvidence.Type

/**
 * A hard-mode step wrote outside its declared write set.
 *
 * Hard mode treats the declaration as a contract, so this is a refusal, not a
 * report: the step's evidence is never journaled and never becomes a cache
 * entry. An expected-mode boundary records the same observation as a
 * {@link BoundaryDeviation} instead.
 *
 * @since 0.1.0
 * @category errors
 */
export class UndeclaredWrite extends Schema.TaggedError<UndeclaredWrite>()(
  "@smthrs/engine-store/UndeclaredWrite",
  {
    code: Schema.Literal("undeclared_write"),
    paths: Schema.Array(Schema.String),
    diffIdentity: Schema.NonEmptyString
  }
) {}

/**
 * A step finished without producing a path its write set declared, and did not
 * declare that path as a removal.
 *
 * Bazel hard-fails the same observation — `SkyframeActionExecutor.checkOutputs`
 * reports "output was not created" — and for the same reason: the alternative
 * is to record `digest: null` as valid evidence, which caches the claim "this
 * file should not exist" and makes every later replay delete the path. A step
 * that crashed after declaring its writes would poison the cache with an
 * eraser.
 *
 * Declaring the path in {@link FileBoundary}'s `removes` is how a deliberate
 * deletion says so, and it is the only thing that makes the absence legitimate.
 *
 * @since 0.1.0
 * @category errors
 */
export class MissingDeclaredOutput extends Schema.TaggedError<MissingDeclaredOutput>()(
  "@smthrs/engine-store/MissingDeclaredOutput",
  {
    code: Schema.Literal("missing_declared_output"),
    paths: Schema.Array(Schema.String),
    diffIdentity: Schema.NonEmptyString
  }
) {}

/**
 * A hard-mode step left a declared removal in place.
 *
 * The dual of {@link MissingDeclaredOutput}: `removes` promises the path is
 * absent afterwards, and a path that survived — or was quietly rewritten —
 * is a post-state the declaration disclaimed. Settling it as evidence would
 * cache the surviving bytes under a removal and hand them to every replay.
 *
 * @since 0.1.0
 * @category errors
 */
export class SurvivingDeclaredRemoval extends Schema.TaggedError<SurvivingDeclaredRemoval>()(
  "@smthrs/engine-store/SurvivingDeclaredRemoval",
  {
    code: Schema.Literal("surviving_declared_removal"),
    paths: Schema.Array(Schema.String),
    diffIdentity: Schema.NonEmptyString
  }
) {}

/**
 * The host could not honour the boundary at all — a filesystem that cannot be
 * measured, a path that cannot be read, a transient I/O failure.
 *
 * It is the catch-all host refusal, deliberately kept distinct from the two
 * refusals a caller can act on: {@link BoundaryCorruption} (the bytes changed
 * under a recorded digest) and {@link MissingArtifact} (the bytes might be
 * fetchable from a shared tier).
 *
 * @since 0.1.0
 * @category errors
 */
export class UnsupportedBoundary extends Schema.TaggedError<UnsupportedBoundary>()(
  "@smthrs/engine-store/UnsupportedBoundary",
  {
    code: Schema.Literal("unsupported_boundary"),
    message: Schema.String,
    /**
     * The refusing host or artifact-store failure, carried whole rather than
     * flattened into the message (`PlatformError`'s own convention), so the
     * journal record and a live debugger both see the original error.
     */
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * Recorded boundary evidence whose bytes no longer match their recorded
 * digest — an integrity violation of the store's strongest invariant, as
 * opposed to a transient host failure (issue #150). The two classes were
 * previously conflated under one `UnsupportedBoundary` tag, so a failing
 * disk corrupting many blobs journalled identically to a one-off EIO.
 *
 * @since 0.1.0
 * @category errors
 */
export class BoundaryCorruption extends Schema.TaggedError<BoundaryCorruption>()(
  "@smthrs/engine-store/BoundaryCorruption",
  {
    code: Schema.Literal("boundary_corruption"),
    path: Schema.String,
    recordedDigest: Schema.String,
    measuredDigest: Schema.String
  }
) {}

/**
 * Recorded evidence references an artifact this host's store does not hold
 * (issue #172). Distinct from {@link UnsupportedBoundary} because it is the one
 * replay refusal a *shared artifact tier* can repair: the caller fetches the
 * blob from the remote store, writes it back locally, and retries the replay
 * once before falling through to a real execution. Every other host refusal
 * says nothing about where the bytes might be.
 *
 * @since 0.1.0
 * @category errors
 */
export class MissingArtifact extends Schema.TaggedError<MissingArtifact>()(
  "@smthrs/engine-store/MissingArtifact",
  {
    code: Schema.Literal("missing_artifact"),
    path: Schema.String,
    digest: Schema.String
  }
) {}

/**
 * The three-call lifecycle of a hermetic step boundary.
 *
 * `prepare` measures the declared read set before the step runs; `settle`
 * measures the writes afterwards and turns them into {@link BoundaryEvidence};
 * `replayOutputs` reproduces a previous step's outputs from that evidence, so
 * a cache hit can materialize results on a workspace that never executed
 * anything.
 *
 * @since 0.1.0
 * @category services
 */
export interface Service {
  readonly prepare: (
    descriptor: FileBoundary
  ) => Effect.Effect<PreparedBoundary, UnsupportedBoundary, Crypto.Crypto>
  readonly settle: (
    prepared: PreparedBoundary
  ) => Effect.Effect<
    BoundaryEvidence,
    UndeclaredWrite | MissingDeclaredOutput | SurvivingDeclaredRemoval | UnsupportedBoundary | BoundaryCorruption,
    Crypto.Crypto
  >
  readonly replayOutputs: (
    evidence: BoundaryEvidence
  ) => Effect.Effect<void, UnsupportedBoundary | BoundaryCorruption | MissingArtifact, Crypto.Crypto>
}

/**
 * The service key for a {@link Service}. Provide it with `layer` for
 * a real workspace or `layerTest` for a deterministic in-memory one.
 *
 * @since 0.1.0
 * @category services
 */
export const StepBoundary: Context.Service<Service, Service> = Context.Service<Service>(
  "@smthrs/engine-store/StepBoundary"
)

/**
 * Brands a {@link Service} implementation as a `StepBoundary`, so a new
 * boundary backend is type-checked where it is written rather than where it is
 * provided.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (service: Service): Service => StepBoundary.of(service)

/**
 * The digest a measurement reports for a declared path that does not exist.
 * Declared digests are hex SHA-256 strings, so the sentinel can never
 * collide with a real measurement — a declaration naming a vanished file
 * always mismatches and the cache hit is refused.
 */
const absentDigest = "absent"

/**
 * The persisted shape of the production layer's `declaredOutputs`: the
 * declared write set's materialized post-state, so a cache-hit replay can
 * reproduce the outputs on a workspace that never ran the step.
 *
 * Outputs are recorded by content digest, never inlined unbounded
 * (issue #113): a `null` digest records that the path did not exist at
 * settle time; `content` (base64) is present only when the payload fits the
 * configured inline bound, otherwise the bytes live in the host's
 * content-addressed object directory under the digest and the row carries
 * only the reference. Temporal's blob-size limits are the prior art — the
 * evidence is persisted into every attempt row and cache entry.
 *
 * The digest is decoded against the store's strict address schema
 * (`ArtifactStore.Digest`), so a persisted row carrying a malformed address
 * fails the decode here instead of reaching the store or the sync RPCs.
 */
const DigestReferencedOutput = Schema.Struct({
  path: Schema.String,
  digest: Schema.NullOr(ArtifactStore.Digest),
  sizeBytes: Schema.optional(Schema.Number),
  content: Schema.optional(Schema.String)
})

const MaterializedOutputs = Schema.Struct({
  outputs: Schema.Array(DigestReferencedOutput),
  trees: Schema.optional(Schema.Array(Schema.Struct({
    path: Schema.String,
    identity: Schema.String
  })))
})

/**
 * The directory portion of a slash-separated path, or `undefined` for a
 * bare filename (nothing to create). Boundary paths are workspace-relative
 * and slash-separated — the same normalization the kernel `FileSystem`
 * layer applies.
 */
const parentDirectory = (path: string): string | undefined => {
  const index = path.lastIndexOf("/")
  return index <= 0 ? undefined : path.slice(0, index)
}

const hostFailure = (cause: unknown): UnsupportedBoundary =>
  new UnsupportedBoundary({
    code: "unsupported_boundary",
    message: "the host filesystem could not enforce the step boundary",
    cause
  })

/**
 * An artifact store that refused the operation outright — a failing disk, an
 * unreachable shared tier, an address that is not a content address. Unlike a
 * miss or a corruption it says nothing about the artifact, so it stays the
 * ordinary retryable host refusal the issue-#107 call sites already handle.
 */
const artifactFailure = (cause: ArtifactStore.ArtifactStoreError): UnsupportedBoundary =>
  new UnsupportedBoundary({
    code: "unsupported_boundary",
    message: `the artifact store could not serve the step boundary: ${cause.message}`,
    cause
  })

/**
 * Corruption of an *inline* evidence payload (issue #159): the recorded
 * base64 no longer decodes, so there are no bytes to measure a digest of —
 * the `invalid_base64` sentinel records that the measurement itself was
 * impossible, which is still cache-origin corruption and never a transient
 * host refusal.
 */
const inlineCorruption = (path: string, recordedDigest: string): BoundaryCorruption =>
  new BoundaryCorruption({
    code: "boundary_corruption",
    path,
    recordedDigest,
    measuredDigest: "invalid_base64"
  })

/**
 * The two size bounds that decide when a settled output is inlined into
 * boundary evidence and when it is spilled to the `ArtifactStore` by digest.
 *
 * Both default to values that keep an evidence row small enough to journal;
 * raise them only when the workspace's outputs are known to be small and the
 * extra artifact round-trip is measurably costing something.
 *
 * @since 0.1.0
 * @category models
 */
export interface FileSystemOptions {
  /**
   * The largest output (in bytes) inlined into the boundary evidence
   * itself. Anything larger is handed to the `ArtifactStore` and recorded by
   * digest reference only (issue #113). Defaults to 1 MiB.
   */
  readonly maxInlineBytes?: number | undefined
  /**
   * The largest *aggregate* inline payload (in bytes) a single settle may
   * fold into its boundary evidence (issue #122). A per-output bound alone
   * still let a wide write set multiply many individually-small payloads
   * into an unbounded evidence row; once an output would push the running
   * total past this bound it is spilled to the `ArtifactStore` and
   * recorded by digest reference only, even though it individually fits
   * {@link maxInlineBytes}. Defaults to 8 MiB.
   */
  readonly maxTotalInlineBytes?: number | undefined
  /**
   * The workspace root cache replay confines its writes, removals, and prune
   * walk to. A filesystem already confined to a root (the kernel-guarded
   * layer's service, or a `confined` view) keeps its own root and ignores
   * this. Otherwise it defaults to the process working directory, the root a
   * path-based host resolves `prepare` and `settle` against. {@link layer}
   * passes the kernel `Workspace` root when one is in context.
   */
  readonly root?: string | undefined
}

const defaultMaxInlineBytes = 1024 * 1024
const defaultMaxTotalInlineBytes = 8 * 1024 * 1024
interface MeasuredDigest {
  readonly digest: ArtifactStore.Digest
  readonly bytes: Uint8Array
}

interface BatchedDigest {
  readonly digest: ArtifactStore.Digest
  readonly sizeBytes: number
  readonly bytes?: Uint8Array
}

type MaterializedOutput = typeof DigestReferencedOutput.Type

/**
 * The digests this evidence references rather than inlines — the set that must
 * be durable in a shared artifact tier before the evidence's cache entry
 * becomes observable there, and the set a replay on a fresh host has to fetch.
 *
 * Evidence recorded by a foreign boundary implementation references nothing
 * this store can name, so it yields the empty list rather than failing: the
 * caller's replay path already refuses such evidence with
 * {@link UnsupportedBoundary}.
 *
 * @since 0.1.0
 * @category accessors
 */
export const referencedDigests = (evidence: BoundaryEvidence): ReadonlyArray<ArtifactStore.Digest> => {
  const decoded = Schema.decodeUnknownResult(MaterializedOutputs)(evidence.declaredOutputs)
  if (decoded._tag === "Failure") return []
  const digests: Array<ArtifactStore.Digest> = []
  for (const output of decoded.success.outputs) {
    if (output.digest === null || output.content !== undefined) continue
    digests.push(output.digest)
  }
  return digests
}

/**
 * Builds the filesystem-backed boundary service.
 *
 * The blob mechanics — content addressing, atomic publication, digest
 * verification, dedupe — belong to `artifacts` and were extracted into
 * `@smthrs/artifacts` (`packages/smithers/flows/artifacts/docs/api.md`). What stays here
 * is the *policy* that decides which outputs become blobs at all: the
 * inline-versus-spill budgets are a property of how large an evidence row may
 * get, not of how bytes are stored.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeFileSystem = (
  fs: FileSystem.FileSystem,
  artifacts: ArtifactStore.Service,
  options: FileSystemOptions = {}
): Service => {
  const maxInlineBytes = options.maxInlineBytes ?? defaultMaxInlineBytes
  const maxTotalInlineBytes = options.maxTotalInlineBytes ?? defaultMaxTotalInlineBytes
  // Stat tuples are not content identities: a same-size rewrite can preserve
  // mtime, device, and inode on every supported filesystem.
  const readDigestFrom = Effect.fn("StepBoundary.readDigest")(function*(host: FileSystem.FileSystem, path: string) {
    const bytes = yield* host.readFile(path)
    const digest = yield* Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)
    return { digest, bytes } satisfies MeasuredDigest
  })
  const readDigest = (path: string) => readDigestFrom(fs, path)
  const batch = KernelFileSystem.batch(fs)
  const measurements = Effect.fn("StepBoundary.measurements")(
    function*(paths: ReadonlyArray<string>, content: boolean) {
      if (batch === undefined) {
        return yield* Effect.forEach(paths, (path) =>
          readDigest(path).pipe(
            Effect.map((value): BatchedDigest => ({
              digest: value.digest,
              sizeBytes: value.bytes.length,
              ...(content ? { bytes: value.bytes } : {})
            })),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
            Effect.mapError(hostFailure)
          ), { concurrency: KernelFileSystem.fallbackConcurrency })
      }
      const values: Array<BatchedDigest | undefined> = []
      for (let offset = 0; offset < paths.length; offset += batch.maxSize) {
        const response = yield* batch.execute(
          paths.slice(offset, offset + batch.maxSize).map((path) => ({
            operation: "digest",
            path,
            content
          }))
        ).pipe(Effect.mapError(hostFailure))
        for (const entry of [...response.entries].sort((a, b) => a.index - b.index)) {
          const measured = yield* Effect.fromResult(entry.result).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
            Effect.mapError(hostFailure)
          )
          if (measured === undefined) values.push(undefined)
          else if (measured.operation !== "digest") {
            return yield* Effect.fail(hostFailure(new Error("host returned a non-digest batch result")))
          } else values.push({ ...measured, digest: measured.digest as ArtifactStore.Digest })
        }
      }
      return values
    }
  )
  /**
   * One host call, never two. An `exists` probe ahead of the read asked
   * exactly what the read itself answers — a path that is not there refuses
   * with `NotFound` — and every declared read was therefore measured twice.
   * On the confined host that is two CPython forks per path
   * (`@smthrs/platform-node/AtomicFileSystem` spawns one interpreter per
   * operation, ~130 ms each), so the probe doubled the cost of every
   * `prepare`, every post-body change check, and every materialization.
   */
  const measure = (
    path: string,
    host: FileSystem.FileSystem = fs
  ): Effect.Effect<string, UnsupportedBoundary, Crypto.Crypto> =>
    readDigestFrom(host, path).pipe(
      Effect.map((measured) => measured.digest),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(absentDigest)),
      Effect.mapError(hostFailure)
    )
  // Both expansions enumerate through `FileEnumeration`, never the host
  // `glob`: host results are absolute under the kernel FileSystem and skip
  // dotfiles under Node's matcher, so trusting them silently emptied every
  // workspace-relative expansion and let a tree replay delete dotfiles the
  // producer wrote.
  const expandGlob = Effect.fn("StepBoundary.expandGlob")(function*(glob: FileSet.Glob) {
    return yield* FileEnumeration.expandGlob(fs, glob).pipe(Effect.mapError(hostFailure))
  })
  const treeEntries = Effect.fn("StepBoundary.treeEntries")(function*(host: FileSystem.FileSystem, path: string) {
    return yield* FileEnumeration.entriesUnder(host, path).pipe(Effect.mapError(hostFailure))
  })
  // Replay writes and deletes what evidence names, so the lexical check alone
  // is not a boundary: a symlink planted on a lexically valid path would carry
  // the mutation outside the workspace. Every replay mutation, its probes, and
  // its prune walk go through a view pinned to the root, where each call is
  // one descriptor-relative, no-follow request and a symlink anywhere on the
  // path is refused rather than followed. `prepare` and `settle` only read,
  // and keep the caller's filesystem.
  const replayRoot = KernelFileSystem.confinedRoot(fs) ?? options.root ?? "."
  const replayHost: Effect.Effect<FileSystem.FileSystem, UnsupportedBoundary> = KernelFileSystem.isConfinable(fs)
    ? KernelFileSystem.confined(fs, replayRoot).pipe(Effect.provide(Path.layer), Effect.mapError(hostFailure))
    : Effect.fail(
      new UnsupportedBoundary({
        code: "unsupported_boundary",
        message:
          "cache replay needs a confined host filesystem; the host carries no descriptor-relative executor or isolation attestation"
      })
    )
  const capture = Effect.fn("StepBoundary.capture")(
    function*(path: string, inlineBudget: number, measured: BatchedDigest | undefined) {
      yield* Effect.annotateCurrentSpan({ path })
      // As in `measure`: the read reports absence itself, so the output is
      // captured in one host call rather than an `exists` probe plus a read.
      if (measured === undefined) {
        return { output: { path, digest: null } satisfies MaterializedOutput, inlinedBytes: 0 }
      }
      const bytes = measured.bytes
      if (bytes === undefined) return yield* Effect.fail(hostFailure(new Error("host omitted requested batch content")))
      const digest = measured.digest
      // Inline only while both bounds hold (issue #122): the per-output bound
      // and the settle-wide aggregate budget the caller threads through.
      if (bytes.length <= maxInlineBytes && bytes.length <= inlineBudget) {
        return {
          output: {
            path,
            digest,
            sizeBytes: bytes.length,
            content: Encoding.encodeBase64(bytes)
          } satisfies MaterializedOutput,
          inlinedBytes: bytes.length
        }
      }
      // Over the inline bound: the payload goes to the content-addressed
      // artifact store and the persisted row carries only the reference. Every
      // property that used to live here — atomic publication, verify-once
      // dedupe, healing rewrite of a corrupt address — is now the store's, and
      // is tested there (`@smthrs/artifacts`).
      const stored = yield* artifacts.put(bytes).pipe(Effect.mapError(artifactFailure))
      if (stored !== digest) {
        return yield* Effect.fail(
          new BoundaryCorruption({
            code: "boundary_corruption",
            path,
            recordedDigest: `${stored}`,
            measuredDigest: digest
          })
        )
      }
      return { output: { path, digest, sizeBytes: bytes.length } satisfies MaterializedOutput, inlinedBytes: 0 }
    }
  )
  const materialize = Effect.fn("StepBoundary.materialize")(function*(
    host: FileSystem.FileSystem,
    output: MaterializedOutput
  ) {
    yield* Effect.annotateCurrentSpan({ path: output.path })
    // The filesystem is the cheapest source of truth for a warm workspace.
    // Probe before decoding inline bytes or consulting the artifact store; a
    // transient probe refusal merely forfeits the optimization and the
    // ordinary materialization path retains its existing typed failures.
    const current = yield* measure(output.path, host).pipe(
      Effect.map((digest) => digest !== absentDigest && digest === output.digest),
      Effect.catch(() => Effect.succeed(false))
    )
    if (current) return
    let bytes: Uint8Array
    if (output.content !== undefined) {
      const decoded = Encoding.decodeBase64(output.content)
      if (Result.isFailure(decoded)) {
        // Inline content is cache-origin bytes: an undecodable payload is a
        // tampered durable row, classified exactly like a digest mismatch so
        // the caller routes it to the Inconsistency receiver instead of
        // retrying it as a transient host refusal (issue #159).
        return yield* Effect.fail(inlineCorruption(output.path, `${output.digest}`))
      }
      bytes = decoded.success
      // Inline evidence is verified here because nothing else can: the bytes
      // travel inside the row rather than at a content address. A referenced
      // artifact is verified by the store on the way out, so the check below
      // would be a second read+hash of the same bytes.
      const measured = yield* Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)
      if (measured !== output.digest) {
        return yield* Effect.fail(
          new BoundaryCorruption({
            code: "boundary_corruption",
            path: output.path,
            recordedDigest: `${output.digest}`,
            measuredDigest: measured
          })
        )
      }
    } else {
      bytes = yield* artifacts.get(`${output.digest}`).pipe(
        Effect.catchTags({
          // A reference this host cannot resolve is not a host refusal: a
          // shared artifact tier may still hold it, so the caller gets a
          // typed, repairable failure and fetches before falling back to a
          // real execution (issue #172).
          "@smthrs/artifacts/ArtifactMissing": (missing) =>
            Effect.fail(
              new MissingArtifact({ code: "missing_artifact", path: output.path, digest: missing.digest })
            ),
          // Corruption is a distinct typed failure from a transient host
          // error (issue #150): the caller routes it to the Inconsistency
          // receiver instead of treating it as an ordinary retryable refusal.
          "@smthrs/artifacts/ArtifactCorruption": (corrupt) =>
            Effect.fail(
              new BoundaryCorruption({
                code: "boundary_corruption",
                path: output.path,
                recordedDigest: corrupt.recordedDigest,
                measuredDigest: corrupt.measuredDigest
              })
            ),
          "@smthrs/artifacts/ArtifactStoreError": (failure) => Effect.fail(artifactFailure(failure))
        })
      )
    }
    // The original body may have created the output's directory itself; a
    // fresh workspace replaying the evidence has no such directory and
    // `writeFile` does not create parents (issue #107).
    const parent = parentDirectory(output.path)
    if (parent !== undefined) {
      yield* host.makeDirectory(parent, { recursive: true }).pipe(Effect.mapError(hostFailure))
    }
    yield* host.writeFile(output.path, bytes).pipe(Effect.mapError(hostFailure))
  })
  return make({
    prepare: Effect.fn("StepBoundary.prepare")(function*(descriptor) {
      const boundary = FileBoundarySnapshot.make(descriptor)
      yield* Effect.annotateCurrentSpan({
        reads: boundary.readSet.length,
        boundaryMode: boundary.boundaryMode
      })
      // The dirty check's evidence (issue #90): what the host actually
      // measured for every declared read, never the declaration itself —
      // defaulting the snapshot to the declaration made `readSetMatches`
      // compare the declaration against itself and pass unconditionally
      // (issue #104).
      const readSnapshot: Array<FileInput> = []
      const paths: Array<string> = []
      for (const entry of boundary.readSet) {
        if (FileSet.isGlob(entry)) {
          paths.push(...yield* expandGlob(entry))
        } else paths.push(entry.path)
      }
      const measured = yield* measurements(paths, false)
      for (const [index, path] of paths.entries()) {
        readSnapshot.push({ path, digest: measured[index]?.digest ?? absentDigest })
      }
      readSnapshot.sort((left, right) => compareText(left.path, right.path))
      return Object.freeze({
        descriptor: boundary,
        readSnapshot: Object.freeze(readSnapshot.map((entry) => Object.freeze({ ...entry })))
      })
    }),
    settle: Effect.fn("StepBoundary.settle")(function*(prepared) {
      yield* Effect.annotateCurrentSpan({
        writes: prepared.descriptor.writeSet.length,
        boundaryMode: prepared.descriptor.boundaryMode
      })
      // Undeclared-write detection is scoped to the declared read set: a
      // declared read whose content moved during the body and is not also a
      // declared write was mutated outside the contract. Whole-tree change
      // detection needs the jj diff surface and stays a documented
      // limitation of this layer rather than a silent pass — the read set
      // is exactly the material cacheability rests on.
      const removes = prepared.descriptor.removes ?? []
      const declaredWrites = [...prepared.descriptor.writeSet, ...removes]
      const declaredCovers = (path: string) =>
        declaredWrites.some((entry) =>
          typeof entry === "string"
            ? entry === path
            : entry._tag === "TreeArtifact"
            ? path === entry.path || path.startsWith(`${entry.path}/`)
            : FileSet.matchesGlob(entry, path)
        )
      const undeclared: Array<string> = []
      const checkedReads = prepared.readSnapshot.filter((entry) => !declaredCovers(entry.path))
      const currentReads = yield* measurements(checkedReads.map((entry) => entry.path), false)
      for (const [index, entry] of checkedReads.entries()) {
        if ((currentReads[index]?.digest ?? absentDigest) !== entry.digest) undeclared.push(entry.path)
      }
      const outputs: Array<MaterializedOutput> = []
      // Declared removals are captured on the same path and under the same
      // `digest: null` semantics they have always had — the difference is that
      // here the absence was declared, so it is evidence rather than a defect.
      const missing: Array<string> = []
      const surviving: Array<string> = []
      let inlinedBytes = 0
      const outputPaths: Array<string> = []
      const treeMembers: Array<{ readonly path: string; readonly files: ReadonlyArray<string> }> = []
      for (const entry of prepared.descriptor.writeSet) {
        if (typeof entry === "string") outputPaths.push(entry)
        else if (entry._tag === "Glob") outputPaths.push(...yield* expandGlob(entry))
        else {
          const files = (yield* treeEntries(fs, entry.path)).files
          outputPaths.push(...files)
          treeMembers.push({ path: entry.path, files })
        }
      }
      outputPaths.push(...removes)
      const captured = new Map<string, MaterializedOutput>()
      const sortedPaths = [...new Set(outputPaths)].sort(compareText)
      // Digest-only preflight bounds content batches by bytes as well as path
      // count. Both measurements share the guarded host's pinned root identity;
      // a rewrite between them is a refusal, never mismatched cached content.
      const sizes = batch === undefined ? undefined : yield* measurements(sortedPaths, false)
      for (let offset = 0; offset < sortedPaths.length;) {
        let end = offset
        let responseBytes = 256
        const size = batch?.maxSize ?? KernelFileSystem.fallbackConcurrency
        while (end < sortedPaths.length && end - offset < size) {
          const estimate = 4096 + new TextEncoder().encode(sortedPaths[end]).length * 6 +
            Math.ceil((sizes?.[end]?.sizeBytes ?? 0) / 3) * 4
          if (end > offset && batch !== undefined && responseBytes + estimate > batch.maxResponseBytes) break
          responseBytes += estimate
          end++
        }
        const group = sortedPaths.slice(offset, end)
        const contents = yield* measurements(group, true)
        for (const [index, path] of group.entries()) {
          const measured = contents[index]
          if (sizes !== undefined && measured?.digest !== sizes[offset + index]?.digest) {
            return yield* Effect.fail(hostFailure(new Error(`output changed during measurement: ${path}`)))
          }
          const output = yield* capture(path, maxTotalInlineBytes - inlinedBytes, measured)
          // `capture` reports the bytes it actually inlined (zero for a
          // digest-only reference), so the aggregate budget never has to
          // re-derive them from the row it just built.
          inlinedBytes += output.inlinedBytes
          outputs.push(output.output)
          captured.set(path, output.output)
          if (
            output.output.digest === null &&
            !removes.includes(path) &&
            prepared.descriptor.writeSet.some((entry) => typeof entry === "string" && entry === path)
          ) missing.push(path)
          // The dual check: a removal promised the path absent, and it is still
          // here — possibly rewritten. Settling it would cache the surviving
          // bytes under a declaration that disclaimed them.
          if (output.output.digest !== null && removes.includes(path)) surviving.push(path)
        }
        offset = end
      }
      // A tree member is already one of the captured outputs, so its identity
      // is folded from the digest that capture measured rather than from a
      // second read of the same bytes. `capture` spells an absent member
      // `null` where `measure` spells it `absentDigest`; the identity keeps
      // the `measure` spelling, so a tree recorded before this and one
      // recorded after hash identically.
      const trees: Array<{ readonly path: string; readonly identity: string }> = []
      for (const tree of treeMembers) {
        const pairs = tree.files.map((path) =>
          [path.slice(tree.path.length + 1), captured.get(path)!.digest ?? absentDigest] as const
        )
        trees.push({
          path: tree.path,
          identity: yield* Schema.decodeUnknownEffect(DerivedKey)({ kind: "tree-artifact", files: pairs }).pipe(
            Effect.orDie
          )
        })
      }
      // Through `DerivedKey` — the repo's one hashing chokepoint — so the identity is
      // a digest of the RFC 8785 canonical form rather than of whatever
      // `JSON.stringify` happened to emit for this shape.
      const diffIdentity = yield* Schema.decodeUnknownEffect(DerivedKey)({
        kind: "diff-identity",
        outputs: outputs.map((output) => [output.path, output.digest]),
        trees
      }).pipe(Effect.orDie)
      yield* Effect.annotateCurrentSpan({ diffIdentity })
      if (prepared.descriptor.boundaryMode === "hard") {
        if (undeclared.length > 0) {
          return yield* Effect.fail(
            new UndeclaredWrite({ code: "undeclared_write", paths: undeclared, diffIdentity })
          )
        }
        // A declared output that was never produced is a defect, not evidence
        // (Bazel's `checkOutputs`). Recording it would cache `digest: null`,
        // which every later `replayOutputs` reads as "delete this path".
        if (missing.length > 0) {
          return yield* Effect.fail(
            new MissingDeclaredOutput({ code: "missing_declared_output", paths: missing, diffIdentity })
          )
        }
        if (surviving.length > 0) {
          return yield* Effect.fail(
            new SurvivingDeclaredRemoval({ code: "surviving_declared_removal", paths: surviving, diffIdentity })
          )
        }
      }
      return {
        declaredOutputs: { outputs, ...(trees.length === 0 ? {} : { trees }) },
        diffIdentity,
        // This filesystem-only boundary cannot observe writes elsewhere in
        // the tree. Omission is deliberate: ActionPersistence treats the
        // result as run-local and will not publish it to the shared cache.
        //
        // An undeclared write is reported ahead of a missing output, and a
        // missing output ahead of a surviving removal: each is the stronger
        // claim about the same execution, and every variant bars the evidence
        // from the shared cache identically.
        ...(undeclared.length > 0
          ? { deviation: { _tag: "ExpectedSetDeviation" as const, paths: undeclared, diffIdentity } }
          : missing.length > 0
          ? { deviation: { _tag: "MissingDeclaredOutput" as const, paths: missing, diffIdentity } }
          : surviving.length > 0
          ? { deviation: { _tag: "SurvivingDeclaredRemoval" as const, paths: surviving, diffIdentity } }
          : {})
      }
    }),
    replayOutputs: Effect.fn("StepBoundary.replayOutputs")(function*(evidence) {
      yield* Effect.annotateCurrentSpan({ diffIdentity: evidence.diffIdentity })
      const decoded = Schema.decodeUnknownResult(MaterializedOutputs)(evidence.declaredOutputs)
      if (decoded._tag === "Failure") {
        // Evidence recorded by a different boundary implementation carries
        // no materializable outputs; refusing is honest — the caller's
        // dispatch path falls back to a real execution or fails visibly.
        return yield* Effect.fail(
          new UnsupportedBoundary({
            code: "unsupported_boundary",
            message: "the recorded boundary evidence carries no materializable outputs"
          })
        )
      }
      // Replay writes and DELETES whatever the evidence names, so a path is
      // honored only in the coordinate system declarations are written in.
      // Evidence can arrive from a foreign producer through cache sync; an
      // absolute or upward spelling is an eraser aimed outside the workspace,
      // and refusing it here is what keeps that a refusal instead of a wipe.
      const foreign = [
        ...(decoded.success.trees ?? []).map((tree) => tree.path),
        ...decoded.success.outputs.map((output) => output.path)
      ].filter((path) => !FileSet.workspaceRelative(path))
      if (foreign.length > 0) {
        return yield* Effect.fail(
          new UnsupportedBoundary({
            code: "unsupported_boundary",
            message: `the recorded boundary evidence names paths outside the workspace: ${foreign.join(", ")}`
          })
        )
      }
      // Before any mutation: a host that cannot be confined refuses the whole
      // replay, and the caller falls back to a real execution.
      const host = yield* replayHost
      const emptyDirectoryCandidates = new Set<string>()
      for (const tree of decoded.success.trees ?? []) {
        const prefix = `${tree.path}/`.replace(/\/{2,}$/g, "/")
        const recorded = new Set(
          decoded.success.outputs
            .map((output) => output.path)
            .filter((path) => path.startsWith(prefix))
        )
        const entries = yield* treeEntries(host, tree.path)
        for (const path of entries.files) {
          if (!recorded.has(path)) yield* host.remove(path).pipe(Effect.mapError(hostFailure))
        }
        for (const directory of entries.directories) emptyDirectoryCandidates.add(directory)
      }
      for (const output of decoded.success.outputs) {
        if (output.digest === null) {
          // `force` IS the probe: the evidence says this path must not exist,
          // and a removal that finds it already gone has done its job. The
          // `exists` call that used to precede it was a second host call — a
          // second process on the confined host — for the same answer.
          yield* host.remove(output.path, { force: true }).pipe(Effect.mapError(hostFailure))
        } else {
          yield* materialize(host, output)
        }
      }
      // Remove only directories proven empty after pruning and
      // materialization. Deepest-first preserves every directory that still
      // contains a recorded child while clearing stale empty scaffolding.
      const directories = [...emptyDirectoryCandidates].sort((left, right) =>
        right.length - left.length || compareText(left, right)
      )
      for (const directory of directories) {
        const entries = yield* host.readDirectory(directory).pipe(Effect.mapError(hostFailure))
        if (entries.length === 0) yield* host.remove(directory).pipe(Effect.mapError(hostFailure))
      }
    })
  })
}

/**
 * Provides the filesystem-backed production boundary: `prepare` measures the
 * declared read set for real, `settle` detects reads mutated outside the
 * declared write set and captures the write set's post-state, and
 * `replayOutputs` re-materializes those outputs on cache-hit replay.
 *
 * Host access arrives through Effect's `FileSystem` tag, which the capability
 * kernel decorates in place — the same seam every host implementation (node,
 * bun, browser, sandbox) already provides. Blob storage arrives through
 * `@smthrs/artifacts`, so the same boundary runs over a purely local store or
 * over a local-plus-shared composition without knowing which it got.
 *
 * Replay confines its own mutations rather than trusting the composition:
 * they run through `@smthrs/kernel/FileSystem`'s `confined` view, rooted at
 * the kernel `Workspace` when one is in context. A symlink on a replayed path
 * (a parent, the final component, or a member of a replayed tree) and a host
 * with no descriptor-relative executor or isolation attestation both refuse
 * with {@link UnsupportedBoundary}, which the caller journals as
 * `replay_failed` before executing the step for real.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<Service, never, FileSystem.FileSystem | ArtifactStore.ArtifactStore> = Layer.effect(
  StepBoundary,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const artifacts = yield* ArtifactStore.ArtifactStore
    const workspace = yield* Effect.serviceOption(KernelWorkspace)
    return makeFileSystem(fs, artifacts, workspace._tag === "Some" ? { root: workspace.value.root } : {})
  })
)

/**
 * What the deterministic test boundary should pretend the host observed.
 *
 * Every field is a fixture, not a classification rule: a test supplies settlement
 * evidence or failure, the read snapshot, and whether the host claims
 * to support the boundary at all — then asserts on the resulting evidence or
 * refusal. Defaults describe a well-behaved, fully-supported host.
 *
 * @since 0.1.0
 * @category models
 */
export interface TestOptions {
  /** A settlement failure supplied verbatim by an integration fixture. */
  readonly failure?: UndeclaredWrite | MissingDeclaredOutput | SurvivingDeclaredRemoval | undefined
  /** Settlement evidence supplied verbatim; classification belongs to the real layer. */
  readonly deviation?: BoundaryDeviation | undefined
  /**
   * What `prepare` reports as measured for the declared read set. Defaults
   * to the declaration itself; a test supplies a different snapshot to stand
   * for a file whose content moved out from under a stale declaration
   * (issue #90).
   */
  readonly readSnapshot?: ReadonlyArray<FileInput> | undefined
  /** The opaque replay payload recorded in the evidence. */
  readonly declaredOutputs?: unknown
  /** The post-state identity the evidence names. Defaults to a fixed string. */
  readonly diffIdentity?: string | undefined
  /** When false, every call fails with {@link UnsupportedBoundary}. Defaults to true. */
  readonly supported?: boolean | undefined
  /** Whether the fixture attests a whole-tree observation. Defaults to true. */
  readonly wholeTreeWriteDetection?: boolean | undefined
  /** Whether the fixture models an isolated read surface. Defaults to true. */
  readonly hermeticReadDetection?: boolean | undefined
  /** Observes each `replayOutputs` call, so a test can assert replay happened. */
  readonly onReplay?: (evidence: BoundaryEvidence) => void
}

const unsupported = (): UnsupportedBoundary =>
  new UnsupportedBoundary({
    code: "unsupported_boundary",
    message: "the host cannot enforce the declared step boundary"
  })

/**
 * Deterministic in-memory boundary suitable only for tests. Production
 * wiring uses {@link layer}, the filesystem-backed implementation.
 *
 * Whole-tree change detection is supplied by sandboxed settlement, not by any
 * boundary layer: an isolated execution's transaction IS the tree, so
 * `ActionPersistence` compares its diff against the declared sets and sets
 * `wholeTreeWritesVerified` structurally (the retired piece-6 limitation).
 * {@link layer} still detects mutations within the declared read set only,
 * which is why unsandboxed evidence stays run-local.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerTest = (options: TestOptions = {}): Layer.Layer<Service> => {
  const diffIdentity = options.diffIdentity ?? "test-diff"
  const service = make({
    prepare: Effect.fn("StepBoundary.prepare")(function*(descriptor) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      return {
        descriptor,
        readSnapshot: options.readSnapshot ?? exactReads(descriptor)
      }
    }),
    settle: Effect.fn("StepBoundary.settle")(function*(prepared) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      if (options.failure !== undefined) return yield* Effect.fail(options.failure)
      return {
        declaredOutputs: options.declaredOutputs ?? { paths: prepared.descriptor.writeSet },
        diffIdentity,
        ...(options.wholeTreeWriteDetection === false ? {} : { wholeTreeWritesVerified: true as const }),
        ...(options.hermeticReadDetection === false ? {} : { hermeticReadsVerified: true as const }),
        ...(options.deviation === undefined ? {} : { deviation: options.deviation })
      }
    }),
    replayOutputs: Effect.fn("StepBoundary.replayOutputs")(function*(evidence) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      yield* Effect.sync(() => {
        options.onReplay?.(evidence)
      })
    })
  })
  return Layer.succeed(StepBoundary, service)
}
