/** Rebase repair stays in the attempt's approved host and ordinary agent. */
import { DurableDeferred, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import { readNative } from "./native.ts"
import TodoConflict from "./rebase-conflict/flow.ts"
import { Done, Repair, Resolved } from "./todo-conflict-schema.ts"
export { TodoConflict }
export { ConflictInput, Done, Repair, Resolved } from "./todo-conflict-schema.ts"

const resolvedLayer = Resolved.toLayer(({ onto }) =>
  readNative().pipe(
    Effect.map(({ head }) =>
      head.kind === "resolved" && head.parentCommitIds.length === 1 && head.parentCommitIds[0] === onto
    )
  )
)
export const todoConflictDoneLayer = Done.toLayer((input) =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    const deferred = WaitFor.deferred(input.name)
    const token = DurableDeferred.tokenFromExecutionId(deferred, {
      flow: instance.flow,
      executionId: instance.executionId
    })
    yield* FlowRuntime.annotateWaiting({
      reason: "approval",
      token,
      request: JSON.stringify({ kind: "conflict", conflict_change: input.change, onto_revision: input.onto })
    })
    yield* DurableDeferred.await(deferred)
  })
)
export const todoConflictLayer = Layer.mergeAll(
  Repair.layer,
  resolvedLayer,
  todoConflictDoneLayer,
  Interpreter.layer(TodoConflict)
)
