import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
// The flow below is this module's own default export. Discovery reads the
// literal `export default Flow.make(` without importing the file, so the flow
// cannot also be a named const; an unresolved repair runs again as a child of
// the value this self-import reads back after the module evaluates.
import { Done, Repair, RepairError, RepairPayload, Resolved } from "../todo-conflict-schema.ts"
import TodoConflict from "./flow.ts"

type Repairs = Node.Node<
  void,
  typeof RepairError.Type,
  Action.Requirement<
    "coding/rebase-conflict-resolved" | "coding/rebase-conflict-done" | "coding/resolve-rebase-conflict"
  >
>

export default Flow.make("coding/rebase-conflict", {
  description: "Resolve a retained rebase conflict within the existing coding attempt.",
  capabilities: ["*"],
  modelInvocable: false,
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: RepairPayload,
  success: Schema.Void,
  error: RepairError,
  body: ({ input, remaining }: typeof RepairPayload.Type): Repairs =>
    Math.min(input.limit, remaining) <= 0 ? Done.call(input) : Repair.call(input).pipe(
      Node.andThen(Resolved.call(input)),
      Node.branch({
        if: (resolved) => resolved,
        then: () => Done.call(input),
        else: () => TodoConflict.child({ input, remaining: Math.min(input.limit, remaining) - 1 })
      }),
      Node.catch({ error: RepairError, onFailure: () => Done.call(input) })
    )
})
