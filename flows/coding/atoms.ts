/** The implementation leaf uses the same agent and native JJ actions as any flow. */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
export { ApplyNative } from "./native.ts"
import { NativeCodingError, Operation, OperationResult, readNative, requestIdFor } from "./native.ts"
import { AtomicPlan, CodingError, Revision } from "./schema.ts"

/** Every way one atom fails: policy, the native adapter, or the seat. */
export const atomError = Schema.Union([CodingError, NativeCodingError, AgentAction.AgentFailure])
const EditReport = Schema.Struct({
  summary: Schema.NonEmptyString,
  reads: Schema.Array(Schema.String),
  writes: Schema.Array(Schema.String)
})
export const Entry = Action.make("coding/prepare-atom", {
  payload: { change: Schema.NonEmptyString, atom: AtomicPlan, parent: Revision, ordinal: Schema.Number },
  success: Operation,
  error: atomError,
  nondeterministic: true
})
export const Prepare = Action.make("coding/prepare-atom-mutation", {
  // The recorded edit report is also the graph dependency: file capture cannot
  // be prepared until the agent has finished writing this atom.
  payload: {
    change: Schema.NonEmptyString,
    phase: Schema.Literals(["snapshot", "describe"]),
    atom: AtomicPlan,
    revision: Revision,
    parent: Revision,
    ordinal: Schema.Number,
    editing: EditReport
  },
  success: Operation,
  error: atomError,
  nondeterministic: true
})
export const Observe = Action.make("coding/observe-atom", {
  payload: { result: OperationResult, parent: Revision, expectedChangeId: Schema.NullOr(Schema.String) },
  success: Revision,
  error: CodingError
})

/** Consecutive frames without a workspace write the implement agent may spend; the harness default for task runs. */
export const implementIdleFrames = 12

/** The host supplies its existing tool bindings, seats, capabilities and budget. */
export const EditAtom = AgentAction.make("coding/edit-atom", {
  payload: { atom: AtomicPlan, parent: Revision, revision: Revision, memoryRevision: Schema.String },
  output: EditReport,
  seat: "coding/implement",
  // Idle breaker: an edit run that writes nothing for this many frames is
  // asked for an edit, and fails at twice it.
  readOnlyCap: implementIdleFrames,
  system: [
    "Implement the single atomic change in the owning workspace using the provided filesystem tools.",
    "The workflow owns JJ operations: do not invoke JJ, Git, create commits, or switch workspaces.",
    "Follow repository instructions. Keep the change small and confined to its intent. Report actual files read and written.",
    "The workflow runs independent checks. Your summary is an explanation of your work, never a passing check receipt."
  ],
  prompt: (input) => JSON.stringify(input)
})

const stale = (message: string) => new CodingError({ code: "stale_revision", message })
/** Operation IDs are read-view identities; exact commit/tree/parents identify unchanged code. */
const sameCode = (left: Revision, right: Revision) =>
  left.changeId === right.changeId && left.commitId === right.commitId && left.treeId === right.treeId &&
  left.parentCommitIds.length === right.parentCommitIds.length && left.parentCommitIds.every((id, i) =>
    id === right.parentCommitIds[i]
  )

const readParent = (parent: Revision, changeId?: string) =>
  Effect.gen(function*() {
    const read = yield* readNative([...new Set([parent.changeId, ...(changeId ? [changeId] : [])])])
    const currentParent = read.revisions.find((value) => value.changeId === parent.changeId)
    if (!currentParent || currentParent.kind !== "resolved" || !sameCode(currentParent, parent)) {
      return yield* stale("The atom's parent changed; replan before editing its files")
    }
    return { read, parent: currentParent }
  })

/** Prepared requests are journaled separately; bounded transient retries resend them unchanged. */
export const atomOperations = Layer.mergeAll(
  Entry.toLayer(({ change, atom, parent, ordinal }) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      const current = yield* readParent(parent, atom.changeId ?? undefined)
      const requestId = requestIdFor(instance.executionId, JSON.stringify([change, ordinal, "enter"]))
      if (atom.changeId === null) {
        return {
          operation: "create" as const,
          requestId,
          expectedOperationId: current.read.operationId,
          target: current.parent,
          description: atom.message
        }
      }
      const target = current.read.revisions.find((value) => value.changeId === atom.changeId)
      if (
        !target || target.kind !== "resolved" || target.parentCommitIds.length !== 1 ||
        target.parentCommitIds[0] !== parent.commitId
      ) {
        return yield* stale("The existing JJ atom is not the next change after its planned parent")
      }
      return { operation: "edit" as const, requestId, expectedOperationId: current.read.operationId, target }
    })
  ),
  Prepare.toLayer(({ change, phase, atom, revision, parent, ordinal }) =>
    Effect.gen(function*() {
      const instance = yield* FlowRuntime.FlowInstance
      const current = yield* readParent(parent, revision.changeId)
      const target = current.read.head
      if (
        target.kind !== "resolved" || target.changeId !== revision.changeId ||
        target.parentCommitIds.length !== 1 || target.parentCommitIds[0] !== parent.commitId ||
        (phase === "describe" && !sameCode(target, revision))
      ) {
        return yield* stale("The owning working copy or atom ancestry changed during implementation")
      }
      // The existing head reporter may have captured the agent's file edits.
      // Snapshot accepts that same native change, but never a different parent.
      const expected = {
        requestId: requestIdFor(instance.executionId, JSON.stringify([change, ordinal, phase])),
        expectedOperationId: current.read.operationId,
        target
      }
      return phase === "snapshot" ?
        { ...expected, operation: "snapshot" as const }
        : { ...expected, operation: "describe" as const, description: atom.message }
    })
  ),
  Observe.toLayer(({ result, parent, expectedChangeId }) =>
    Effect.gen(function*() {
      const revision = result.revision
      if (
        revision.kind !== "resolved" || revision.parentCommitIds.length !== 1 ||
        revision.parentCommitIds[0] !== parent.commitId ||
        revision.changeId === parent.changeId ||
        (expectedChangeId !== null && revision.changeId !== expectedChangeId) ||
        (expectedChangeId === null && result.status !== "accepted")
      ) {
        return yield* stale("Native JJ returned a conflicted, replaced, or differently parented atom")
      }
      return revision
    })
  )
)
