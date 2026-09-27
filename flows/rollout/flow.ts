/** A host supplies deployment ports; rollout policy never calls a model or approval. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import Rollout from "./flow.ts"
import { rollout, type RolloutHost } from "./runtime.ts"

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
    "refused",
    "rolled-back",
    "rollback-failed"
  ]),
  previous: Release,
  candidate: Schema.NullOr(Release),
  baseline: Schema.Array(Check),
  checks: Schema.Array(Check),
  failedChecks: Schema.Array(Schema.String),
  skippedChecks: Schema.Array(Schema.String),
  rollback: Schema.Literals(["not-needed", "succeeded", "failed"]),
  reverification: Schema.Array(Check)
})
export const Execute = Action.make("rollout/execute", {
  implementationVersion: "rollout/v1",
  payload: {},
  success: Receipt,
  error: Schema.Union([Receipt, Schema.String]),
  nondeterministic: true
})
export default Flow.make("rollout", {
  description: "Deploy, verify, automatically restore the last good release on failure, and re-verify.",
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
  body: Node.capture({ implementationVersion: "rollout/v1" }, () => Execute.call({}))
})
/** Supply an exclusively leased host per run. The returned receipt is the existing run output. */
export const executionLayer = (host: RolloutHost) =>
  Interpreter.layerWithImplementations(
    Rollout,
    Execute.toLayer(() =>
      Effect.tryPromise({ try: () => rollout(host), catch: () => "Rollout receipt unavailable" }).pipe(
        Effect.flatMap((receipt) => receipt.status === "passed" ? Effect.succeed(receipt) : Effect.fail(receipt))
      ), {
      implementationVersion: "rollout/v1"
    })
  )
