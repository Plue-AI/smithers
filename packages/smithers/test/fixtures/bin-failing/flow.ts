import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

// The bin status boundary needs a deterministic terminal failure, independently
// of subscription login, provider retry or transport availability.
export default Flow.make("failing", {
  description: "Fail at the native flow boundary.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { args: Schema.optionalKey(Schema.String) },
  success: Schema.String,
  error: Schema.String,
  body: Node.capture({}, () => Node.fail("fixture run failure"))
})
