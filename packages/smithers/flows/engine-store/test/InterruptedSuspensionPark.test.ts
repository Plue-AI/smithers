import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * A round interrupted AFTER its flow asked to suspend parks under the reason
 * the flow was waiting for, not as `released`.
 *
 * `InterruptReleaseReclaim.test.ts` covers the other half: a round that had
 * not asked for anything is a shutdown, and `released` is what it is (issue
 * #39). This file covers the park, which the release validation found by watching a
 * `smithers up -d` process park a run and exit. The round's own settlement
 * derives the same three answers a few statements later, so losing the race to
 * a shutdown must not lose the classification with it: a `released` row
 * carries no wake time and no token, so a run suspended on a 150-second clock
 * came back as a run whose owner merely went away, and every sweep had to
 * re-drive it blind instead of waking it when its deadline fell due.
 *
 * The shape here is the executor's own. `AgentSession` forks the agent body
 * under the registered handler and joins it, so a suspension taken inside that
 * fork is written on the shared flow instance while the handler is still in
 * the round; a process exit lands its interrupt exactly there.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("InterruptedSuspensionPark/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const jj = Jj.make({
  snapshot: () =>
    Effect.succeed({ commitId: "interrupted-park-snapshot" as never, changeId: "interrupted-park-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** A wait that suspends the round it runs in, in the engine's own vocabulary. */
type DurableWait = Effect.Effect<
  unknown,
  unknown,
  FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Crypto.Crypto
>

/** Everything the interrupted park left on disk. */
interface Park {
  readonly row: RunStore.RunRow
  readonly waiting: Option.Option<{
    readonly reason: string
    readonly wakeAt: number | null
    readonly token: string | null
  }>
  readonly clocks: ReadonlyArray<{ readonly dueAtMs: number }>
  readonly approvalSweep: ReadonlyArray<{ readonly runId: string }>
  readonly releasedSweep: ReadonlyArray<{ readonly runId: string }>
}

/** The `Flow.Result` the park recorded on the run row, if it recorded one. */
const recordedResult = (stateJson: string): { readonly _tag?: string } | undefined =>
  (JSON.parse(stateJson) as { readonly result?: { readonly _tag?: string } }).result

/**
 * Runs `wait` inside one round, waits for it to suspend, then closes the
 * engine's scope the way process shutdown closes it, and reads the durable
 * row the interruption left behind.
 */
const parkByShutdown = (executionId: string, wait: DurableWait) => {
  const state = DurableEngineState.makeMemory()
  return withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const engineScope = yield* Scope.make()
        const engine = (yield* EngineStore.make({
          owner: { hostId: "interrupted-park-host" },
          journalSource: "interrupted-park-test",
          isAlive: () => Effect.succeed(false)
        }).pipe(Scope.provide(engineScope))) as FlowRuntime.FlowRuntime["Service"]
        const suspended = yield* Latch.make(false)
        yield* engine.register(
          TestFlow,
          () =>
            Effect.gen(function*() {
              const waiter = yield* Effect.forkChild(wait, { startImmediately: true })
              // A durable wait suspends by interrupting its own fiber, so its
              // exit is how the round learns the suspension was taken.
              yield* Fiber.await(waiter)
              yield* Latch.open(suspended)
              return yield* Effect.never
            })
        )
        yield* engine.execute(TestFlow, {
          executionId,
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(suspended)
        yield* Scope.close(engineScope, Exit.void)
        return {
          row: yield* store.get(executionId),
          waiting: yield* state.waiting(executionId),
          clocks: yield* state.pendingClocks({ executionId }),
          approvalSweep: yield* state.waitingRuns({ reason: "approval" }),
          releasedSweep: yield* state.waitingRuns({ reason: "released" })
        }
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, state),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.orDie
    )
  )
}

describe("a shutdown that interrupts a suspended round parks it, and says what for", () => {
  it.effect("keeps the approval the flow declared, with its wake token", () =>
    Effect.gen(function*() {
      const gate = DurableDeferred.make("interrupted-park-approval", { success: Schema.String })
      const result = yield* parkByShutdown(
        "interrupted-park-approval",
        Effect.andThen(
          FlowRuntime.annotateWaiting({ reason: "approval", token: "request-9" }),
          DurableDeferred.await(gate)
        )
      )

      expect(result.row.status).toBe("suspended")
      const parked = Option.getOrThrow(result.waiting)
      expect(parked.reason).toBe("approval")
      expect(parked.token).toBe("request-9")
      expect(result.approvalSweep.map((waiting) => waiting.runId)).toEqual(["interrupted-park-approval"])
      // The park carries the suspension itself. `poll` publishes a state with
      // no result as "not settled yet", so a park recorded without one is
      // invisible to every resumer: `smithers approve` accepted the request
      // and then drove nothing (release rehearsal).
      expect(recordedResult(result.row.stateJson)?._tag).toBe("Suspended")
    }))

  it.effect("derives 'timer' and the earliest deadline from an undeclared clock wait", () =>
    Effect.gen(function*() {
      const result = yield* parkByShutdown(
        "interrupted-park-timer",
        DurableClock.sleep({
          name: "interrupted-park-clock",
          duration: "5 minutes",
          inMemoryThreshold: "1 second"
        })
      )

      expect(result.row.status).toBe("suspended")
      const parked = Option.getOrThrow(result.waiting)
      expect(parked.reason).toBe("timer")
      expect(result.clocks.length).toBeGreaterThan(0)
      expect(parked.wakeAt).toBe(Math.min(...result.clocks.map((clock) => clock.dueAtMs)))
      expect(recordedResult(result.row.stateJson)?._tag).toBe("Suspended")
    }))

  it.effect("falls back to 'event' when the flow declared nothing and armed no clock", () =>
    Effect.gen(function*() {
      const gate = DurableDeferred.make("interrupted-park-event", { success: Schema.String })
      const result = yield* parkByShutdown(
        "interrupted-park-event",
        DurableDeferred.await(gate)
      )

      expect(result.row.status).toBe("suspended")
      expect(Option.getOrThrow(result.waiting).reason).toBe("event")
      // A run that asked to suspend is parked, never released: `released` is
      // reserved for a round that had asked for nothing (issue #39).
      expect(result.releasedSweep.map((waiting) => waiting.runId)).toEqual([])
      expect(recordedResult(result.row.stateJson)?._tag).toBe("Suspended")
    }))
})
