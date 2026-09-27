/** A host supplies deployment ports; rollout policy never calls a model or approval. */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Release = Schema.Struct({ version: Schema.String, revision: Schema.String })
const Check = Schema.Struct({ name: Schema.String, status: Schema.Literals(["passed", "failed"]) })
export const Receipt = Schema.Struct({
  startedAt: Schema.String,
  updatedAt: Schema.String,
  status: Schema.Literals([
    "captured",
    "prepared",
    "publishing",
    "checking",
    "restoring",
    "passed",
    "failed",
    "refused",
    "rolled-back",
    "rollback-failed"
  ]),
  previous: Schema.NullOr(Release),
  candidate: Schema.NullOr(Release),
  baseline: Schema.Array(Check),
  checks: Schema.Array(Check),
  failedChecks: Schema.Array(Schema.String),
  skippedChecks: Schema.Array(Schema.String),
  rollback: Schema.Literals(["not-needed", "succeeded", "failed"]),
  reverification: Schema.Array(Check)
})
export const Execute = Action.make("rollout/execute", {
  implementationVersion: "rollout/v2",
  payload: {},
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  nondeterministic: true
})
export default Flow.make("rollout", {
  description: "Deploy, verify, automatically restore the baseline release on failure, and re-verify.",
  capabilities: ["deploy:rollout"],
  effects: {
    reads: ["deployment/**"],
    writes: ["deployment/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: {},
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  body: Node.capture({ implementationVersion: "rollout/v2" }, () => Execute.call({}))
})
