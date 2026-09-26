/**
 * A coding request that starts from a retained base: the repository's
 * mythical stack tip, or the caller's own pushed ref
 * (refs/smithers/users/<id>/<name>, #1964), which Smithers Cloud pins the same
 * way.
 *
 * The stack service (or Cloud, for a pushed ref) retains the base into this
 * workspace's source ref and names it as the request's `base`. Before gathering, the request imports
 * that commit and starts a fresh working change on it, so the planner's
 * native history IS the stack: a plan can amend or insert anywhere in it, or
 * append. When the request is delivered, `coding/vibe` hands the cleaned
 * result back to the stack service instead of landing it (vibe-landing.ts).
 */
import { Action, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer } from "effect"
import { NativeCoding, NativeCodingError, Operation, type OperationResult, requestIdFor } from "./native.ts"
import { CodingError, Revision, StackBase } from "./schema.ts"

export { StackBase } from "./schema.ts"

/**
 * Imports the retained tip and prepares the create operation. The operation
 * is journaled here, so `CreateStackBase` replays exactly this payload after
 * a crash and the native receipt recovers a create that already happened.
 */
export const PrepareStackBase = Action.make("coding/prepare-stack-base", {
  payload: { base: StackBase },
  success: Operation,
  error: CodingError,
  nondeterministic: true
})
/** Applies the journaled create and requires the working change to sit exactly on the tip. */
export const CreateStackBase = Action.make("coding/create-stack-base", {
  payload: { base: StackBase, operation: Operation },
  success: Revision,
  error: CodingError,
  nondeterministic: true
})

const refused = (message: string) => new CodingError({ code: "source_refused", message })

export const prepareStackBase = (base: StackBase, executionId: string) =>
  Effect.gen(function*() {
    const native = yield* NativeCoding
    if (!native.importSource) {
      return yield* refused("This workspace's native helper cannot import the base; upgrade the workspace")
    }
    const imported = yield* native.importSource({
      requestId: requestIdFor(executionId, "stack-base/import"),
      commits: [{ commitId: base.commitId, ref: base.ref }]
    })
    const target = imported.revisions.find((revision) => revision.commitId === base.commitId)
    if (target === undefined || target.kind !== "resolved") {
      return yield* refused("The base was not imported as a resolved commit")
    }
    return {
      operation: "create" as const,
      requestId: requestIdFor(executionId, "stack-base/create"),
      expectedOperationId: imported.operationId,
      target: { ...target, kind: "resolved" as const },
      description: ""
    }
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ? error : new CodingError({
      code: error instanceof NativeCodingError && (error.code === "source_missing" || error.code === "source_changed")
        ? error.code
        : "source_unavailable",
      message: "The base could not be admitted: " + error.message
    })
  ))

export const observeStackBase = (base: StackBase, result: typeof OperationResult.Type) => {
  const revision = result.revision
  if (
    result.status !== "accepted" || revision.kind !== "resolved" || revision.parentCommitIds.length !== 1 ||
    revision.parentCommitIds[0] !== base.commitId
  ) {
    return Effect.fail(refused("The working change was not created on the base"))
  }
  return Effect.succeed({
    changeId: revision.changeId,
    commitId: revision.commitId,
    treeId: revision.treeId,
    operationId: revision.operationId,
    parentCommitIds: [...revision.parentCommitIds]
  })
}

const transient = (error: NativeCodingError) =>
  error.code === "outcome_unknown" || error.code === "workspace_busy" || error.code === "guest_failure"

/** Imports the tip, creates the working change from the journaled operation, and checks it. */
export const admitStackBase = (base: StackBase) =>
  PrepareStackBase.call({ base }).pipe(
    Node.bindPlanned((operation) => CreateStackBase.call({ base, operation }))
  )

export const stackBaseLayer = Layer.mergeAll(
  PrepareStackBase.toLayer(({ base }) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      return yield* prepareStackBase(base, instance.executionId)
    })
  ),
  CreateStackBase.toLayer(({ base, operation }) =>
    Effect.flatMap(NativeCoding, (native) => native.apply(operation)).pipe(
      // Never refresh the request: the native receipt recovers a create whose
      // response was lost; only transient transport failures retry.
      Action.retry({ times: 2, while: transient }),
      Effect.mapError((error) =>
        new CodingError({
          code: error.code === "revision_conflict" || error.code === "operation_conflict"
            ? "stale_revision"
            : "source_unavailable",
          message: "The working change could not be created on the base: " + error.message
        })
      ),
      Effect.flatMap((result) => observeStackBase(base, result))
    )
  )
)
