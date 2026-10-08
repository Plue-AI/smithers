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
import { Effect, Layer, Option, Schema } from "effect"
import {
  NativeCoding,
  NativeCodingError,
  Operation,
  type OperationResult,
  requestIdFor,
  StackCandidate,
  StackProposal
} from "./native.ts"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { CodingError, Plan, Revision, StackBase } from "./schema.ts"

export { StackBase } from "./schema.ts"

/**
 * Imports the retained tip and prepares the create operation. The operation
 * is journaled here, so `CreateStackBase` replays exactly this payload after
 * a crash and the native receipt recovers a create that already happened.
 */
export const PrepareStackBase = Action.make("coding/prepare-stack-base", {
  payload: { base: StackBase },
  success: Operation,
  error: Schema.Union([CodingError, NativeCodingError]),
  nondeterministic: true
})
/** Applies the journaled create and requires the working change to sit exactly on the tip. */
export const CreateStackBase = Action.make("coding/create-stack-base", {
  payload: { base: StackBase, operation: Operation },
  success: Revision,
  error: Schema.Union([CodingError, NativeCodingError]),
  nondeterministic: true
})

/** Reserved packaged operations: deliberately not Flow.make declarations. */
export const Candidate = Action.make("stack.candidate", {
  payload: { plan: Schema.optionalKey(Plan) },
  success: StackCandidate,
  error: Schema.Union([CodingError, NativeCodingError]),
  nondeterministic: true
})
export const Propose = Action.make("stack.propose", {
  payload: { generation: StackCandidate.fields.generation },
  success: StackProposal,
  error: Schema.Union([CodingError, NativeCodingError]),
  nondeterministic: true
})

export const captureStackCandidate = (executionId: string, plan?: typeof Plan.Type) =>
  Effect.gen(function*() {
    const invocation = yield* Action.CurrentInvocationKey
    if (!invocation) return yield* refused("Durable stack operation identity is unavailable")
    const native = yield* NativeCoding
    if (native.sourcePublication === "local-only") {
      return yield* new CodingError({ code: "not_a_todo_run", message: "Draft version" })
    }
    if (native.sourcePublication !== "cloud" || !native.stackCandidate) {
      return yield* refused("Current TODO run and machine authority is unavailable")
    }
    return yield* native.stackCandidate(requestIdFor(executionId, `stack.candidate/${invocation}`), plan)
  })

export const proposeStackCandidate = (executionId: string, generation: number) =>
  Effect.gen(function*() {
    const invocation = yield* Action.CurrentInvocationKey
    if (!invocation) return yield* refused("Durable stack operation identity is unavailable")
    const native = yield* NativeCoding
    if (native.sourcePublication === "local-only") {
      return yield* new CodingError({ code: "not_a_todo_run", message: "Draft version" })
    }
    if (native.sourcePublication !== "cloud" || !native.stackPropose) {
      return yield* refused("Current TODO run and machine authority is unavailable")
    }
    const proposal = yield* native.stackPropose(
      requestIdFor(executionId, `stack.propose/${generation}/${invocation}`),
      generation
    )
    if (proposal.generation !== generation) {
      return yield* refused("Stack proposal acknowledged another candidate generation")
    }
    return proposal
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
  })

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

const transient = (error: CodingError | NativeCodingError) =>
  error.code === "outcome_unknown" || error.code === "workspace_busy" || error.code === "guest_failure"

/** Imports the tip, creates the working change from the journaled operation, and checks it. */
export const admitStackBase = (base: StackBase) =>
  PrepareStackBase.call({ base }).pipe(
    Node.bindPlanned((operation) => CreateStackBase.call({ base, operation }))
  )

export const stackBaseLayer = Layer.mergeAll(
  Candidate.toLayer(({ plan }) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      return yield* captureStackCandidate(instance.executionId, plan)
    })
  ),
  Propose.toLayer(({ generation }) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      return yield* proposeStackCandidate(instance.executionId, generation)
    })
  ),
  PrepareStackBase.toLayer(({ base }) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      return yield* prepareStackBase(base, instance.executionId)
    })
  ),
  CreateStackBase.toLayer(({ base, operation }) =>
    Effect.gen(function*() {
      const native = yield* NativeCoding
      const owner = yield* Effect.serviceOption(ModuleOwner)
      // Only the executor's journaled continuation skips the initial create.
      // Keep the existing change and edits; a repository payload cannot claim
      // a later launch, and historical/fresh requests still create their base.
      if (Option.isSome(owner) && owner.value.flowId === "todo" && (owner.value.launchOrdinal ?? 0) > 0) {
        const current = yield* native.read()
        if (current.head.kind !== "resolved") return yield* refused("The retained working change is unresolved")
        return current.head
      }
      const result = yield* native.apply(operation)
      return yield* observeStackBase(base, result)
    }).pipe(
      // Never refresh the request: the native receipt recovers a create whose
      // response was lost; only transient transport failures retry.
      Action.retry({ times: 2, while: transient })
    )
  )
)
