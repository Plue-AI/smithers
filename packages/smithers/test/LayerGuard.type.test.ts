/**
 * Compile probes for the test harnesses that provide a layer and run a body.
 *
 * A harness that ends in `as Effect.Effect<A>` tells tsc every requirement is
 * met, so a missing service surfaces only as a runtime "Service not found"
 * (#2331, #2347). Each harness below derives what it accepts from what its
 * layer provides. The `@ts-expect-error` lines are the probe: if a harness
 * erased its requirements again, the directive would go unused and
 * `tsc -p tsconfig.test.json` would fail.
 *
 * Nothing here runs: every harness is read through `typeof import(...)`, so
 * this file opens no database, process, or fixture.
 */
import { Context, Effect, type Layer, type Scope } from "effect"
import { describe, expect, it } from "vitest"

type TimeTravel = typeof import("../flows/time-travel/test/RealTimeTravelHarness.ts")
type Bridged = typeof import("./BridgedEngineRun.ts")
type Served = typeof import("./faults/harness/servedSuite.ts")

declare const runReal: TimeTravel["runReal"]
declare const runRealEngine: TimeTravel["runRealEngine"]
declare const runOn: Bridged["runOn"]
declare const stack: Bridged["stack"]
declare const servedSuite: Served["servedSuite"]

class Missing extends Context.Service<Missing, { readonly value: string }>()("test/LayerGuard/Missing") {}

/** The bridged stack plus one more service, so the probe can remove it again. */
declare const stackWithMissing: Layer.Layer<Layer.Success<Bridged["stack"]> | Missing, never, Scope.Scope>
declare const needsMissing: Effect.Effect<string, never, Missing>

/** Never called; tsc checks it. */
const probe = () => {
  // A body that needs a service the harness does not provide is rejected.
  // @ts-expect-error realLayer does not provide Missing
  runReal(":memory:", needsMissing)
  // @ts-expect-error realEngineLayer does not provide Missing
  runRealEngine(":memory:", "layer-guard", needsMissing)
  // @ts-expect-error the served control client provides only Control
  servedSuite("layer-guard").remote(needsMissing)

  // Removing one provided service makes the same body fail to compile.
  runOn(stackWithMissing, needsMissing)
  // @ts-expect-error the stack without Missing no longer provides it
  runOn(stack, needsMissing)

  // Service-free bodies still compile.
  runReal(":memory:", Effect.succeed(1))
  runRealEngine(":memory:", "layer-guard", Effect.succeed(1))
  runOn(stack, Effect.succeed(1))
}

describe("missing service compile probe", () => {
  it("removing one provided service makes tsc reject the harness run type", () => {
    // The assertions are the `@ts-expect-error` directives above.
    expect(probe).toBeTypeOf("function")
  })
})
