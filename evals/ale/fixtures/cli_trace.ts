/** Synthetic events through the real native host; never benchmark evidence. */
import { Action, FlowRuntime } from "@smthrs/flow"
import { EventSink } from "@smthrs/agent/EventSink"
import { Effect, Schema } from "effect"

export { Effect }
const Trace = Action.make("ale/smoke", { implementationVersion: "ale/smoke-v1", payload: {}, success: Schema.String })
export const layer = Trace.toLayer(() => Effect.gen(function*() {
  const instance = yield* FlowRuntime.FlowInstance
  const sink = yield* EventSink
  yield* sink.emit({ _tag: "cell-printed", eventType: "flows.harness.cell-printed.v1", cell: "smoke", text: "real native journal" }, {
    stepId: "a".repeat(64), executionId: instance.executionId, action: "ale/smoke", attempt: 1, ask: 0, retry: 1, scope: "smoke"
  })
  return "smoke"
}), { implementationVersion: "ale/smoke-v1" })
export const smoke = () => Trace.call({})
