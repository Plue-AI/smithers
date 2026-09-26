import * as Budget from "@smthrs/agent/Budget"
import { FlowRuntime } from "@smthrs/flow"
import { Deferred, Effect } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { runIndependentSteps } from "../repository/execution.ts"

test("independent steps wait for positive measured usage, then run three children within the same approved account", async () => {
  const rootId = "approved-root"
  await Effect.runPromise(
    Effect.gen(function*() {
      const budget = yield* Budget.make({ tokens: { max: 200 } })
      const ready = yield* Deferred.make<void>()
      const events: string[] = []
      let active = 0, maximum = 0
      const execute = (index: number) =>
        Effect.scoped(Effect.gen(function*() {
          assert.equal((yield* budget.reserve(`step-${index}`))._tag, "proceed")
          events.push(`start:${index}`)
          maximum = Math.max(maximum, ++active)
          if (index >= 2) {
            if (active === 3) yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(ready)
          }
          // A zero-cost response still gives the next call no positive forecast.
          yield* budget.record(`step-${index}`, { totalTokens: index === 0 ? 0 : 10 })
          active--
          events.push(`end:${index}`)
          return index
        }))
      const result = yield* runIndependentSteps([0, 1, 2, 3, 4], execute).pipe(
        Effect.provideService(Budget.Budget, budget),
        Effect.provideService(ModuleOwner, { rootId, flowId: "repository-jobs/issues" })
      )
      assert.deepEqual(result, [0, 1, 2, 3, 4])
      assert.equal(maximum, 3)
      assert.ok(events.indexOf("end:0") < events.indexOf("start:1"))
      assert.ok(events.indexOf("end:1") < events.indexOf("start:2"))
      assert.deepEqual(yield* budget.usageOf(rootId), { tokens: 40, calls: 5, largestCall: 10 })
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: rootId } as FlowRuntime.FlowInstance["Service"]),
      Effect.timeout("5 seconds")
    )
  )
})

test("parallel admission still refuses a child that exceeds the original ceiling", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    const budget = yield* Budget.make({ tokens: { max: 20 } })
    const execute = (index: number) =>
      Effect.scoped(Effect.gen(function*() {
        const admitted = yield* budget.reserve(`step-${index}`)
        if (admitted._tag === "refuse") return "refused"
        yield* budget.record(`step-${index}`, { totalTokens: 10 })
        return "completed"
      }))
    const results = yield* runIndependentSteps([0, 1, 2], execute).pipe(Effect.provideService(Budget.Budget, budget))
    assert.deepEqual(results.sort(), ["completed", "completed", "refused"])
    assert.deepEqual(yield* budget.usage, { tokens: 20, calls: 2, largestCall: 10 })
  }))
})
