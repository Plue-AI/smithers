/** #3412: cancellation of a linked pending child requires no execution catalog. */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const parent = Flow.make("PendingUnregisteredCancellation/Parent", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const child = Flow.make("PendingUnregisteredCancellation/Child", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const owner: Ownership.OwnerId = { hostId: "pending-cancel", pid: 1, nonce: "cleanup" }
// Cancellation must finish from persisted rows without invoking any engine operation.
const unusedEngine = {} as FlowRuntime.FlowRuntime["Service"]
const state = (flowName: string, parentExecutionId?: string) =>
  JSON.stringify({
    version: 1,
    flowName,
    payload: {},
    capabilityCeilings: [[]],
    ...(parentExecutionId === undefined ? {} : { parentExecutionId, onParentExit: "cancel" })
  })
const tick = Effect.gen(function*() {
  yield* TestClock.adjust(Ownership.heartbeatInterval)
  for (let turn = 0; turn < 1_000; turn++) yield* Effect.yieldNow
})

describe("pending child cancellation without a handler", () => {
  for (const registered of [true, false]) {
    it.effect(`settles the linked pending child when its handler is ${registered ? "registered" : "absent"}`, () =>
      Effect.gen(function*() {
        const result = yield* withCrypto(
          Effect.scoped(Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const waiting = yield* DurableEngineState.DurableEngineState
            const journal = yield* Journal.Journal
            const driver = yield* RunDriver.make({
              owner,
              journalSource: "pending-child-cancellation",
              isAlive: () => Effect.succeed(true),
              engine: Effect.succeed(unusedEngine)
            })
            let calls = 0
            const handler = () =>
              Effect.sync(() => {
                calls++
                return "must not run"
              })
            yield* driver.register(parent, handler)
            if (registered) yield* driver.register(child, handler)
            yield* runs.create("parent", state(parent._tag))
            expect(
              (yield* runs.claimAndOwn(
                "parent",
                {
                  status: "pending",
                  owner: null,
                  heartbeatAtMs: null
                },
                owner,
                0
              ))._tag
            ).toBe("Activated")
            yield* waiting.park("parent", { reason: "released" }, owner)
            expect((yield* runs.transitionOwned("parent", owner, "suspended", state(parent._tag)))._tag)
              .toBe("Transitioned")
            yield* runs.create("child", state(child._tag, "parent"))
            yield* waiting.recordRunParent("child", "parent")
            // An unrelated pending row must remain unowned and unexecuted.
            yield* runs.create("unrequested", state("PendingUnregisteredCancellation/Unrequested"))
            expect((yield* runs.get("child")).status).toBe("pending")
            expect((yield* runs.get("child")).cancelRequestedAtMs).toBeNull()
            yield* driver.interrupt(parent, "parent")
            const requested = yield* runs.get("child")
            expect(requested.cancelRequestedAtMs).not.toBeNull()
            expect(requested.cancelRequestedAtMs).toBe((yield* runs.get("parent")).cancelRequestedAtMs)
            // Include the pending-admission grace, then several full sweep turns.
            yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
            for (let turn = 0; turn < 4; turn++) yield* tick
            yield* journal.flush
            const events = yield* journal.entries({ runId: "child" as never, limit: 100 })
            return {
              parent: yield* runs.get("parent"),
              child: yield* runs.get("child"),
              unrelated: yield* runs.get("unrequested"),
              calls,
              parents: yield* waiting.runParents("child"),
              events: events.entries
            }
          })).pipe(Effect.provide(TestStores.layerAt(":memory:")))
        )
        expect(result.parent.status).toBe("cancelled")
        expect(result.child.owner).toBeNull()
        expect(result.child.claim).toBeNull()
        expect(result.calls).toBe(0)
        expect(result.unrelated).toMatchObject({
          status: "pending",
          owner: null,
          claim: null,
          cancelRequestedAtMs: null
        })
        expect(result.parents.map((edge) => edge.parentId)).toEqual(["parent"])
        expect(result.child.status).toBe("cancelled")
        expect(result.events.filter((entry) => entry.eventType === "flows.engine.interrupted")).toHaveLength(1)
      }))
  }

  it.effect("discovers a standalone pending request after reopening SQLite with no registrations", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "pending-cancel-restart-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(root, { recursive: true, force: true })))
      const file = join(root, "execution.sqlite")
      yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const old = yield* RunDriver.make({
            owner: { ...owner, nonce: "before-restart" },
            journalSource: "before-restart",
            isAlive: () => Effect.succeed(true),
            engine: Effect.succeed(unusedEngine)
          })
          yield* runs.create("standalone", state(child._tag))
          yield* old.interrupt(child, "standalone")
          expect(yield* runs.get("standalone")).toMatchObject({ status: "pending", owner: null, claim: null })
        })).pipe(Effect.provide(TestStores.layerAt(file)))
      )
      const row = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          yield* RunDriver.make({
            owner: { ...owner, nonce: "after-restart" },
            journalSource: "after-restart",
            isAlive: () => Effect.succeed(true),
            engine: Effect.succeed(unusedEngine)
          })
          yield* tick
          return yield* runs.get("standalone")
        })).pipe(Effect.provide(TestStores.layerAt(file)))
      )
      expect(row).toMatchObject({ status: "cancelled", owner: null, claim: null })
      expect(row.cancelRequestedAtMs).not.toBeNull()
    }))

  it.effect("bounds pages and gets beyond a denied prefix while later requests arrive", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        const pages: Array<ReadonlyArray<string>> = []
        const discovery: DurableEngineState.Service = {
          ...engineState,
          pendingCancellationRuns: (limit, after, through) =>
            engineState.pendingCancellationRuns(limit, after, through)
              .pipe(Effect.tap((rows) =>
                Effect.sync(() => {
                  pages.push(rows.map((row) => row.runId))
                })
              ))
        }
        let allowPrefix = false
        yield* RunDriver.make({
          owner,
          journalSource: "pending-cancel-fairness",
          isAlive: () => Effect.succeed(true),
          engine: Effect.succeed(unusedEngine),
          canExecute: (row) => Effect.succeed(row.runId === "z-target" || (allowPrefix && row.runId === "denied-00"))
        }).pipe(Effect.provideService(DurableEngineState.DurableEngineState, discovery))
        const request = (id: string) =>
          runs.create(id, state(child._tag)).pipe(
            Effect.andThen(runs.requestCancel(id, 0))
          )
        for (let index = 0; index < 65; index++) yield* request(`denied-${String(index).padStart(2, "0")}`)
        yield* request("z-target")
        yield* tick
        expect(pages[0]).toHaveLength(64)
        expect((yield* runs.get("z-target")).status).toBe("pending")
        for (let index = 0; index < 64; index++) yield* request(`zz-arrival-${index}`)
        yield* tick
        expect(pages[1]).toEqual(["denied-64", "z-target"])
        expect(yield* runs.get("z-target")).toMatchObject({ status: "cancelled", owner: null, claim: null })
        allowPrefix = true
        for (let index = 0; index < 64; index++) yield* request(`zzz-new-${index}`)
        yield* tick
        expect(pages[2]).toHaveLength(64)
        expect((yield* runs.get("denied-00")).status).toBe("cancelled")
        expect(yield* runs.get("denied-01")).toMatchObject({ status: "pending", owner: null, claim: null })
        expect(pages.every((page) => page.length <= 64)).toBe(true)
      })).pipe(Effect.provide(TestStores.layerAt(":memory:")))
    ))
})
