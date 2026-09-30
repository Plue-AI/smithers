import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import type { Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

/** Explicitly observe the parked or terminal row after detached public admission. */
export const executeUntilParked = <
  Name extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
>(
  engine: Pick<FlowRuntime.FlowRuntime["Service"], "execute">,
  flow: Flow.Flow<Name, Payload, Success, Error, any>,
  options: {
    readonly executionId: string
    readonly payload: Payload["Type"]
    readonly discard: true
    readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined
  },
  settledStatuses: ReadonlyArray<RunStore.RunStatus> = ["suspended", "completed", "failed", "cancelled"]
) =>
  Effect.gen(function*() {
    yield* engine.execute(flow, options)
    const runs = yield* RunStore.RunStore
    yield* TestDatabase.until(
      Effect.map(runs.get(options.executionId), (row) => settledStatuses.includes(row.status))
    )
  })
