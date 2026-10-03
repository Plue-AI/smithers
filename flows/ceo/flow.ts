import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Brief } from "./data.ts"

// T-AGT-04: intentionally no catalog registration or presentation descriptor.
// Activation, authority and execution belong to the installed flow-load and
// flow.run paths. Import this repository module only inside a branch machine.
// README's producer state is already the brief: retain reported state, clocks,
// questions and findings, without inferring blockers from missing activity.
export default Flow.make("ceo", {
  description: "Compose the internal brief from published observations.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize" },
  modelInvocable: false,
  payload: { brief: Brief },
  success: Brief,
  body: Node.capture({}, ({ brief }) => Node.succeed(brief))
})
