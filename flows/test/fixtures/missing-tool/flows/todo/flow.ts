/** Production native read, immutable CheckCommand and typed check gate. */
import { CodingError, CheckCommand, ReadNative, RequestInput, StackBase } from "@smthrs/coding"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"

const Gate = Action.make("acceptance/missing-tool-gate", { payload: {}, success: Schema.String, error: CodingError, implementationVersion: "1" })
export const layer = Gate.toLayer(() => Effect.fail(new CodingError({ code: "fast_gate", message: "Required coding check failed" })), { implementationVersion: "1" })

export default Flow.make("todo", {
  description: "Check a missing machine executable on the admitted source.",
  capabilities: ["*"], modelInvocable: false,
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: Schema.Struct({ ...RequestInput.fields, base: StackBase }),
  success: Schema.String,
  error: Schema.Union([ReadNative.errorSchema, CheckCommand.errorSchema]),
  body: () => ReadNative.call({ changeIds: [] }).pipe(
    Node.map(read => {
      const head = read.head.kind === "resolved" ? read.head : { ...read.head, treeId: "" }
      return { change: "missing-tool", parent: head, head, atoms: [head], reads: [], writes: [] }
    }),
    Node.bindPlanned(implementation => {
      const check = { id: "missing-tool", flow: "checks/missing-tool", flowDigest: "missing-tool-v1", target: ".", tier: "fast" as const, required: true }
      return CheckCommand.call({ flow: check.flow, input: { implementation, check }, prompt: JSON.stringify({ argv: ["/bin/sh", "-c", "PATH=/nonexistent figlet"], cwd: ".", timeoutMs: 10000 }), model: null, placement: null, placementOptions: null, capabilities: ["*"], flows: [] }).pipe(Node.andThen(Gate.call({})))
    })
  )
})
