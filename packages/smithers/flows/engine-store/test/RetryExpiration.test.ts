import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #45: a `RetryPolicy.expirationMs` (schedule-to-close) bound must
 * be measured from a durable origin — the persisted start of the first
 * attempt — so it survives a process death mid-retry. An engine rebuilt over
 * the same stores must give up with `retry_policy_expired` once the
 * wall-clock budget is exhausted, without re-dispatching the action body.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, RetryPolicy, StepIdentity } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { invocationKey, runSync, sha256, withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "retry-expiration-snapshot" as never, changeId: "retry-expiration-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const withRestart = <A>(
  body: (
    makeEngine: Effect.Effect<FlowRuntime.FlowRuntime["Service"], never, any>,
    store: RunStore.Service,
    attempts: AttemptStore.Service
  ) => Effect.Effect<A, any, any>
) =>
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const attempts = yield* AttemptStore.AttemptStore
        const makeEngine = EngineStore.make({
          owner: { hostId: "retry-expiration-host" },
          journalSource: "retry-expiration-test",
          isAlive: () => Effect.succeed(false)
        }) as Effect.Effect<FlowRuntime.FlowRuntime["Service"], never, any>
        return yield* body(makeEngine, store, attempts)
      }).pipe(
        Effect.provideService(
          DurableEngineState.DurableEngineState,
          DurableEngineState.makeMemory()
        ),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<A>
  )

describe("expirationMs survives a restart mid-retry (issue #45)", () => {
  it.effect("a rebuilt engine gives up on the durable wall-clock budget without re-dispatching", () =>
    Effect.gen(function*() {
      let bodyRuns = 0
      const flow = Flow.make("RetryExpiration/Restart", {
        payload: {},
        success: Schema.String,
        error: Schema.String,
        body: opaqueHandlerBody
      })
      const flaky = Action.make({
        name: "retry-expiration-flaky",
        success: Schema.String,
        error: Schema.String,
        retryPolicy: RetryPolicy.make({
          initialMs: 1000,
          factor: 1,
          maxMs: 1000,
          expirationMs: 5000
        }),
        execute: Effect.suspend(() => {
          bodyRuns++
          return Effect.fail("boom")
        })
      })
      // Yield the action itself (it is Effectable): that is the engine
      // dispatch path; `.execute` would be the raw body.
      const handler = () =>
        Effect.gen(function*() {
          return yield* flaky
        })

      // The action carries no idempotency key, so its step key is the first
      // invocation key allocated in the action's own name scope (issue #73) —
      // recomputable here to observe the persisted attempt row directly.
      const attemptId = {
        runId: "retry-expiration-run",
        stepKeyDigest: sha256(invocationKey({
          runId: "retry-expiration-run",
          parentScope: runSync(StepIdentity.allocationScope({
            kind: "action",
            name: "retry-expiration-flaky"
          })),
          ordinal: 1,
          tier: "unsealed"
        })),
        attempt: 1
      }

      const result = yield* withRestart((makeEngine, store, attempts) =>
        Effect.gen(function*() {
          // The first engine lives in its own scope so the test can tear it
          // down mid-retry, exactly like process death.
          const firstScope = yield* Scope.make()
          const first = yield* makeEngine.pipe(Scope.provide(firstScope))
          yield* first.register(flow as never, handler as never)
          const driveFiber = yield* first.execute(flow as never, {
            executionId: "retry-expiration-run",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))

          // Wait until attempt 1 durably failed and the drive is parked in its
          // retry sleep, then kill the process mid-retry.
          let finished = false
          for (let i = 0; i < 500 && !finished; i++) {
            yield* Effect.yieldNow
            const row = yield* attempts.get(attemptId)
            finished = Option.isSome(row) && row.value.state === "failed"
          }
          expect(finished).toBe(true)
          expect(bodyRuns).toBe(1)

          // Process death mid-retry: closing the engine scope interrupts the
          // drive fiber, which releases the run reclaimably.
          yield* Scope.close(firstScope, Exit.void)
          yield* Fiber.interrupt(driveFiber)
          const released = yield* store.get("retry-expiration-run")

          // The wall clock crosses the schedule-to-close budget while no
          // process is alive.
          yield* TestClock.adjust(6000)

          // Restart: a fresh engine over the same durable stores re-drives the
          // run. The durable origin (first attempt startedAtMs) makes the
          // budget already exhausted, so it must give up immediately instead
          // of re-dispatching the body with a reset origin.
          const restarted = yield* makeEngine
          yield* restarted.register(flow as never, handler as never)
          const resumeFiber = yield* restarted.execute(flow as never, {
            executionId: "retry-expiration-run",
            payload: {},
            discard: true
          }).pipe(Effect.forkChild({ startImmediately: true }))
          let row = yield* store.get("retry-expiration-run")
          for (let i = 0; i < 2000 && row.status !== "failed"; i++) {
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
            for (let j = 0; j < 50; j++) yield* Effect.yieldNow
            if ((yield* store.get("retry-expiration-run")).status === "failed") break
            // Only a buggy engine (in-process origin reset) needs more time.
            yield* TestClock.adjust(1000)
            row = yield* store.get("retry-expiration-run")
          }
          yield* Fiber.await(resumeFiber)
          row = yield* store.get("retry-expiration-run")
          return { released, row }
        })
      )

      expect(result.released.status).toBe("suspended")
      expect(result.row.status).toBe("failed")
      const persisted = JSON.parse(result.row.stateJson)
      expect(persisted.result.exit.cause).toContainEqual({ _tag: "Fail", error: "boom" })
      // The rebuilt flow never re-dispatched the action body: the budget
      // was already spent according to the durable origin.
      expect(bodyRuns).toBe(1)
    }))
})
