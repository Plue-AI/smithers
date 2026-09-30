/**
 * Cancelling a child is a terminal settlement, so it wakes every durable parent
 * already parked on it without an explicit parent resume (#2758): parents
 * attached to the original round and to the successor round, several at once,
 * whether the cancelling driver is the one that ran them or another driver over
 * the same store, and when the cancellation commits while a parent is still in
 * the round that is about to park. Every case runs on a real file-backed
 * SQLite store.
 */
import { assert, describe, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const Child = Flow.make("CancelWake/child", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const Next = Flow.make("CancelWake/next", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const Parent = Flow.make("CancelWake/parent", { payload: {}, success: Schema.String, body: opaqueHandlerBody })

type TestServices = Layer.Success<ReturnType<typeof TestStores.layerAt>> | Scope.Scope | Crypto.Crypto

const onDisk = <A, E>(body: Effect.Effect<A, E, TestServices>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "smithers-cancel-wake-"))),
    (directory) =>
      withCrypto(body.pipe(Effect.scoped, Effect.provide(TestStores.layerAt(join(directory, "engine.db"))))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
  )

/** Where the parent attaches, and to which round. */
type Attach = "original" | "successor"

/** What each parent read from the child, in order. */
type Observation = "Suspended" | "Interrupted" | "Other"

const fixture = (nonce: string) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const state = yield* DurableEngineState.DurableEngineState
    const receipts: Array<readonly [driver: string, id: string, reason: string]> = []
    const observed: Record<string, Array<Observation>> = {}
    const attach: Record<string, Attach> = {}
    /** Runs inside a parent's first round, after it read `Suspended`. */
    const beforePark: Record<string, Effect.Effect<void>> = {}
    const successor = yield* FlowEngine.Round.next(FlowEngine.Round.initial("child"), {
      flowName: Child._tag,
      maxRounds: undefined
    })

    const makeDriver = (name: string) =>
      Effect.gen(function*() {
        const driver = yield* RunDriver.make({
          owner: { hostId: name, pid: process.pid, nonce: `${nonce}-${name}` },
          journalSource: "child-cancellation-wake",
          isAlive: () => Effect.succeed(false),
          engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"]),
          requestResume: (id, reason) =>
            Effect.sync(() => {
              receipts.push([name, id, reason])
            })
        })
        yield* driver.register(Child, () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
            return "handed off"
          }))
        yield* driver.register(Next, () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            instance.waiting = { reason: "approval" }
            return yield* Flow.suspend(instance)
          }))
        yield* driver.register(Parent, () =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            const id = instance.executionId
            const result = attach[id] === "successor"
              ? yield* driver.execute(Next, {
                executionId: successor.executionId,
                payload: {},
                discard: false,
                parent: instance,
                round: successor.round
              })
              : yield* driver.execute(Child, { executionId: "child", payload: {}, discard: false, parent: instance })
            const seen = (observed[id] ??= [])
            if (result._tag !== "Complete") {
              seen.push("Suspended")
              const hook = beforePark[id]
              if (hook !== undefined) {
                delete beforePark[id]
                yield* hook
              }
              return yield* Flow.suspend(instance)
            }
            seen.push(Exit.isFailure(result.exit) && Cause.hasInterrupts(result.exit.cause) ? "Interrupted" : "Other")
            return "observed"
          }))
        const drained = Effect.gen(function*() {
          for (let turn = 0; turn < 2000; turn++) {
            if ((yield* driver.active).size === 0) return
            yield* Effect.sleep("2 millis")
          }
          return yield* Effect.die(`driver ${name} did not drain`)
        })
        return { driver, drained }
      })

    const status = (id: string) => store.get(id).pipe(Effect.map((row) => row.status))
    const statuses = (ids: ReadonlyArray<string>) => Effect.forEach(ids, status)
    const until = (id: string, wanted: RunStore.RunStatus) =>
      Effect.gen(function*() {
        let last: RunStore.RunStatus | undefined
        for (let turn = 0; turn < 5000; turn++) {
          last = yield* status(id)
          if (last === wanted) return
          yield* Effect.sleep("5 millis")
        }
        return yield* Effect.die(`${id} never became ${wanted}; last ${last}`)
      })

    return { state, receipts, observed, attach, beforePark, successor, makeDriver, statuses, until }
  })

describe("cancelling a child wakes its parked durable parents (#2758)", () => {
  for (const cancelling of ["local", "cross-driver"] as const) {
    it.live(`wakes several parents on the original and successor rounds: ${cancelling} cancellation`, () =>
      onDisk(Effect.gen(function*() {
        const test = yield* fixture(cancelling)
        const home = yield* test.makeDriver("home")
        const other = cancelling === "local" ? home : yield* test.makeDriver("other")
        const parents = { "parent-a": "original", "parent-b": "original", "parent-c": "successor" } as const
        Object.assign(test.attach, parents)

        yield* home.driver.execute(Child, { executionId: "child", payload: {}, discard: true })
        yield* home.drained
        assert.deepStrictEqual(yield* test.statuses(["child", test.successor.executionId]), [
          "completed",
          "suspended"
        ])
        for (const id of Object.keys(parents)) {
          yield* home.driver.execute(Parent, { executionId: id, payload: {}, discard: false })
          yield* home.drained
        }
        assert.deepStrictEqual(yield* test.statuses(Object.keys(parents)), ["suspended", "suspended", "suspended"])
        assert.deepStrictEqual((yield* test.state.runParents("child")).map((edge) => edge.parentId), [
          "parent-a",
          "parent-b"
        ])
        assert.deepStrictEqual(
          (yield* test.state.runParents(test.successor.executionId)).map((edge) => edge.parentId),
          ["parent-c"]
        )
        assert.deepStrictEqual(test.receipts, [])

        yield* other.driver.interrupt(Next, test.successor.executionId)
        yield* test.until(test.successor.executionId, "cancelled")
        for (const id of Object.keys(parents)) yield* test.until(id, "completed")
        yield* home.drained
        yield* other.drained

        assert.deepStrictEqual(test.observed, {
          "parent-a": ["Suspended", "Interrupted"],
          "parent-b": ["Suspended", "Interrupted"],
          "parent-c": ["Suspended", "Interrupted"]
        })
        // Whichever driver commits the cancellation (a request from another
        // driver is committed by the one holding the parked round) asks the
        // host to resume each parked parent exactly once.
        assert.deepStrictEqual(test.receipts.map(([, id, reason]) => [id, reason]).sort(), [
          ["parent-a", "parent"],
          ["parent-b", "parent"],
          ["parent-c", "parent"]
        ])
        assert.strictEqual(new Set(test.receipts.map(([driver]) => driver)).size, 1)
      })))
  }

  it.live("wakes a parent whose round is still running when the cancellation commits", () =>
    onDisk(Effect.gen(function*() {
      const test = yield* fixture("race")
      const { driver, drained } = yield* test.makeDriver("home")
      test.attach["racing-parent"] = "successor"
      // The parent has read `Suspended` and has not parked yet: no waiting
      // row exists, so the wake must be carried by the running round.
      test.beforePark["racing-parent"] = Effect.gen(function*() {
        yield* driver.interrupt(Next, test.successor.executionId)
        yield* test.until(test.successor.executionId, "cancelled")
      }).pipe(Effect.orDie)

      yield* driver.execute(Child, { executionId: "child", payload: {}, discard: true })
      yield* drained
      yield* driver.execute(Parent, { executionId: "racing-parent", payload: {}, discard: false })
      yield* test.until("racing-parent", "completed")
      yield* drained

      assert.deepStrictEqual(yield* test.statuses([test.successor.executionId, "racing-parent"]), [
        "cancelled",
        "completed"
      ])
      assert.deepStrictEqual(test.observed, { "racing-parent": ["Suspended", "Interrupted"] })
      // It was not parked when the cancellation announced itself, so no host
      // resume receipt is recorded for it.
      assert.deepStrictEqual(test.receipts, [])
    })))

  it.live("leaves parents parked when the cancel request loses to the child's own settlement", () =>
    onDisk(Effect.gen(function*() {
      const test = yield* fixture("fenced")
      const { driver, drained } = yield* test.makeDriver("home")
      test.attach["unrelated-parent"] = "original"
      yield* driver.execute(Child, { executionId: "child", payload: {}, discard: true })
      yield* drained
      yield* driver.execute(Parent, { executionId: "unrelated-parent", payload: {}, discard: false })
      yield* drained
      // Round zero already handed off, so a cancel against it transitions
      // nothing and must announce nothing.
      yield* driver.interrupt(Child, "child")
      yield* drained
      assert.deepStrictEqual(yield* test.statuses(["child", test.successor.executionId, "unrelated-parent"]), [
        "completed",
        "suspended",
        "suspended"
      ])
      assert.deepStrictEqual(test.observed, { "unrelated-parent": ["Suspended"] })
      assert.deepStrictEqual(test.receipts, [])
    })))
})
