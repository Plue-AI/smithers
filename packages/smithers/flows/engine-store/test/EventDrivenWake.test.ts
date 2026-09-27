import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Event-driven wake through the full durable composition: a deferred
 * completion resumes an in-process caller parked on the suspension poll
 * WITHOUT a poll tick — the whole scenario runs under an unadvanced
 * `TestClock`, so a resume that needed the polling sleep could never
 * finish. The polling schedule stays the bounded fallback: with a bus
 * that drops every wake, the same scenario completes only after the
 * poll interval elapses.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { DurableDeferred, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WakeBus from "../src/WakeBus.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "wake-snapshot" as never, changeId: "wake-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/**
 * An hour-long suspension backoff: under the unadvanced `TestClock` only an
 * event-driven wake can finish a caller parked on it.
 */
const hourPolicy = RetryPolicy.make({
  initialMs: 3_600_000,
  factor: 1,
  maxMs: 3_600_000
})

const withEngine = <A>(
  wakeBusLayer: Layer.Layer<WakeBus.WakeBus>,
  body: (
    makeEngine: Effect.Effect<unknown, never, any>
  ) => Effect.Effect<A, any, any>
) =>
  withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const makeEngine = EngineStore.make({
          owner: { hostId: "wake-host" },
          journalSource: "wake-test",
          isAlive: () => Effect.succeed(false)
        })
        return yield* body(makeEngine as never)
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
      Effect.provide(wakeBusLayer),
      Effect.provide(TestClock.layer())
    ) as Effect.Effect<A>
  )

/** Yields until the bus reports `count` waiters parked on `executionId`. */
const untilWaiters = (
  bus: WakeBus.Service,
  executionId: string,
  count: number
): Effect.Effect<void> =>
  Effect.gen(function*() {
    while ((yield* bus.waiters(executionId)) !== count) {
      yield* Effect.yieldNow
    }
  })

describe("event-driven wake", () => {
  it.effect("a completed deferred wakes the waiting caller without a poll tick", () =>
    Effect.gen(function*() {
      const EventFlow = Flow.make("Wake/event", {
        payload: {},
        success: Schema.String,
        suspendedRetryPolicy: hourPolicy,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("wake-gate", { success: Schema.String })
      const handler = () => Effect.map(DurableDeferred.await(gate), (value) => `gated:${value}`)

      const result = yield* withEngine(WakeBus.layer, (makeEngine) =>
        Effect.gen(function*() {
          const bus = yield* WakeBus.WakeBus
          const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(EventFlow as never, handler as never)
          const caller = yield* engine.execute(EventFlow as never, {
            executionId: "wake-event",
            payload: {},
            discard: false
          }).pipe(Effect.forkChild({ startImmediately: true }))
          // The caller has parked on the bus: its poll sleep is an hour of
          // TestClock time that this test never grants.
          yield* untilWaiters(bus, "wake-event", 1)

          yield* engine.deferredDone(gate as never, {
            flowName: EventFlow._tag,
            executionId: "wake-event",
            deferredName: gate.name,
            exit: Exit.succeed("open")
          })
          const value = yield* Fiber.join(caller)
          return { value, nowMs: yield* Clock.currentTimeMillis }
        }))

      expect(result.value).toBe("gated:open")
      // The virtual clock never moved: no poll tick fired, so the resume was
      // carried entirely by the wake bus.
      expect(result.nowMs).toBe(0)
    }))

  it.effect("interrupting the waiting caller cleans up its bus subscription", () =>
    Effect.gen(function*() {
      const InterruptFlow = Flow.make("Wake/interrupted", {
        payload: {},
        success: Schema.String,
        suspendedRetryPolicy: hourPolicy,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("interrupted-gate", { success: Schema.String })
      const handler = () => DurableDeferred.await(gate)

      const waiters = yield* withEngine(WakeBus.layer, (makeEngine) =>
        Effect.gen(function*() {
          const bus = yield* WakeBus.WakeBus
          const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(InterruptFlow as never, handler as never)
          const caller = yield* engine.execute(InterruptFlow as never, {
            executionId: "wake-interrupted",
            payload: {},
            discard: false
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* untilWaiters(bus, "wake-interrupted", 1)

          yield* Fiber.interrupt(caller)
          return yield* bus.waiters("wake-interrupted")
        }))

      expect(waiters).toBe(0)
    }))

  it.effect("two callers following one parked run do not wake each other into a re-drive loop", () =>
    Effect.gen(function*() {
      const FollowedFlow = Flow.make("Wake/followed", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      // The engine port takes the policy per call; the declaration's is
      // applied only by `Flow.execute`.
      const suspendedRetryPolicy = RetryPolicy.make({ initialMs: 5_000, factor: 1, maxMs: 5_000 })
      const gate = DurableDeferred.make("followed-gate", { success: Schema.String })
      let drives = 0
      const handler = () =>
        Effect.suspend(() => {
          drives++
          return Effect.map(DurableDeferred.await(gate), (value) => `followed:${value}`)
        })

      const result = yield* withEngine(WakeBus.layer, (makeEngine) =>
        Effect.gen(function*() {
          const bus = yield* WakeBus.WakeBus
          const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(FollowedFlow as never, handler as never)
          const follow = engine.execute(FollowedFlow as never, {
            executionId: "wake-followed",
            payload: {},
            discard: false,
            suspendedRetryPolicy
          }).pipe(Effect.forkChild({ startImmediately: true }))
          const first = yield* follow
          yield* untilWaiters(bus, "wake-followed", 1)
          // Out of phase, so one caller's poll lands while the other sleeps.
          yield* TestClock.adjust("2 seconds")
          const second = yield* follow
          yield* untilWaiters(bus, "wake-followed", 2)

          // One poll tick, then time stands still. The run must settle back
          // into its park: a caller that resumed on a wake would announce
          // another wake, and the two callers would re-drive the run back to
          // back for as long as the scheduler kept turning.
          //
          // The tick is settled once it has driven the run and both callers
          // are parked on the bus again. Each caller parks only after the
          // drive its own `execute` joined has finished, and each drive waits
          // on real database I/O, so no count of scheduler turns can stand in
          // for this: on a loaded runner the woken caller's drive can land
          // after any fixed number of turns.
          const beforeTick = drives
          yield* TestClock.adjust("3 seconds")
          yield* TestDatabase.until(
            Effect.map(bus.waiters("wake-followed"), (waiters) => drives > beforeTick && waiters === 2)
          )
          const settled = drives
          // With the clock stopped, nothing but a wake loop can drive the run
          // again. Give such a loop scheduler turns and real time for its
          // database round trips, both of which it needs to make progress.
          for (let window = 0; window < 100; window++) {
            yield* Effect.repeat(Effect.yieldNow, { times: 50 })
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          }
          const later = drives

          yield* engine.deferredDone(gate as never, {
            flowName: FollowedFlow._tag,
            executionId: "wake-followed",
            deferredName: gate.name,
            exit: Exit.succeed("open")
          })
          return { settled, later, values: [yield* Fiber.join(first), yield* Fiber.join(second)] }
        }))

      expect(result.later).toBe(result.settled)
      expect(result.values).toEqual(["followed:open", "followed:open"])
    }))

  it.effect("a follower joins a run parked on an event instead of driving it again", () =>
    Effect.gen(function*() {
      const JoinedFlow = Flow.make("Wake/joined", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("joined-gate", { success: Schema.String })
      let drives = 0
      const handler = () =>
        Effect.suspend(() => {
          drives++
          return Effect.map(DurableDeferred.await(gate), (value) => `joined:${value}`)
        })

      const result = yield* withEngine(WakeBus.layer, (makeEngine) =>
        Effect.gen(function*() {
          const bus = yield* WakeBus.WakeBus
          const state = yield* DurableEngineState.DurableEngineState
          const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
          yield* engine.register(JoinedFlow as never, handler as never)
          // Admission drives the run to its park; the discard follower then
          // dispatches the round again and parks on the bus.
          yield* engine.execute(JoinedFlow as never, {
            executionId: "wake-joined",
            payload: {},
            discard: true,
            suspendedRetryPolicy: hourPolicy
          })
          yield* untilWaiters(bus, "wake-joined", 1)
          const parked = { drives, waiting: yield* state.waiting("wake-joined") }

          yield* engine.deferredDone(gate as never, {
            flowName: JoinedFlow._tag,
            executionId: "wake-joined",
            deferredName: gate.name,
            exit: Exit.succeed("open")
          })
          // A parked run already polls as `Suspended`; wait for the answer.
          yield* TestDatabase.until(
            Effect.map(
              engine.poll(JoinedFlow as never, "wake-joined"),
              (result) => result._tag === "Some" && result.value._tag === "Complete"
            )
          )
          return { parked, drives, value: yield* engine.poll(JoinedFlow as never, "wake-joined") }
        }))

      // The follower's dispatch joined the park: no second claim, no replay,
      // and the waiting row a signal would complete stayed in place.
      expect(result.parked.drives).toBe(1)
      expect(result.parked.waiting._tag).toBe("Some")
      // One wake, one re-drive.
      expect(result.drives).toBe(2)
      expect(result.value).toMatchObject({ _tag: "Some", value: { _tag: "Complete" } })
    }))

  it.effect("the polling fallback still resumes the caller when the bus misses the wake", () =>
    Effect.gen(function*() {
      const FallbackFlow = Flow.make("Wake/fallback", {
        payload: {},
        success: Schema.String,
        suspendedRetryPolicy: RetryPolicy.make({
          initialMs: 5_000,
          factor: 1,
          maxMs: 5_000
        }),
        body: opaqueHandlerBody
      })
      const gate = DurableDeferred.make("fallback-gate", { success: Schema.String })
      const handler = () => Effect.map(DurableDeferred.await(gate), (value) => `polled:${value}`)
      const parked = yield* Deferred.make<void>()

      // Every wake is dropped: the composition behaves as if the bus missed.
      const result = yield* withEngine(
        WakeBus.layerNoop({
          awaitWake: () => Deferred.succeed(parked, undefined).pipe(Effect.andThen(Effect.never))
        }),
        (makeEngine) =>
          Effect.gen(function*() {
            const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
            yield* engine.register(FallbackFlow as never, handler as never)
            const caller = yield* engine.execute(FallbackFlow as never, {
              executionId: "wake-fallback",
              payload: {},
              discard: false
            }).pipe(Effect.forkChild({ startImmediately: true }))
            // A suspended row alone does not mean the caller has reached its
            // first poll wait. Observe the caller entering that wait before
            // completion re-drives the run, so only the fallback tick can wake it.
            yield* Deferred.await(parked)
            yield* engine.deferredDone(gate as never, {
              flowName: FallbackFlow._tag,
              executionId: "wake-fallback",
              deferredName: gate.name,
              exit: Exit.succeed("late")
            })
            yield* TestClock.adjust(0)
            const before = caller.pollUnsafe()
            yield* TestClock.adjust("5 seconds")
            const value = yield* Fiber.join(caller)
            return { before, value }
          })
      )

      expect(result.before).toBeUndefined()
      expect(result.value).toBe("polled:late")
    }))
})
