/** Private recipe composition over the packaged native workspace helper.
 * No credential, JJ implementation, process runtime, or receipt ledger lives here.
 */
import { Action } from "@smthrs/flow"
import * as Digest from "@smthrs/core/Digest"
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import { CreateSource, SourceCreation, ChangeId, FileRecovery, ImportSource, isNativeCode, type NativeCode, NativeCodingError, Operation, OperationResult, PublishSource, ReadResult, SourceImport, SourcePublication } from "./native-schema.ts"
import { helperPath } from "./helper.ts"
export * from "./native-schema.ts"

/** An invocation identity, never an atomic change identity. Use a durable flow
 * execution ID and stable action key; retry the ORIGINAL operation payload.
 */
export const requestIdFor = (executionId: string, actionKey: string): string => {
  const hash = Digest.digest(JSON.stringify(["coding/native/v1", executionId, actionKey]))
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export class NativeCoding extends Context.Service<NativeCoding, {
  readonly sourcePublication: "cloud" | "local-only"
  readonly read: (changeIds?: ReadonlyArray<string>, historyLimit?: number) => Effect.Effect<typeof ReadResult.Type, NativeCodingError>
  readonly apply: (operation: Operation) => Effect.Effect<OperationResult, NativeCodingError>
  readonly publishOriginalSource: (request: typeof PublishSource.Type) => Effect.Effect<SourcePublication, NativeCodingError>
  readonly createSource?: (request: typeof CreateSource.Type) => Effect.Effect<typeof SourceCreation.Type, NativeCodingError>
  readonly importSource?: (request: typeof ImportSource.Type) => Effect.Effect<typeof SourceImport.Type, NativeCodingError>
}>()("coding/NativeCoding") {}

export interface NativeOptions {
  /** Must exactly match the path bound by Plue provisioning. */
  readonly repositoryPath: string
  /** Host-selected executable location; never part of a flow input. */
  readonly helperPath?: string
  /** Explicit development capability. Local requests may run but cannot
   * produce cloud retention or become eligible for Vibe publication. */
  readonly sourcePublication?: "cloud" | "local-only"
}

const failure = (code: NativeCode, message: string, recovery?: typeof FileRecovery.Type) => new NativeCodingError({ code, message, ...(recovery === undefined ? {} : { recovery }) })
const capture = <E>(stream: Stream.Stream<Uint8Array, E>, limit: number) =>
  Stream.runFoldEffect(stream, () => ({ text: "", bytes: 0, decoder: new TextDecoder() }), (state, chunk) => {
    const bytes = state.bytes + chunk.length
    if (bytes > limit) return Effect.fail(failure("response_too_large", "Native coding output exceeded its bounded response size; inspect the existing native receipt before replanning"))
    return Effect.succeed({ ...state, bytes, text: state.text + state.decoder.decode(chunk, { stream: true }) })
  }).pipe(Effect.map(state => state.text + state.decoder.decode()))

/** Effect's injected spawner owns acquisition, cancellation and process cleanup
 * on both Node and Bun. The native helper owns JJ and identity.
 */
export const nativeLayer = (options: NativeOptions) => Layer.effect(NativeCoding)(Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const invoke = (request: object) => Effect.gen(function*() {
    const input = JSON.stringify({ ...request, repositoryPath: options.repositoryPath })
    const bound = "operation" in request && (request.operation === "apply_files" || request.operation === "create_source") ? 2 * 1024 * 1024 : 64 * 1024
    if (new TextEncoder().encode(input).length > bound) return yield* failure("invalid_request", "Native coding request exceeds its bounded payload size")
    const process = yield* spawner.spawn(ChildProcess.make(helperPath(options), ["--local"],
      { stdin: Stream.make(new TextEncoder().encode(input)), cwd: options.repositoryPath }))
    const [stdout, , exitCode] = yield* Effect.all([
      capture(process.stdout, 16 * 1024 * 1024), capture(process.stderr, 64 * 1024), process.exitCode
    ], { concurrency: "unbounded" })
    const result = yield* Effect.try({ try: () => JSON.parse(stdout) as unknown, catch: () => failure("outcome_unknown", "Native helper returned no valid receipt; retry the identical operation") })
    if (result !== null && typeof result === "object" && "error" in result) {
      const error = yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String, message: Schema.String, recovery: Schema.optionalKey(FileRecovery) }))(result.error)
        .pipe(Effect.mapError(() => failure("outcome_unknown", "Native helper returned an invalid error envelope")))
      // The envelope comes from another process, so its code is a
      // string until this repo's own vocabulary admits it. A code nothing here
      // declares is not passed through: it would put an unauthored code on the
      // `{ code, message }` record a run card reads its sentence off, and no
      // source sweep can see a string. The helper's own words are kept.
      return yield* isNativeCode(error.code)
        ? failure(error.code, error.message, error.recovery)
        : failure("invalid_receipt", `Native helper answered with a code this build does not declare (${error.code}): ${error.message}`, error.recovery)
    }
    if (exitCode !== 0) return yield* failure("outcome_unknown", "Native helper exited without an accepted receipt; retry the identical operation")
    return result
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: "4 minutes", orElse: () => Effect.fail(failure("outcome_unknown", "Native coding timed out; retry the identical operation to recover its native receipt")) }),
    Effect.catchCause(cause => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      const reason = Cause.squash(cause)
      return reason instanceof NativeCodingError
        ? Effect.fail(reason)
        : Effect.fail(failure("outcome_unknown", "Native coding process interrupted; retry the identical operation to recover its native receipt"))
    })
  )
  return {
    sourcePublication: options.sourcePublication ?? "cloud",
    read: (changeIds: ReadonlyArray<string> = [], historyLimit?: number) => invoke({
      operation: "read", changeIds, ...(historyLimit === undefined ? {} : { historyLimit })
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ReadResult)),
      Effect.mapError(error => error instanceof NativeCodingError ? error : failure("invalid_receipt", "Native read returned an invalid revision"))
    ),
    createSource: (request: typeof CreateSource.Type) => Effect.gen(function*() {
      const input = yield* Schema.decodeUnknownEffect(CreateSource)(request).pipe(
        Effect.mapError(() => failure("invalid_request", "Native source creation requires an exact base and bounded proposal")))
      if (input.base.operationId !== input.expectedOperationId) return yield* failure("invalid_request", "The source base must name the admitted operation")
      const result = yield* invoke({ operation: "create_source", ...input }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SourceCreation)),
        Effect.mapError(error => error instanceof NativeCodingError ? error : failure("invalid_receipt", "Native source creation returned an invalid receipt")))
      if (result.requestId !== input.requestId || result.parentOperationId !== input.expectedOperationId || result.source.operationId !== result.operationId ||
          result.head.operationId !== result.operationId || result.base.commitId !== input.base.commitId || result.base.treeId !== input.base.treeId ||
          result.base.changeId !== input.base.changeId || JSON.stringify(result.base.parentCommitIds) !== JSON.stringify(input.base.parentCommitIds) ||
          result.source.parentCommitIds.length !== 1 || result.source.parentCommitIds[0] !== input.base.commitId) {
        return yield* failure("invalid_receipt", "Native creation did not acknowledge the exact owned base and immutable child")
      }
      return result
    }),
    importSource: (request: typeof ImportSource.Type) => Effect.gen(function*() {
      const input = yield* Schema.decodeUnknownEffect(ImportSource)(request).pipe(
        Effect.mapError(() => failure("source_refused", "Native source import requires exact immutable source refs")))
      if (new Set(input.commits.map(commit => commit.commitId)).size !== input.commits.length ||
          input.commits.some(commit => commit.commitId === "0".repeat(40))) return yield* failure("source_refused", "Native source import needs distinct nonempty commits")
      const result = yield* invoke({ operation: "import_source", ...input }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SourceImport)),
        Effect.mapError(error => error instanceof NativeCodingError ? error : failure("invalid_receipt", "Native source import returned an invalid receipt")))
      if (result.requestId !== input.requestId || result.head.operationId !== result.operationId || result.revisions.length !== input.commits.length ||
          new Set(result.revisions.map(revision => revision.commitId)).size !== input.commits.length || input.commits.some(commit =>
            commit.ref !== `refs/smithers/workspaces/${result.workspaceId}/sources/${commit.commitId}` ||
            !result.revisions.some(revision => revision.commitId === commit.commitId && revision.operationId === result.operationId))) {
        return yield* failure("invalid_receipt", "Native source import did not acknowledge the exact retained commits and owning workspace")
      }
      return result
    }),
    publishOriginalSource: (request: typeof PublishSource.Type) => Effect.gen(function*() {
      if (options.sourcePublication === "local-only") return yield* failure("source_publication_unavailable", "This host has explicit local-only native capability; it cannot acknowledge cloud retention")
      const input = yield* Schema.decodeUnknownEffect(PublishSource)(request).pipe(
        Effect.mapError(() => failure("invalid_request", "Publication requires an exact resolved native source")))
      const result = yield* invoke({ operation: "publish_source", ...input }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SourcePublication)),
        Effect.mapError(error => error instanceof NativeCodingError ? error : failure("source_publication_invalid_ack", "Cloud source publication returned an incomplete acknowledgement")))
      if (result.requestId !== input.requestId || result.source.changeId !== input.source.changeId ||
          result.source.commitId !== input.source.commitId || result.source.treeId !== input.source.treeId ||
          result.source.parentCommitIds.length !== input.source.parentCommitIds.length ||
          result.source.parentCommitIds.some((id, index) => id !== input.source.parentCommitIds[index]) ||
          result.ref !== `refs/smithers/workspaces/${result.workspaceId}/sources/${input.source.commitId}`) {
        return yield* failure("source_publication_invalid_ack", "Cloud acknowledgement did not match the exact native source")
      }
      return result
    }),
    apply: (operation: Operation) => Schema.decodeUnknownEffect(Operation)(operation).pipe(
      Effect.mapError(() => failure("invalid_request", "Native operation requires exact resolved JJ revision identities")),
      Effect.flatMap(invoke),
      Effect.map(result => result !== null && typeof result === "object" && "status" in result && result.status === "accepted"
        ? { ...result, provenance: "pending" } : result),
      Effect.flatMap(Schema.decodeUnknownEffect(OperationResult)),
      Effect.mapError(error => error instanceof NativeCodingError ? error : failure("invalid_receipt", "Native operation returned an invalid receipt"))
    )
  }
}))

export const ReadNative = Action.make("coding/ReadNative", {
  payload: { changeIds: Schema.Array(ChangeId) }, success: ReadResult, error: NativeCodingError, nondeterministic: true
})
export const ApplyNative = Action.make("coding/ApplyNative", {
  payload: { operation: Operation }, success: OperationResult, error: NativeCodingError, nondeterministic: true
})
const transient = (error: NativeCodingError) =>
  error.code === "outcome_unknown" || error.code === "workspace_busy" || error.code === "guest_failure"

/** Reads use the same guest lock; retry transient admission/transport failures. */
export const readNative = (changeIds: ReadonlyArray<string> = []) =>
  Effect.flatMap(NativeCoding, native => native.read(changeIds)).pipe(Action.retry({ times: 2, while: transient }))

/** Merge into the existing runtime's action table; never create another one. */
export const nativeActions = Layer.mergeAll(
  ReadNative.toLayer(({ changeIds }) => readNative(changeIds)),
  ApplyNative.toLayer(({ operation }) => Effect.flatMap(NativeCoding, native => native.apply(operation)).pipe(
    // Retry inside the durable action before its terminal result is recorded.
    // Never refresh the request: native receipts recover an accepted mutation
    // whose response was lost. Conflicting revisions still require replanning.
    Action.retry({ times: 2, while: transient })
  ))
)
