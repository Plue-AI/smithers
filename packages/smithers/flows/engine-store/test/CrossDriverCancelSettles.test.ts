/**
 * N-09: a cancellation from another driver has to settle the caller.
 *
 * The parity audit's containment gap. After a durable cancel written by a
 * driver that does not own the run, the run reaches `cancelled` and the
 * process group dies — and the `Flow.execute` fiber that asked for the run
 * never settles. `poll` reads the result off `state_json`, and a cancelled run
 * has none: cancellation is recorded as `cancellation`, not as a
 * `Flow.Result`. So the durable `execute` answered `Suspended`, and the
 * engine's suspended-retry loop did exactly what that answer means — slept,
 * resumed, re-drove, and asked again, for as long as the caller lived.
 * `packages/smithers/flows/test/NodeRuntime.test.ts` documents the workaround, ending
 * its cross-driver case by interrupting the fiber by hand.
 *
 * The memory engine settles this shape as `Complete` with an interrupt cause
 * (`layerMemory.ts` `interrupt`), and that is the parity restored here: a run
 * cancelled underneath its caller interrupts the caller.
 *
 * Two engines over one store, with distinct owner identities: the cancelling
 * engine holds no instance and no coordinator entry for the run, so its
 * `interrupt` can only write the durable request — which is all a second
 * process can do either. The connection is shared because that is a harness
 * detail; the arbitration under test is the run row.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const CancelFlow = Flow.make("CrossDriverCancel/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "cross-driver-snapshot" as never, changeId: "cross-driver-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)
const runId = "cross-driver-cancel"

describe("a cross-driver cancel settles the execute fiber (N-09)", () => {
  it.effect("interrupts the caller instead of leaving it in the suspended-retry loop", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const engine = (yield* EngineStore.make({
              owner: { hostId: "driver-a" },
              journalSource: "cross-driver-a",
              isAlive: () => Effect.succeed(false)
            })) as FlowRuntime.FlowRuntime["Service"]
            // The second driver: its own owner identity over the same store.
            // It never drives this run, so `interrupt` can only write the
            // durable request — the same thing a second process can do.
            const other = (yield* EngineStore.make({
              owner: { hostId: "driver-b" },
              journalSource: "cross-driver-b",
              isAlive: () => Effect.succeed(false)
            })) as FlowRuntime.FlowRuntime["Service"]

            const running = yield* Deferred.make<void>()
            yield* engine.register(
              CancelFlow,
              // A body that never returns on its own: the only thing that can
              // end this run is the cancellation.
              () => Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never))
            )
            const caller = yield* Effect.forkChild(
              Effect.exit(
                engine.execute(CancelFlow, { executionId: runId, payload: {} })
              ),
              { startImmediately: true }
            )
            yield* Deferred.await(running)
            const beforeCancel = yield* store.get(runId)

            yield* other.interrupt(CancelFlow, runId)

            // Driver A observes the request on its heartbeat cadence and
            // closes the run; the caller has to end with it. The bound is
            // finite and generous: a caller stuck in the suspended-retry loop
            // is still stuck after every one of these ticks, so the case fails
            // instead of hanging.
            let settled = caller.pollUnsafe()
            for (let tick = 0; tick < 2000 && settled === undefined; tick++) {
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
              yield* TestClock.adjust(heartbeatMs)
              yield* Effect.yieldNow
              settled = caller.pollUnsafe()
            }
            return { beforeCancel: beforeCancel.status, settled, row: yield* store.get(runId) }
          }).pipe(
            Effect.provide(StepBoundary.layerTest()),
            Effect.provideService(Jj.Jj, jj),
            Effect.provideService(
              DurableEngineState.DurableEngineState,
              DurableEngineState.makeMemory()
            )
          )
        ).pipe(
          Effect.provide(TestStores.layer()),
          Effect.provide(TestClock.layer())
        )
      )

      expect(result.beforeCancel).toBe("running")
      // The run is durably over…
      expect(result.row.status).toBe("cancelled")
      // …and so is the caller.
      expect(result.settled).toBeDefined()
      const observed = result.settled!
      const inner = Exit.isSuccess(observed) ? observed.value as Exit.Exit<unknown, unknown> : observed
      expect(Exit.isFailure(inner) && Cause.hasInterrupts(inner.cause)).toBe(true)
    }))
})
