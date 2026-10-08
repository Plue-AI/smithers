import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Done, Repair, RepairError, RepairPayload, Resolved } from "../todo-conflict-schema.ts"

type RepairFlow = Flow.Flow<"coding/rebase-conflict", typeof RepairPayload, typeof Schema.Void, typeof RepairError,
  Action.Requirement<"coding/rebase-conflict-resolved" | "coding/rebase-conflict-done" | "coding/resolve-rebase-conflict">>
const TodoConflict: RepairFlow = Flow.make("coding/rebase-conflict", {
  description: "Resolve a retained rebase conflict within the existing coding attempt.",
  capabilities: ["*"], modelInvocable: false,
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: RepairPayload, success: Schema.Void, error: RepairError,
  body: ({ input, remaining }: typeof RepairPayload.Type) => Math.min(input.limit, remaining) <= 0 ? Done.call(input) :
    Repair.call(input).pipe(
      Node.andThen(Resolved.call(input)),
      Node.branch({ if: (resolved) => resolved, then: () => Done.call(input), else: () => TodoConflict.child({ input, remaining: Math.min(input.limit, remaining) - 1 }) }),
      Node.catch({ error: RepairError, onFailure: () => Done.call(input) })
    )
})

export default TodoConflict
