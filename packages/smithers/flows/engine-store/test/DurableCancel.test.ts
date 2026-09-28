import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins issue #11: a durably recorded cancellation request
 * (`RunStore.requestCancel` / `cancel_requested_at_ms`) must be observed by
 * the owning driver — polled during execution and guarded at finalize — not
 * written once and ignored forever.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("DurableCancel/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const ownerA: Ownership.OwnerId = {
  hostId: "cancel-host-a",
  pid: 1,
  nonce: "cancel-owner-a"
}

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = (owner: Ownership.OwnerId) =>
  RunDriver.make({
    owner,
    journalSource: `cancel-${owner.nonce}`,
    isAlive: () => Effect.succeed(true),
    engine: Effect.succeed(fakeEngine)
  })

const provideJournal = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(stores),
    Effect.provide(TestClock.layer())
  )

describe("durable cancellation", () => {
  it.effect("finalize refuses to complete a run whose cancel was durably requested", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const journal = yield* Journal.Journal
        const driver = yield* makeDriver(ownerA)
        // The cancel request lands after execution starts but before finalize —
        // modelled by the flow itself durably requesting cancellation and then
        // completing normally.
        yield* driver.register(TestFlow, () =>
          Effect.gen(function*() {
            const nowMs = yield* Clock.currentTimeMillis
            yield* store.requestCancel("cancel-before-finalize", nowMs)
            return "done"
          }))
        yield* driver.execute(TestFlow, {
          executionId: "cancel-before-finalize",
          payload: {},
          discard: true
        })
        const row = yield* store.get("cancel-before-finalize")
        yield* journal.flush
        const entries = yield* journal.entries({ runId: "cancel-before-finalize" as never, limit: 100 })
        return { row, entries: entries.entries }
      })))

      expect(result.row.status).toBe("cancelled")
      expect(result.row.cancelRequestedAtMs).not.toBeNull()
      expect(result.entries.map((entry) => entry.eventType)).toContain("flows.engine.interrupted")
    }))

  it.effect("a cross-process cancel request interrupts a running flow within a poll interval", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver(ownerA)
        const started = yield* Latch.make(false)
        yield* driver.register(TestFlow, () => Latch.open(started).pipe(Effect.andThen(Effect.never)))
        const fiber = yield* driver.execute(TestFlow, {
          executionId: "cancel-cross-process",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)

        // A second process (the CLI) durably requests cancellation. The owning
        // driver never sees an in-process interrupt.
        const nowMs = yield* Clock.currentTimeMillis
        yield* store.requestCancel("cancel-cross-process", nowMs)
        yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatInterval) * 2)
        yield* Fiber.join(fiber)
        const row = yield* store.get("cancel-cross-process")
        return { row }
      })))

      expect(result.row.status).toBe("cancelled")
      expect(result.row.owner).toBeNull()
    }))
})
