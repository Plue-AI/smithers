/**
 * Functional workspace transactions for action execution.
 *
 * An action body normally mutates the host tree in place, which leaves the
 * engine two bad options: trust the declaration, or diff the whole repository
 * after the fact. This module takes the third one. The body runs against an
 * **isolated workspace** seeded with exactly its declared read set; its writes
 * are a value — a whole-tree diff — that reaches the host only through an
 * explicit {@link Service.materialize} step with preconditions and rollback.
 *
 * Two consequences follow, and they are the reason this exists:
 *
 * - **Whole-tree write observation is structural.** The transaction *is* the
 *   tree, so "did this body write outside its declared write set" is a map
 *   comparison, not an inference. `StepBoundary`'s filesystem layer can only
 *   re-measure paths it was told about, which is why it never claims
 *   `wholeTreeWritesVerified` and why nothing it settled could enter the
 *   cross-run cache.
 * - **The host is untouched until copy-back.** An execution whose observations
 *   contradict its declaration is {@link Invalidated}, and an invalidated
 *   result exposes provenance and violations *only* — never the candidate
 *   output, files, or queued effects.
 *
 * This is a **deterministic transaction model, not a security boundary** — the
 * same caveat the proof of concept carried. A body that reaches the host
 * through a service this module does not seed (a spawned native process, an
 * undecorated socket) is outside the transaction. Actually denying that
 * ambient access requires a machine boundary such as the providers in
 * `packages/smithers/flows/sandbox/docs/api.md`. The one host
 * write this module *does* perform is confined, however: copy-back resolves
 * symlinks before it lands a byte and refuses any target whose canonical
 * location escapes the workspace root.
 *
 * Settled bundles reach the host without a human review gate. Governing
 * design: `docs/concepts/workspace-transactions.md`.
 *
 * @since 0.1.0
 */

import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as FileLease from "@smthrs/artifacts/FileLease"
import { Sha256 } from "@smthrs/crypto"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Workspace as KernelWorkspace } from "@smthrs/kernel/Workspace"
import { DerivedKey } from "@smthrs/keys"
import * as FileSet from "@smthrs/plan/FileSet"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as RcMap from "effect/RcMap"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as EngineStoreMetrics from "./EngineStoreMetrics.ts"
import * as FileBoundarySnapshot from "./internal/FileBoundarySnapshot.ts"
import * as FileEnumeration from "./internal/FileEnumeration.ts"
import { compareText } from "./internal/Ordering.ts"

/**
 * A protocol-neutral resource named in execution provenance.
 *
 * `kind` leaves room for later database, object-store, or network resources;
 * this implementation records filesystem resources with `kind: "file"`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resource {
  readonly kind: string
  readonly id: string
}

/**
 * An input value actually consulted by an execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface InputObservation {
  readonly resource: Resource
  readonly digest: string
}

/**
 * An output value actually produced by an execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface OutputObservation {
  readonly resource: Resource
  readonly operation: "write" | "remove"
  readonly digest: string | undefined
}

/**
 * Observed data dependencies and products of one isolated execution.
 *
 * @category models
 * @since 0.1.0
 */
export interface Provenance {
  readonly baseRevision: string
  readonly inputs: ReadonlyArray<InputObservation>
  readonly outputs: ReadonlyArray<OutputObservation>
}

/**
 * One functional filesystem transformation.
 *
 * `beforeDigest` is a materialization precondition, never a hint: copy-back is
 * a compare-and-set against it. `afterDigest` is absent for a removal;
 * otherwise it addresses the file's complete post-state. `after` carries those
 * bytes inline when they fit the host's inline bound, and is absent when they
 * were spilled to the content-addressed artifact store under `afterDigest`.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileChange {
  readonly path: string
  readonly beforeDigest: string | undefined
  readonly afterDigest: string | undefined
  readonly after?: Uint8Array | undefined
}

/**
 * An external effect requested by an execution but deliberately **not**
 * dispatched inside its speculative transaction.
 *
 * A sandbox that dispatched these would have already sent the message when its
 * result turned out to be invalid, or would send it twice on a conflict retry.
 * Delivery and idempotency belong to a dispatch stage that runs after
 * copy-back settles; materializing file changes dispatches nothing.
 *
 * @category models
 * @since 0.1.0
 */
export interface QueuedEffect {
  readonly protocol: string
  readonly idempotencyKey: string
  readonly payload: unknown
}

/**
 * The generic functional result of one isolated execution.
 *
 * `output` is the body's ordinary return value and stays schema-typed — the
 * engine persists it as the action's recorded result, so it must be
 * JSON-encodable. It is deliberately not bytes: file products travel in
 * {@link FileChange}, which is content-addressed and can spill to the artifact
 * store, and folding them into the output would defeat both.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkflowResult<out Output = unknown> {
  readonly output: Output
  readonly files: ReadonlyArray<FileChange>
  readonly provenance: Provenance
  readonly effects: ReadonlyArray<QueuedEffect>
}

/**
 * A filesystem and effect-outbox view scoped to one workspace transaction.
 *
 * A body receives this service only while executing inside
 * {@link Service.execute}; every call mutates the isolated transaction and
 * never the host. It sits beside — and over the same transaction as — the
 * re-rooted Effect `FileSystem` the sandbox also seeds, so a body written
 * against either surface is isolated.
 *
 * @category services
 * @since 0.1.0
 */
export interface Workspace {
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, WorkspaceError>
  readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, WorkspaceError>
  readonly removeFile: (path: string) => Effect.Effect<void, WorkspaceError>
  readonly queueEffect: (effect: QueuedEffect) => Effect.Effect<void>
}

/**
 * Context service made available only inside a workspace transaction.
 *
 * @category services
 * @since 0.1.0
 */
export const Workspace: Context.Service<Workspace, Workspace> = Context.Service<Workspace>(
  "@smthrs/engine-store/WorkspaceSandbox/Workspace"
)

/**
 * The declaration and body submitted to a workspace sandbox.
 *
 * `descriptor` is the same {@link FileBoundary} the step key was derived from
 * and `StepBoundary` prepares against — an optimistic prediction the sandbox
 * validates against what the body actually did. The proof of concept carried
 * `Effects.Declaration` plus `KeyMaterial` here; on this side the declaration
 * vocabulary is `FileBoundary` and step identity is already the engine's, so
 * `cacheKey` is only an opaque memo address the caller may omit.
 *
 * @category models
 * @since 0.1.0
 */
export interface Execution<out Output, out Error> {
  readonly descriptor: FileBoundary
  readonly cacheKey?: string | undefined
  readonly workflow: Effect.Effect<Output, Error, Workspace | FileSystem.FileSystem>
}

/**
 * Why observed execution contradicted its declaration.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeclarationViolation {
  readonly kind: "undeclared-read" | "undeclared-write"
  readonly resource: Resource
}

/**
 * Memo outcome of an execution.
 *
 * The memo is a **run-local accelerator**, not the cross-run cache: the engine
 * owns that through `CacheStore` and the step key. `disabled` is what a caller
 * that supplied no `cacheKey` gets, and is the engine's ordinary case.
 *
 * A `hit` hands back the same {@link WorkflowResult} the miss produced rather
 * than a copy of it — the proof of concept deep-cloned, but cloning the output
 * needs `structuredClone`, and this port's output is not constrained to
 * `Schema.Json`. The transaction itself is still isolated (its reads and writes
 * copy bytes in both directions); what a caller must not do is mutate a
 * returned result in place and then ask for it again.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheOutcome =
  | { readonly status: "disabled" }
  | { readonly status: "miss"; readonly key: string }
  | { readonly status: "hit"; readonly key: string }

/**
 * An execution whose observations matched its declaration.
 *
 * Only this variant is accepted by {@link Service.materialize}, so invalidated
 * speculative changes cannot be applied by accident.
 *
 * @category models
 * @since 0.1.0
 */
export interface Accepted<out Output = unknown> {
  readonly _tag: "Accepted"
  readonly result: WorkflowResult<Output>
  readonly cache: CacheOutcome
  /**
   * Deviations the declaration did not predict. Empty in hard mode — that
   * execution is {@link Invalidated} instead — and, in expected mode, the
   * whole-tree evidence behind the deviation the engine journals.
   *
   * The proof of concept had no expected mode and so had no field here. It is
   * carried on the result rather than recomputed by the caller because only
   * the sandbox knows the root the declaration and the observations have to be
   * compared in.
   */
  readonly violations: ReadonlyArray<DeclarationViolation>
}

/**
 * An execution discarded because its observations contradicted its
 * declaration.
 *
 * The candidate output, file changes, and queued effects are intentionally
 * absent from this shape — there is no accessor that leaks them. Provenance
 * and violations remain so the engine can journal an honest reason and, in
 * expected mode, re-plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface Invalidated {
  readonly _tag: "Invalidated"
  readonly provenance: Provenance
  readonly violations: ReadonlyArray<DeclarationViolation>
}

/**
 * The result of validating one speculative execution.
 *
 * @category models
 * @since 0.1.0
 */
export type ExecutionResult<Output = unknown> = Accepted<Output> | Invalidated

/**
 * Stable workspace sandbox failure codes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WorkspaceErrorCode = Schema.Literals([
  "invalid_path",
  "not_found",
  "host_unavailable",
  "path_escapes_workspace",
  "commit_lock_timeout"
])

/**
 * Stable workspace sandbox failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkspaceErrorCode = typeof WorkspaceErrorCode.Type

/**
 * A body could not execute inside — or its result could not be moved through —
 * an isolated workspace.
 *
 * `cause` carries the refusing host or artifact-store failure whole, so a
 * debugger sees the original error instead of a flattened message
 * (`PlatformError`'s own convention).
 *
 * @category errors
 * @since 0.1.0
 */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()(
  "@smthrs/engine-store/WorkspaceError",
  {
    code: WorkspaceErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * Copy-back would overwrite host state that changed since the transaction's
 * base snapshot was taken.
 *
 * The engine answers this by retrying the attempt from a fresh base a bounded
 * number of times. This local retry is rebase-shaped. The worktree-lane
 * surface was removed; this error does not recreate it.
 *
 * @category errors
 * @since 0.1.0
 */
export class MaterializationConflict extends Schema.TaggedError<MaterializationConflict>()(
  "@smthrs/engine-store/MaterializationConflict",
  {
    paths: Schema.Array(
      Schema.NonEmptyString.check(Schema.isMaxLength(4_096))
    ).check(Schema.isMaxLength(1_024)),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(16_384))
  }
) {}

/**
 * Whether a failure is a materialization conflict in live or durable form.
 * Persisted failures retain the schema tag but not the class prototype, so
 * replay classification must recognize both representations.
 *
 * @category guards
 * @since 0.1.0
 */
export const isMaterializationConflict = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  try {
    if (error instanceof MaterializationConflict) return true
    const own = (name: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(error, name)
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor
        ? descriptor.value
        : undefined
    }
    const paths = own("paths")
    const message = own("message")
    if (
      own("_tag") !== MaterializationConflict.identifier ||
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > 16_384 ||
      !Array.isArray(paths) ||
      Object.getPrototypeOf(paths) !== Array.prototype ||
      paths.length > 1_024
    ) return false
    for (let index = 0; index < paths.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(paths, String(index))
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length === 0 ||
        descriptor.value.length > 4_096
      ) return false
    }
    if (
      Reflect.ownKeys(paths).some((key) =>
        key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= paths.length)
      )
    ) return false
    return Reflect.ownKeys(error).every((key) => key === "_tag" || key === "paths" || key === "message")
  } catch {
    return false
  }
}

/**
 * The two-phase workspace transaction service.
 *
 * `execute` is speculative and never touches the host. `materialize` is the
 * only host write. See its filesystem failure limits below.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly execute: <Output, Error>(
    execution: Execution<Output, Error>
  ) => Effect.Effect<ExecutionResult<Output>, Error | WorkspaceError, Crypto.Crypto>
  /**
   * Checks all copy-back preconditions before applying any file change.
   * The filesystem host serializes cooperating commits through confinement,
   * preflight, apply, and rollback. On apply failure it attempts restoration
   * from an in-memory pre-image journal; this is not crash-atomic. A failed
   * rollback returns a compound cause containing both the apply failure and
   * a `WorkspaceError` carrying the rollback cause. The caller must reconcile
   * host files after a crash or failed rollback before resuming work.
   *
   * Filesystem coordination reserves `.smithers-workspace-lock` under the
   * root, and copy-back refuses the `.flows` engine state directory plus any
   * `FileSystemOptions.reservedPaths`, whatever the write set or mode. The
   * lock is an `@smthrs/artifacts/FileLease`: a killed holder's lock is
   * reclaimed once its heartbeat is 60 seconds old, and a commit that cannot
   * take it within 2 minutes fails with `commit_lock_timeout` before changing
   * anything. Writers that ignore the lock are outside this guarantee.
   */
  readonly materialize: <Output>(
    accepted: Accepted<Output>
  ) => Effect.Effect<void, MaterializationConflict | WorkspaceError, Crypto.Crypto>
}

/**
 * Context service for the selected workspace sandbox implementation.
 *
 * @category services
 * @since 0.1.0
 */
export const WorkspaceSandbox: Context.Service<Service, Service> = Context.Service<Service>(
  "@smthrs/engine-store/WorkspaceSandbox"
)

/**
 * Constructs a workspace sandbox from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (service: Service): Service => WorkspaceSandbox.of(service)

/**
 * Provides a workspace sandbox implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (service: Service): Layer.Layer<Service> => Layer.succeed(WorkspaceSandbox, make(service))

/**
 * Delivery for the effects a transaction queued but refused to send.
 *
 * The engine runs this **after** copy-back settles, never inside the
 * transaction: an effect dispatched speculatively has already reached the
 * world when its execution turns out to be invalid, and has reached it twice
 * when copy-back loses a race and the body re-runs. Deduplication is by
 * {@link QueuedEffect.idempotencyKey}, which is the same key
 * `docs/concepts/workspace-transactions.md` requires before an irreversible
 * effect may be retried at all.
 *
 * @category services
 * @since 0.1.0
 */
export interface Dispatcher {
  readonly dispatch: (effect: QueuedEffect) => Effect.Effect<void>
}

/**
 * Context service for the queued-effect dispatch stage. Optional: with no
 * dispatcher provided the engine journals what a transaction queued and sends
 * nothing.
 *
 * @category services
 * @since 0.1.0
 */
export const EffectDispatcher: Context.Service<Dispatcher, Dispatcher> = Context.Service<Dispatcher>(
  "@smthrs/engine-store/WorkspaceSandbox/EffectDispatcher"
)

/**
 * Provides a queued-effect dispatch stage.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerDispatcher = (dispatcher: Dispatcher): Layer.Layer<Dispatcher> =>
  Layer.succeed(EffectDispatcher, EffectDispatcher.of(dispatcher))

// -----------------------------------------------------------------------------
// path vocabulary
// -----------------------------------------------------------------------------

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const invalidPath = (path: string): WorkspaceError =>
  new WorkspaceError({
    code: "invalid_path",
    message: `Workspace paths must be relative paths inside the workspace without '..': ${path}`
  })

/**
 * Normalizes a caller path to a workspace-relative key.
 *
 * Absolute paths are accepted only under `root`, which is how a body that
 * resolved `workspace.root` itself still lands inside the transaction; every
 * other absolute path, and anything traversing upward, is refused rather than
 * silently confined.
 */
const normalizePath = (root: string, path: string, allowRoot = false): Result.Result<string, WorkspaceError> => {
  const slashed = path.replaceAll("\\", "/")
  const slashedRoot = root.replaceAll("\\", "/")
  const rooted = slashed === slashedRoot
    ? ""
    : slashedRoot !== "" && slashed.startsWith(`${slashedRoot}/`)
    ? slashed.slice(slashedRoot.length + 1)
    : slashed
  const parts = rooted.split("/")
  if (rooted.startsWith("/") || parts.some((part) => part === "..")) return Result.fail(invalidPath(path))
  const compact = parts.filter((part) => part !== "" && part !== ".").join("/")
  return compact === "" && !allowRoot ? Result.fail(invalidPath(path)) : Result.succeed(compact)
}

/**
 * Whether a declared write-set entry covers an observed path. Entries are
 * ordinarily literal paths (what `StepBoundary` captures); `*` and `**` are
 * honored so a declaration written as a glob per
 * `packages/smithers/flows/plan/docs/api.md` still means what it says.
 */
const covers = (entry: FileSet.Entry, path: string): boolean =>
  typeof entry === "string"
    ? entry === path || (entry.includes("*") && FileSet.matchesPattern(entry, path))
    : entry._tag === "TreeArtifact"
    ? path === entry.path || path.startsWith(`${entry.path}/`)
    : FileSet.matchesGlob(entry, path)

const resource = (path: string): Resource => ({ kind: "file", id: path })

/**
 * Restates a declaration in the transaction's own path vocabulary.
 *
 * A caller may declare `out/result.txt` or the absolute path the same file has
 * on the host — the kernel-decorated `FileSystem` accepts both, so the
 * declaration does too. Observed paths are always workspace-relative, so the
 * declaration has to be brought to the same footing before anything is
 * compared against it, or an absolute declaration would cover nothing and
 * every write would read as undeclared. An entry that cannot be named inside
 * the workspace is kept verbatim: it covers nothing, which is the honest
 * answer for a declaration pointing outside the tree.
 */
const workspaceRelative = (root: string, descriptor: FileBoundary): FileBoundary => {
  const relative = (path: string): string => {
    const normalized = normalizePath(root, path)
    return Result.isFailure(normalized) ? path : normalized.success
  }
  return {
    readSet: descriptor.readSet.map((entry) =>
      FileSet.isGlob(entry)
        ? {
          ...entry,
          include: [relative(entry.include[0]), ...entry.include.slice(1).map(relative)],
          ...(entry.exclude === undefined ? {} : { exclude: entry.exclude.map(relative) })
        }
        : { ...entry, path: relative(entry.path) }
    ),
    writeSet: descriptor.writeSet.map((entry) =>
      typeof entry === "string"
        ? relative(entry)
        : entry._tag === "TreeArtifact"
        ? { ...entry, path: relative(entry.path) }
        : {
          ...entry,
          include: [relative(entry.include[0]), ...entry.include.slice(1).map(relative)],
          ...(entry.exclude === undefined ? {} : { exclude: entry.exclude.map(relative) })
        }
    ),
    ...(descriptor.removes === undefined ? {} : { removes: descriptor.removes.map(relative) }),
    boundaryMode: descriptor.boundaryMode
  }
}

const digestOf = (bytes: Uint8Array): Effect.Effect<string, never, Crypto.Crypto> =>
  Schema.decodeUnknownEffect(Sha256)(bytes).pipe(Effect.orDie)

const parentDirectory = (path: string): string | undefined => {
  const index = path.lastIndexOf("/")
  return index <= 0 ? undefined : path.slice(0, index)
}

// -----------------------------------------------------------------------------
// the host seam
// -----------------------------------------------------------------------------

/**
 * Everything a workspace sandbox needs from the world it isolates bodies from.
 *
 * Splitting it out is what lets one transaction implementation serve both an
 * in-memory host (tests, browsers, and the conformance suite) and a real
 * filesystem host: the transaction, the diff, the violation check, and the
 * provenance are identical, and only *where the base comes from* and *where
 * copy-back lands* differ.
 *
 * @category models
 * @since 0.1.0
 */
export interface Host {
  /**
   * The transaction's base. A host that can seed exactly the declared read set
   * does so — a body then cannot read an undeclared file because it is not
   * there, which is the strong tier of `Effect Taxonomy.md`. A host that hands
   * back a wider tree gets the same guarantees post hoc, through the
   * undeclared-read check.
   */
  readonly snapshot: (
    descriptor: FileBoundary
  ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, WorkspaceError, Crypto.Crypto>
  /**
   * The host's current digest for a path the transaction never observed, or
   * `undefined` when the host holds nothing there.
   *
   * A host that seeds only the declared read set does not know what else is on
   * disk, and "absent from the seed" is emphatically **not** "absent from the
   * host": a body writing a declared output it never declared as a read is the
   * ordinary case, and that file usually already exists from a previous run.
   * Treating the seed as the whole world made every such copy-back a
   * {@link MaterializationConflict} the engine could only rebase into the same
   * refusal, and made an identical rewrite look like a change.
   *
   * The digest this returns is therefore the change's `beforeDigest`. A blind
   * write cannot carry a compare-and-set over the body's whole execution — the
   * body never read the prior content, so there is nothing it could have
   * depended on — but copy-back still refuses if the path moves again between
   * the diff and the commit.
   */
  readonly baseline: (
    path: string
  ) => Effect.Effect<string | undefined, WorkspaceError, Crypto.Crypto>
  /**
   * Decides whether a produced file's bytes travel inline in its
   * {@link FileChange} or by content address. Returning `undefined` means the
   * bytes were retained under the change's `afterDigest` and must be fetched
   * back at copy-back.
   */
  readonly retain: (
    bytes: Uint8Array
  ) => Effect.Effect<Uint8Array | undefined, WorkspaceError, Crypto.Crypto>
  /**
   * Applies the diff as a compare-and-set on every `beforeDigest`. Hosts must
   * serialize preflight through apply and rollback with competing commits.
   * Check every precondition before changing files; on apply failure attempt
   * to restore every touched path and preserve both causes if rollback fails.
   * Crash recovery and host reconciliation remain the caller's responsibility.
   */
  readonly commit: (
    changes: ReadonlyArray<FileChange>
  ) => Effect.Effect<void, MaterializationConflict | WorkspaceError, Crypto.Crypto>
  /** The absolute root absolute host paths are interpreted against. */
  readonly root: string
}

// -----------------------------------------------------------------------------
// the transaction
// -----------------------------------------------------------------------------

/**
 * Reads are recorded as bytes and hashed once, after the body returns.
 * Digesting inside `readFile` would put `Crypto` in the error-free signature
 * Effect's own `FileSystem` fixes, and a body must see the tag's real shape.
 */
interface Trace {
  readonly inputs: Array<{ readonly path: string; readonly content: Uint8Array }>
  readonly attemptedReads: Array<{ readonly path: string; readonly produced: boolean }>
  readonly effects: Array<QueuedEffect>
}

const notFound = (path: string): WorkspaceError =>
  new WorkspaceError({ code: "not_found", message: `Workspace file does not exist: ${path}` })

/**
 * The transaction surfaces: the {@link Workspace} tag and a re-rooted Effect
 * `FileSystem`, both over one path-keyed map.
 *
 * The `FileSystem` is built from `makeNoop` on purpose. Only the operations
 * listed here are meaningful over a functional map, and a body reaching for
 * one that is not — a temp file, a watch, a stream — gets the platform's own
 * refusal rather than a plausible lie. Widening the surface is a deliberate
 * change to this list, never a silent default.
 */
const transaction = (base: ReadonlyMap<string, Uint8Array>, trace: Trace, root: string) => {
  const files = new Map(base)
  const produced = new Set<string>()
  const resolvePath = (path: string, allowRoot = false): Effect.Effect<string, WorkspaceError> => {
    const normalized = normalizePath(root, path, allowRoot)
    return Result.isFailure(normalized) ? Effect.fail(normalized.failure) : Effect.succeed(normalized.success)
  }
  const readBytes = Effect.fn("WorkspaceSandbox.read")(function*(path: string) {
    const key = yield* resolvePath(path)
    trace.attemptedReads.push({ path: key, produced: produced.has(key) })
    const content = files.get(key)
    if (content === undefined) return yield* Effect.fail(notFound(key))
    trace.inputs.push({ path: key, content })
    return content.slice()
  })
  const writeBytes = Effect.fn("WorkspaceSandbox.write")(function*(path: string, content: Uint8Array) {
    const key = yield* resolvePath(path)
    produced.add(key)
    files.set(key, content.slice())
  })
  const removePath = Effect.fn("WorkspaceSandbox.remove")(function*(path: string) {
    const key = yield* resolvePath(path)
    produced.add(key)
    files.delete(key)
  })
  const workspace = Workspace.of({
    readFile: (path) => readBytes(path),
    writeFile: (path, content) => writeBytes(path, content),
    removeFile: (path) => removePath(path),
    queueEffect: (effect) => Effect.sync(() => trace.effects.push(effect))
  })
  const refuse = (method: string, path: string) => (error: WorkspaceError) =>
    error.code === "not_found"
      ? PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method,
        description: error.message,
        pathOrDescriptor: path
      })
      : PlatformError.badArgument({ module: "FileSystem", method, description: error.message })
  const fileSystem = FileSystem.makeNoop({
    // `exists` and `readDirectory` trace every PRESENCE they reveal: under a
    // whole-tree-seeding host the map holds undeclared world state, and a
    // probe that observes it is a read the key never folded. Absence stays
    // untraced — under the declared-set host an undeclared path is absent by
    // construction, the Bazel forest's own deterministic answer.
    exists: (path) =>
      resolvePath(path, true).pipe(
        Effect.map((key) => {
          if (key === "") return true
          if (files.has(key)) {
            trace.attemptedReads.push({ path: key, produced: produced.has(key) })
            return true
          }
          const prefix = `${key}/`
          let present = false
          for (const candidate of files.keys()) {
            if (!candidate.startsWith(prefix)) continue
            trace.attemptedReads.push({ path: candidate, produced: produced.has(candidate) })
            present = true
          }
          return present
        }),
        // A path the transaction cannot even name does not exist in it; that
        // is an answer, not a host failure.
        Effect.catch(() => Effect.succeed(false))
      ),
    readFile: (path) => readBytes(path).pipe(Effect.mapError(refuse("readFile", path))),
    readFileString: (path) =>
      readBytes(path).pipe(
        Effect.map((bytes) => decoder.decode(bytes)),
        Effect.mapError(refuse("readFileString", path))
      ),
    writeFile: (path, data) => writeBytes(path, data).pipe(Effect.mapError(refuse("writeFile", path))),
    writeFileString: (path, data) =>
      writeBytes(path, encoder.encode(data)).pipe(Effect.mapError(refuse("writeFileString", path))),
    remove: (path) => removePath(path).pipe(Effect.mapError(refuse("remove", path))),
    // Directories are implicit in a path-keyed map: creating one is a
    // successful no-op so a body that mirrors ordinary filesystem discipline
    // works unchanged, and listing one is a prefix scan.
    makeDirectory: () => Effect.void,
    readDirectory: (path) =>
      resolvePath(path, true).pipe(
        Effect.map((key) => {
          const prefix = key === "" ? "" : `${key}/`
          const entries = new Set<string>()
          for (const candidate of files.keys()) {
            if (!candidate.startsWith(prefix)) continue
            // A listing reveals each file it names, so each is a traced read.
            trace.attemptedReads.push({ path: candidate, produced: produced.has(candidate) })
            entries.add(candidate.slice(prefix.length).split("/")[0]!)
          }
          return [...entries].sort(compareText)
        }),
        Effect.mapError(refuse("readDirectory", path))
      )
  })
  return { files, workspace, fileSystem }
}

const changes = Effect.fn("WorkspaceSandbox.changes")(function*(
  base: ReadonlyMap<string, Uint8Array>,
  current: ReadonlyMap<string, Uint8Array>,
  host: Host
) {
  const paths = [...new Set([...base.keys(), ...current.keys()])].sort(compareText)
  const result: Array<FileChange> = []
  for (const path of paths) {
    const before = base.get(path)
    const after = current.get(path)
    // A path the transaction never observed is not a path the host lacks: ask
    // the host what is there before claiming the change creates it.
    const beforeDigest = before === undefined ? yield* host.baseline(path) : yield* digestOf(before)
    const afterDigest = after === undefined ? undefined : yield* digestOf(after)
    if (beforeDigest === afterDigest) continue
    result.push({
      path,
      beforeDigest,
      afterDigest,
      ...(after === undefined ? {} : { after: yield* host.retain(after) })
    })
  }
  return result
})

/**
 * The compare-and-set every copy-back runs before it writes a single byte,
 * capturing each target's pre-image while it looks.
 *
 * Both hosts share it, so "all-or-nothing" cannot drift between the in-memory
 * conformance implementation and the filesystem one: a bundle whose base moved
 * is refused whole, and the tree is left exactly as it was found. The captured
 * pre-images are the rollback journal the filesystem host restores from when a
 * mid-apply refusal would otherwise strand a half-written tree.
 */
const preflight = Effect.fn("WorkspaceSandbox.preflight")(function*(
  changes: ReadonlyArray<FileChange>,
  current: (path: string) => Effect.Effect<Uint8Array | undefined, WorkspaceError, Crypto.Crypto>
) {
  const conflicting: Array<string> = []
  const before = new Map<string, Uint8Array | undefined>()
  for (const change of changes) {
    const content = yield* current(change.path)
    before.set(change.path, content)
    const digest = content === undefined ? undefined : yield* digestOf(content)
    conflicting.push(...(digest === change.beforeDigest ? [] : [change.path]))
  }
  const conflict = conflicting.length === 0 ? undefined : new MaterializationConflict({
    paths: conflicting,
    message: "Workspace state changed after the transaction's base snapshot was taken"
  })
  return { conflict, before }
})

const revisionOf = Effect.fn("WorkspaceSandbox.revision")(function*(base: ReadonlyMap<string, Uint8Array>) {
  const entries: Array<{ readonly path: string; readonly digest: string }> = []
  for (const [path, content] of [...base].sort((left, right) => compareText(left[0], right[0]))) {
    entries.push({ path, digest: yield* digestOf(content) })
  }
  return yield* Schema.decodeUnknownEffect(DerivedKey)({ kind: "workspace-revision", entries }).pipe(Effect.orDie)
})

/**
 * Everything the declaration failed to predict, deduplicated.
 *
 * Reads and writes are checked against the declaration's exact paths and patterns; writes
 * against the declared write set's patterns. A read of a file the body itself
 * produced is not undeclared — the transaction, not the host, supplied it.
 *
 * @category accessors
 * @since 0.1.0
 */
export const violations = (
  descriptor: FileBoundary,
  base: ReadonlyMap<string, Uint8Array>,
  provenance: Provenance
): ReadonlyArray<DeclarationViolation> => {
  const declaredReads = descriptor.readSet
  const observed: Array<DeclarationViolation> = [
    ...provenance.inputs
      .filter((input) =>
        base.has(input.resource.id) &&
        !declaredReads.some((entry) =>
          FileSet.isGlob(entry) ? FileSet.matchesGlob(entry, input.resource.id) : entry.path === input.resource.id
        )
      )
      .map((input): DeclarationViolation => ({ kind: "undeclared-read", resource: input.resource })),
    ...provenance.outputs
      .filter((output) =>
        ![...descriptor.writeSet, ...descriptor.removes ?? []].some((entry) => covers(entry, output.resource.id))
      )
      .map((output): DeclarationViolation => ({ kind: "undeclared-write", resource: output.resource }))
  ]
  return [
    ...new Map(observed.map((violation) => [`${violation.kind}:${violation.resource.id}`, violation])).values()
  ]
}

/**
 * Builds a workspace sandbox over a {@link Host}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHosted = (host: Host): Service => {
  const memo = new Map<
    string,
    { readonly result: WorkflowResult<never>; readonly violations: ReadonlyArray<DeclarationViolation> }
  >()
  /**
   * The speculative half, untraced: the `execute` span below wraps it, so
   * the transaction body reports under one span with its metrics.
   */
  const executeBody = Effect.fnUntraced(function*<Output, Error>(
    execution: Execution<Output, Error>
  ) {
    const boundary = FileBoundarySnapshot.make(execution.descriptor)
    const key = execution.cacheKey
    if (key !== undefined) {
      const hit = memo.get(key)
      if (hit !== undefined) {
        return {
          _tag: "Accepted" as const,
          result: hit.result as unknown as WorkflowResult<Output>,
          violations: hit.violations,
          cache: { status: "hit" as const, key }
        }
      }
    }
    const captured = yield* host.snapshot(boundary)
    // The host owns its returned buffers. Preserve the instant represented by
    // snapshot() even if that host or another fiber mutates them while the
    // workflow is suspended.
    const base = new Map([...captured].map(([path, content]) => [path, content.slice()]))
    const trace: Trace = { inputs: [], attemptedReads: [], effects: [] }
    const isolated = transaction(base, trace, host.root)
    const outcome = yield* execution.workflow.pipe(
      Effect.provideService(Workspace, isolated.workspace),
      Effect.provideService(FileSystem.FileSystem, isolated.fileSystem),
      Effect.exit
    )
    const inputs: Array<InputObservation> = []
    for (const input of trace.inputs) {
      inputs.push({ resource: resource(input.path), digest: yield* digestOf(input.content) })
    }
    const descriptor = workspaceRelative(host.root, boundary)
    const undeclaredReads = trace.attemptedReads.filter((attempt) =>
      !attempt.produced &&
      !descriptor.readSet.some((entry) =>
        FileSet.isGlob(entry) ? FileSet.matchesGlob(entry, attempt.path) : entry.path === attempt.path
      )
    )
    if (Exit.isFailure(outcome)) {
      // Hard mode only, mirroring the success path below: in expected mode
      // an undeclared read is a deviation the engine journals, and a body's
      // own typed failure must surface as itself — converting it into an
      // isolation verdict would both harden a soft boundary and mask the
      // error the retry policy classifies on.
      if (undeclaredReads.length > 0 && boundary.boundaryMode === "hard") {
        return {
          _tag: "Invalidated" as const,
          provenance: {
            baseRevision: yield* revisionOf(base),
            inputs,
            outputs: []
          },
          violations: [
            ...new Map(undeclaredReads.map((attempt) => [attempt.path, {
              kind: "undeclared-read" as const,
              resource: resource(attempt.path)
            }])).values()
          ]
        }
      }
      return yield* Effect.failCause(outcome.cause)
    }
    const output = outcome.value
    const files = yield* changes(base, isolated.files, host)
    const provenance: Provenance = {
      baseRevision: yield* revisionOf(base),
      inputs,
      outputs: files.map((change) => ({
        resource: resource(change.path),
        operation: change.afterDigest === undefined ? "remove" as const : "write" as const,
        digest: change.afterDigest
      }))
    }
    const invalid = [
      ...new Map([
        ...violations(descriptor, base, provenance),
        ...undeclaredReads.map((attempt) => ({
          kind: "undeclared-read" as const,
          resource: resource(attempt.path)
        }))
      ].map((violation) => [`${violation.kind}:${violation.resource.id}`, violation])).values()
    ]
    // Hard mode discards; expected mode admits the result and leaves the
    // deviation for the engine to journal and reconcile
    // (`Effect Taxonomy.md`, "Expected sets — the soft mode"). Either way
    // the host has not been touched.
    if (invalid.length > 0 && boundary.boundaryMode === "hard") {
      return { _tag: "Invalidated" as const, provenance, violations: invalid }
    }
    const result: WorkflowResult<Output> = { output, files, provenance, effects: trace.effects }
    if (key !== undefined) {
      memo.set(key, { result: result as unknown as WorkflowResult<never>, violations: invalid })
    }
    return {
      _tag: "Accepted" as const,
      result,
      violations: invalid,
      cache: key === undefined ? { status: "disabled" as const } : { status: "miss" as const, key }
    }
  })
  return make({
    execute: Effect.fn("WorkspaceSandbox.execute")(
      function*<Output, Error>(
        execution: Execution<Output, Error>
      ) {
        yield* Effect.annotateCurrentSpan({ boundaryMode: execution.descriptor.boundaryMode })
        return yield* executeBody(execution)
      },
      (effect) =>
        EngineStoreMetrics.observe({
          timer: EngineStoreMetrics.sandboxExecutionDuration,
          counter: EngineStoreMetrics.sandboxExecution
        })(effect)
    ),
    materialize: Effect.fn("WorkspaceSandbox.materialize")(
      function*<Output>(accepted: Accepted<Output>) {
        yield* Effect.annotateCurrentSpan({ changes: accepted.result.files.length })
        // Nothing to copy back needs no commit: a body that changed nothing
        // (a sealed read) must not need write authority over the root.
        if (accepted.result.files.length === 0) return
        yield* host.commit(accepted.result.files)
      },
      (effect) =>
        EngineStoreMetrics.observe({
          timer: EngineStoreMetrics.materializationDuration,
          counter: EngineStoreMetrics.materialization
        })(effect)
    )
  })
}

// -----------------------------------------------------------------------------
// the in-memory host
// -----------------------------------------------------------------------------

/**
 * Initial file contents accepted by {@link makeMemory}.
 *
 * @category models
 * @since 0.1.0
 */
export type InitialFiles = Readonly<Record<string, string | Uint8Array>>

/**
 * A host file snapshot exposed by the deterministic in-memory implementation.
 *
 * @category models
 * @since 0.1.0
 */
export interface HostFile {
  readonly path: string
  readonly content: Uint8Array
}

/**
 * The deterministic in-memory sandbox plus read-only test observations.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemorySandbox {
  readonly service: Service
  readonly files: Effect.Effect<ReadonlyArray<HostFile>>
}

/**
 * Creates a deterministic in-memory workspace sandbox.
 *
 * The returned `files` effect observes *host* state, not a running
 * transaction: it changes only through `service.materialize`. This host hands
 * the transaction its whole tree rather than seeding the declared read set, so
 * an undeclared read is observable — which is exactly what makes it the
 * conformance implementation for the bare tier of `Effect Taxonomy.md`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (
  initialFiles: InitialFiles = {}
): Effect.Effect<MemorySandbox, WorkspaceError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const entries: Array<readonly [string, Uint8Array]> = []
    for (const [path, content] of Object.entries(initialFiles)) {
      const normalized = normalizePath("", path)
      if (Result.isFailure(normalized)) return yield* Effect.fail(normalized.failure)
      entries.push([normalized.success, typeof content === "string" ? encoder.encode(content) : content.slice()])
    }
    const host = yield* Ref.make<ReadonlyMap<string, Uint8Array>>(new Map(entries))
    const service = makeHosted({
      root: "",
      snapshot: () => Ref.get(host),
      // This host seeds the transaction with the WHOLE tree, so a path the
      // transaction did not observe is one the host genuinely did not hold:
      // `undefined` is the honest snapshot-time answer, and a file that
      // appeared underneath the transaction is caught by copy-back's
      // compare-and-set rather than clobbered.
      baseline: () => Effect.succeed(undefined),
      retain: (bytes) => Effect.succeed(bytes.slice()),
      commit: Effect.fn("WorkspaceSandbox.commit")(function*(changes) {
        yield* Effect.annotateCurrentSpan({ changes: changes.length })
        const current = yield* Ref.get(host)
        const { conflict } = yield* preflight(changes, (path) => Effect.succeed(current.get(path)))
        if (conflict !== undefined) {
          yield* Metric.update(EngineStoreMetrics.materializationConflicts, 1)
          return yield* Effect.fail(conflict)
        }
        const next = new Map(current)
        for (const change of changes) {
          if (change.afterDigest === undefined) next.delete(change.path)
          else next.set(change.path, change.after!.slice())
        }
        yield* Ref.set(host, next)
      })
    })
    return {
      service,
      files: Ref.get(host).pipe(
        Effect.map((current) =>
          [...current]
            .map(([path, content]) => ({ path, content }))
            .sort((left, right) => compareText(left.path, right.path))
        )
      )
    }
  })

// -----------------------------------------------------------------------------
// the filesystem host
// -----------------------------------------------------------------------------

/**
 * Filesystem workspace sandbox options.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileSystemOptions {
  /**
   * The largest produced file (in bytes) carried inline in its
   * {@link FileChange}. Anything larger is retained in the content-addressed
   * artifact store and fetched back at copy-back. Defaults to 1 MiB, matching
   * `StepBoundary`'s evidence bound.
   */
  readonly maxInlineBytes?: number | undefined
  /**
   * Root-relative paths copy-back refuses to write or remove, in addition to
   * the always-reserved `.smithers-workspace-lock` and `.flows` directories.
   * Name the engine database, its `-wal`/`-shm` siblings, and the artifact
   * directory here when they live under the root outside `.flows`. A
   * reserved directory also reserves every path beneath it.
   */
  readonly reservedPaths?: ReadonlyArray<string> | undefined
}

// Shared across separately constructed sandboxes. Entries live only while a
// commit is running or waiting, so short-lived workspace roots do not leak.
const CommitLocks = Context.Service<RcMap.RcMap<string, Semaphore.Semaphore>>(
  "@smthrs/engine-store/WorkspaceSandbox/CommitLocks"
)
const locksLayer = Layer.effect(CommitLocks, RcMap.make({ lookup: (_root: string) => Semaphore.make(1) }))
// The memo map shares the layer across active operations, including operations
// from different store instances. Their scopes release the final owner.
const lockOwners = Layer.makeMemoMapUnsafe()

const coordinateCommit = <A, E, R>(root: string, write: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.scoped(Effect.gen(function*() {
    const services = yield* Layer.buildWithMemoMap(locksLayer, lockOwners, yield* Scope.Scope)
    const lock = yield* RcMap.get(Context.get(services, CommitLocks), root)
    return yield* lock.withPermit(write)
  }))

const commitLockName = ".smithers-workspace-lock"
// The conventional engine state directory: the SQLite store, its WAL/SHM
// siblings, and the artifact objects. A step body must never replace them.
const engineStateName = ".flows"

const defaultMaxInlineBytes = 1024 * 1024

const hostFailure = (cause: unknown): WorkspaceError =>
  new WorkspaceError({
    code: "host_unavailable",
    message: "the host filesystem could not serve the workspace transaction",
    cause
  })

const artifactFailure = (cause: { readonly message: string }): WorkspaceError =>
  new WorkspaceError({
    code: "host_unavailable",
    message: `the artifact store could not serve the workspace transaction: ${cause.message}`,
    cause
  })

/**
 * The errno names the descriptor-relative host reports when it refuses to
 * resolve a path inside its pinned root: a symlink at the final component
 * (`ELOOP`); a symlink at an intermediate component (`ELOOP` on Linux,
 * `ENOTDIR` on Darwin, which also covers a file standing where a directory
 * must be); or `..` traversal, a path outside the root, a hard-linked file, or
 * a root whose identity changed (`EPERM`). Each means the change does not
 * name a workspace entry reachable without following a link.
 */
const confinementCodes: ReadonlySet<unknown> = new Set(["ELOOP", "ENOTDIR", "EPERM"])

const refusedByConfinement = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag !== "BadArgument" &&
  typeof error.reason.cause === "object" && error.reason.cause !== null &&
  confinementCodes.has((error.reason.cause as { readonly code?: unknown }).code)

/** Maps one copy-back host failure onto the sandbox's typed error codes. */
const copyBackFailure = (path: string) => (error: PlatformError.PlatformError): WorkspaceError =>
  refusedByConfinement(error)
    ? new WorkspaceError({
      code: "path_escapes_workspace",
      message:
        `materializing ${path} was refused: it does not name a workspace entry reachable without following a link (${error.message})`,
      cause: error
    })
    : hostFailure(error)

/**
 * Maps a commit-lock failure: a missed acquisition deadline is
 * `commit_lock_timeout`, so a caller can tell "another writer holds the root"
 * from "the host refused".
 */
const lockFailure = (cause: unknown): WorkspaceError =>
  Cause.isTimeoutError(cause)
    ? new WorkspaceError({
      code: "commit_lock_timeout",
      message:
        `another writer held ${commitLockName} for the whole acquisition deadline; a lock whose owner stopped is reclaimed once its heartbeat is ${FileLease.defaultStaleAfterMs} ms old`,
      cause
    })
    // `FileLease` hands every other refusal over as the host's `PlatformError`.
    : copyBackFailure(commitLockName)(cause as PlatformError.PlatformError)

/**
 * Builds the filesystem-backed workspace sandbox.
 *
 * **Copy-in, not overlay.** The transaction is seeded with exactly the
 * declared read set and nothing else
 * (`docs/concepts/workspace-transactions.md`). Bazel uses the same strategy, which
 * is why whole-tree write observation is structural here. Re-rooting a
 * body onto a bare host tree instead would leave every undeclared file
 * readable and reduce enforcement to the taxonomy's weakest, post-hoc
 * detection-by-diff tier; and the OS-level overlay that would fix that is not
 * reachable through Effect's `FileSystem` tag, so it could not run in a
 * browser. Seeding costs a copy of the declared reads and buys both.
 *
 * **Copy-back is confined and journaled.** Every copy-back host call (the
 * lock, preflight, apply, and rollback) goes through
 * `@smthrs/kernel/FileSystem`'s `confined` view: one descriptor-relative,
 * no-follow request against the workspace root pinned when the commit starts.
 * A symlink anywhere on a change's path, a hard-linked file, or a root
 * replaced mid-commit is refused with `path_escapes_workspace`, never
 * followed, and no check-then-write window exists for a concurrent process to
 * swap a link into. A copy-back through a symlink that stays inside the root
 * is refused too: the body writes the referent path itself. `fs` must
 * therefore carry the kernel's descriptor-relative executor (Node and Bun
 * hosts use `@smthrs/platform-node`'s `AtomicFileSystem`) or a
 * whole-filesystem isolation attestation (`withIsolatedFileSystem`, for an
 * in-memory volume); a plain path-based host is refused at copy-back with
 * `host_unavailable`. Snapshot reads use `fs` as given. A root-keyed semaphore and
 * the `.smithers-workspace-lock` lease file (`@smthrs/artifacts/FileLease`)
 * serialize cooperating callers, including separate processes. Preconditions run before file
 * changes, and the apply loop keeps each target's pre-image for in-process
 * rollback. A crash or rollback failure can leave partial changes; see
 * {@link Service.materialize} for the caller's reconciliation obligations.
 * Hosts must implement exclusive `wx` file creation, `stat` with an mtime,
 * `utimes`, `rename`, and `remove` for the reserved lock. Copy-back
 * also refuses the `.flows` engine state directory and any
 * {@link FileSystemOptions.reservedPaths}, so no write set or boundary mode
 * lets a step body replace the engine database or its artifact blobs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeFileSystem = (
  fs: FileSystem.FileSystem,
  artifacts: ArtifactStore.Service,
  workspaceRoot: string,
  options: FileSystemOptions = {}
): Service => {
  const maxInlineBytes = options.maxInlineBytes ?? defaultMaxInlineBytes
  const root = workspaceRoot.replaceAll(/\/+$/g, "")
  const reserved = [
    commitLockName,
    engineStateName,
    ...(options.reservedPaths ?? []).map((path) => path.replace(/^(\.\/)+/, "").replaceAll(/\/+$/g, ""))
  ].filter((path) => path !== "" && path !== ".")
  // The reserved entry the root-relative `path` targets or lies beneath, if
  // any. Lexical comparison is exact: the confined host refuses every symlink
  // on a path, so no alias can name a reserved entry under another spelling.
  const reservedAt = (path: string): string | undefined =>
    reserved.find((name) => path === name || path.startsWith(`${name}/`))
  const refuseReserved = (name: string): WorkspaceError => hostFailure(`the workspace path ${name} is reserved`)
  const hostPath = (path: string) => root === "" ? path : `${root}/${path}`
  // One host call, not two: the read reports an absent path itself. On the
  // confined host
  // the `exists` probe that used to precede every read was a second CPython
  // fork (`@smthrs/platform-node/AtomicFileSystem`) for an answer the read
  // was about to give.
  const readFrom = (
    host: FileSystem.FileSystem,
    path: string,
    onError: (error: PlatformError.PlatformError) => WorkspaceError
  ) =>
    host.readFile(path).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
      Effect.mapError(onError)
    )
  const readIfPresent = Effect.fn("WorkspaceSandbox.readIfPresent")(function*(path: string) {
    return yield* readFrom(fs, path, hostFailure)
  })
  const canonicalRoot = fs.realPath(root === "" ? "." : root).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
    Effect.mapError(hostFailure)
  )
  const withCommitLock = <E, R>(
    changes: ReadonlyArray<FileChange>,
    effect: (host: FileSystem.FileSystem) => Effect.Effect<void, E, R>
  ) =>
    Effect.gen(function*() {
      for (const change of changes) {
        const hit = reservedAt(change.path)
        if (hit !== undefined) return yield* Effect.fail(refuseReserved(hit))
      }
      yield* fs.makeDirectory(root === "" ? "." : root, { recursive: true }).pipe(Effect.mapError(hostFailure))
      // Pinned once per commit, after the root exists: every lock, preflight,
      // apply, and rollback call below resolves against this root identity.
      const host = yield* KernelFileSystem.confined(fs, root).pipe(
        Effect.provide(Path.layer),
        Effect.mapError(hostFailure)
      )
      const canonical = yield* canonicalRoot
      // The confined view refuses `utimes`, which the lease heartbeat needs.
      // The heartbeat touches the lock only after a confined, no-follow read
      // found this call's own token there, so the one path-based call it
      // makes can at worst refresh an mtime.
      const leaseHost: FileSystem.FileSystem = { ...host, utimes: fs.utimes }
      return yield* coordinateCommit(
        canonical ?? root,
        FileLease.withLease(leaseHost, hostPath(commitLockName), effect(host), lockFailure, {
          label: "Workspace commit lock",
          annotations: { root: canonical ?? root }
        })
      )
    })
  const commitWith = Effect.fn("WorkspaceSandbox.commit")(function*(
    host: FileSystem.FileSystem,
    changes: ReadonlyArray<FileChange>
  ) {
    yield* Effect.annotateCurrentSpan({ changes: changes.length })
    // The advisory lock and process semaphore cover preflight, apply, and
    // rollback. Preconditions run only after both are acquired.
    const { before, conflict } = yield* preflight(
      changes,
      (path) => readFrom(host, hostPath(path), copyBackFailure(path))
    )
    if (conflict !== undefined) {
      yield* Metric.update(EngineStoreMetrics.materializationConflicts, 1)
      return yield* Effect.fail(conflict)
    }
    const resolved = new Map<string, Uint8Array>()
    for (const change of changes) {
      if (change.afterDigest === undefined) continue
      const bytes = change.after ?? (yield* artifacts.get(`${change.afterDigest}`).pipe(
        Effect.mapError((error) =>
          error._tag === "@smthrs/artifacts/ArtifactStoreError"
            ? artifactFailure(error)
            : new WorkspaceError({
              code: "not_found",
              message: `the retained bytes for ${change.path} are unavailable: ${error.message}`,
              cause: error
            })
        )
      ))
      resolved.set(change.path, bytes)
    }
    const applied: Array<FileChange> = []
    const apply = Effect.gen(function*() {
      for (const change of changes) {
        // Journal the change before touching its target: a write that
        // fails halfway may still have mutated the file it was writing.
        applied.push(change)
        const target = hostPath(change.path)
        if (change.afterDigest === undefined) {
          yield* host.remove(target).pipe(Effect.mapError(copyBackFailure(change.path)))
          continue
        }
        const parent = parentDirectory(target)
        if (parent !== undefined) {
          yield* host.makeDirectory(parent, { recursive: true }).pipe(
            Effect.mapError(copyBackFailure(change.path))
          )
        }
        yield* host.writeFile(target, resolved.get(change.path)!).pipe(
          Effect.mapError(copyBackFailure(change.path))
        )
      }
    })
    const rollback = Effect.gen(function*() {
      for (const change of [...applied].reverse()) {
        const target = hostPath(change.path)
        const previous = before.get(change.path)
        if (previous === undefined) {
          yield* host.remove(target, { force: true }).pipe(Effect.mapError(copyBackFailure(change.path)))
        } else {
          yield* host.writeFile(target, previous).pipe(Effect.mapError(copyBackFailure(change.path)))
        }
      }
      // Keep empty parent directories. Effect's portable FileSystem has no
      // atomic, non-recursive rmdir; recursively deleting a directory after
      // a separate emptiness check could erase a concurrent writer's file.
    })
    yield* apply.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function*() {
          const restored = yield* Effect.exit(rollback)
          if (Exit.isSuccess(restored)) return yield* Effect.failCause(cause)
          const reasons = restored.cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error.message)
          // Both failures travel: the apply cause that opened the window and
          // the rollback cause that could not close it, composed the way
          // `acquireUseRelease` composes a failed use with a failed release.
          return yield* Effect.failCause(
            Cause.combine(
              cause,
              Cause.fail(
                new WorkspaceError({
                  code: "host_unavailable",
                  message: `copy-back failed mid-apply and rollback could not restore the workspace: ${
                    reasons.join("; ")
                  }`,
                  cause: restored.cause
                })
              )
            )
          )
        })
      ),
      // Interruption inside the apply window is a mid-sequence abort the
      // journal exists to prevent; the window is bounded local work, so it
      // closes before the fiber answers the interrupt.
      Effect.uninterruptible
    )
  })
  return makeHosted({
    root,
    snapshot: Effect.fn("WorkspaceSandbox.snapshot")(function*(descriptor) {
      yield* Effect.annotateCurrentSpan({
        reads: descriptor.readSet.length,
        boundaryMode: descriptor.boundaryMode
      })
      const base = new Map<string, Uint8Array>()
      for (const entry of descriptor.readSet) {
        // Through `FileEnumeration`, never the host `glob`: host results skip
        // dotfiles, so a declared read glob covering one would seed a sandbox
        // that silently hides it from the body.
        const paths = FileSet.isGlob(entry)
          ? yield* FileEnumeration.expandGlob(fs, entry, {
            resolve: (path) => path === "" ? (root === "" ? "." : root) : hostPath(path)
          }).pipe(Effect.mapError(hostFailure))
          : [entry.path]
        for (const path of paths) {
          const normalized = normalizePath(root, path)
          if (Result.isFailure(normalized)) return yield* Effect.fail(normalized.failure)
          const content = yield* readIfPresent(hostPath(normalized.success))
          // A declared read that does not exist is seeded as absent, not as an
          // error: `StepBoundary.prepare` already records the mismatch as the
          // evidence that refuses the cache hit.
          if (content !== undefined) base.set(normalized.success, content)
        }
      }
      for (const path of descriptor.removes ?? []) {
        const normalized = normalizePath(root, path)
        /* v8 ignore next -- `FileBoundary.removes` is `FileSet.Pattern`-checked, so a decoded boundary cannot carry an upward or absolute removal; the branch guards hand-built descriptors */
        if (Result.isFailure(normalized)) return yield* Effect.fail(normalized.failure)
        const content = yield* readIfPresent(hostPath(normalized.success))
        if (content !== undefined) base.set(normalized.success, content)
      }
      return base
    }),
    baseline: Effect.fn("WorkspaceSandbox.baseline")(function*(path) {
      const content = yield* readIfPresent(hostPath(path))
      return content === undefined ? undefined : yield* digestOf(content)
    }),
    // The bytes now live at the change's `afterDigest`; the change itself
    // carries only the reference, exactly as oversized `StepBoundary`
    // evidence does.
    retain: (bytes) =>
      bytes.length <= maxInlineBytes
        ? Effect.succeed(bytes)
        : artifacts.put(bytes).pipe(Effect.mapError(artifactFailure), Effect.as(undefined)),
    commit: (changes) => withCommitLock(changes, (host) => commitWith(host, changes))
  })
}

/**
 * Provides the filesystem-backed workspace sandbox.
 *
 * Host access arrives through Effect's `FileSystem` tag — the same tag the
 * capability kernel decorates in place — and blob retention through
 * `@smthrs/artifacts`, so the same sandbox runs over a purely local store or a
 * local-plus-shared composition without knowing which it got. The workspace
 * root arrives through the kernel's `Workspace` service, so absolute paths a
 * body resolved for itself still land inside the transaction.
 *
 * The layer refuses to build over a host that {@link makeFileSystem} could
 * not confine (a plain path-based `FileSystem`), failing with
 * `host_unavailable`, so a composition that could never copy back safely is
 * rejected at startup rather than at its first commit.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFileSystem = (
  options: FileSystemOptions = {}
): Layer.Layer<Service, WorkspaceError, FileSystem.FileSystem | ArtifactStore.ArtifactStore | KernelWorkspace> =>
  Layer.effect(
    WorkspaceSandbox,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const artifacts = yield* ArtifactStore.ArtifactStore
      const workspace = yield* KernelWorkspace
      yield* KernelFileSystem.requireConfinable(fs, workspace.root).pipe(Effect.mapError(hostFailure))
      return makeFileSystem(fs, artifacts, workspace.root, options)
    })
  )
