/** The system flow-load: one main commit's flow versions (engineering spec §11.3.1). */
import { Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Layer } from "effect"
import { FlowLoadInput, FlowLoadResult, LoadFlows, loadFlowsLayer } from "../flow-load.ts"
import { CodingError } from "../schema.ts"
import { admitStackBase } from "../stack.ts"

/**
 * The stack service runs this on an ephemeral machine after `main` moves: it
 * stands on main's new commit and answers each overridable flow's version and
 * whether it loaded. It changes nothing the service did not give it.
 */
const FlowLoad = Flow.make("coding/FlowLoad", {
  description: "Load every overridable flow at one main commit and answer each version's digest and load status.",
  capabilities: ["*"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: FlowLoadInput,
  success: FlowLoadResult,
  error: CodingError,
  body: (input) => admitStackBase(input.base).pipe(Node.andThen(LoadFlows.call({ base: input.base })))
})
export default FlowLoad

/** The flow and its action, served by a host whose working copy is `repositoryPath`. */
export const flowLoadRegistration = (repositoryPath: string, systemFlows: ReadonlyArray<string>) =>
  Layer.mergeAll(Interpreter.layer(FlowLoad), loadFlowsLayer(repositoryPath, systemFlows))
