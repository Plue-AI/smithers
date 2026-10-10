/** A versioned journaled action failure, with no proposal or model call. */
import { RequestInput, StackBase } from "@smthrs/coding"
import { Node } from "@smthrs/plan"
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
const Probe = Action.make("monitor/retry-probe", { payload: {}, success: Schema.String, error: Schema.String, implementationVersion: "1" })
export const layer = Probe.toLayer(() => Effect.fail("Recorded retry probe"), { implementationVersion: "1" })
export default Flow.make("todo", {
  description: "Record a native failure for person Retry.",
  capabilities: ["*"], modelInvocable: false,
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: Schema.Struct({ ...RequestInput.fields, base: StackBase }), success: Schema.String, error: Schema.String,
  body: input => {
    const retry = input.prompt.includes("[RETRY]")
    return Node.succeed(null).pipe(Node.branch({
      if: Node.capture({ retry }, () => retry),
      then: Node.capture({}, () => Probe.call({})),
      else: Node.capture({}, () => Node.succeed("Smoke passed"))
    }))
  }
})
