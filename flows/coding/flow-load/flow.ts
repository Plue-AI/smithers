/** The system flow-load: one main commit's flow versions (engineering spec §11.3.1). */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { FlowLoadInput, FlowLoadResult, LoadFlows } from "../flow-load.ts"
import { admitStackBase, PrepareStackBase } from "../stack.ts"

/**
 * The stack service runs this on an ephemeral machine after `main` moves: it
 * stands on main's new commit and answers each overridable flow's version and
 * whether it loaded. It changes nothing the service did not give it.
 */
export default Flow.make("coding/FlowLoad", {
  description: "Load every overridable flow at one main commit and answer each version's digest and load status.",
  capabilities: ["*"],
  modelInvocable: false,
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: FlowLoadInput,
  success: FlowLoadResult,
  error: PrepareStackBase.errorSchema,
  body: (input) => admitStackBase(input.base).pipe(Node.andThen(LoadFlows.call({ base: input.base })))
})
