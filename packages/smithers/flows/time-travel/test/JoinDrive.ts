import { type Flow, FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"

/**
 * Waits out the drive a detached start scheduled.
 *
 * Since #2932, `execute` with `discard: true` returns once the engine has
 * durably admitted the execution, and the engine drives it in the background.
 * These suites assert on the state that drive leaves, so they join it. A
 * background-poll resume joins the active drive, or drives the row once more
 * when that drive already ended, and records no resume request.
 */
export const joinDrive = (flow: Flow.Any, executionId: string): Effect.Effect<void, never, FlowRuntime.FlowRuntime> =>
  Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    yield* runtime.resume(flow, executionId, { poll: true })
  })
