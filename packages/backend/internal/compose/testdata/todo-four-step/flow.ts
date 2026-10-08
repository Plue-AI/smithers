// Literal C-STK-03 repository override. The host supplies the real engine and
// packaged pause boundary; only these four actions and their barriers are fixtures.
import { TodoBoundary } from "@smthrs/coding"
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { appendFileSync, existsSync } from "node:fs"

const root = process.argv[process.argv.indexOf("--root") + 1]
const Failure = Schema.Struct({ _tag: Schema.Literal("coding/Error"), code: Schema.Literal("invalid_request"), message: Schema.String })
const input = { feedback: Schema.optionalKey(Schema.String) }
const step = (name: string) => Action.make(name, {
  payload: input, success: Schema.Void, error: Failure,
  tier: "sealed", implementationVersion: "four-step/v1", idempotencyKey: name
})
const s1 = step("s1"), s2 = step("s2"), s3 = step("s3"), s4 = step("s4")
const implement = (action: ReturnType<typeof step>) => action.toLayer((value) => Effect.gen(function*() {
  yield* Effect.sync(() => appendFileSync(root + "/four-step.jsonl", JSON.stringify({ step: action.name, version: "D1", feedback: value.feedback ?? "" }) + "\n"))
  if (action.name === "s3") {
    while (!(yield* Effect.sync(() => existsSync(root + "/four-step-release")))) yield* Effect.sleep("25 millis")
  }
  if (action.name === "s4") return yield* Effect.fail({ _tag: "coding/Error", code: "invalid_request", message: "four-step-s4" } as const)
}), { implementationVersion: "four-step/v1" })
export const layer = Layer.mergeAll(implement(s1), implement(s2), implement(s3), implement(s4))
export default Flow.make("todo", {
  description: "Four-step Stop, Resume and Retry qualification",
  capabilities: ["*"], modelInvocable: false,
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: input, success: Schema.Void,
  error: Schema.Union([Failure, TodoBoundary.errorSchema]),
  body: (value) => s1.call(value).pipe(
    Node.andThen(s2.call(value)),
    Node.andThen(s3.call(value)),
    Node.andThen(TodoBoundary.call({})),
    Node.andThen(s4.call(value))
  )
})
