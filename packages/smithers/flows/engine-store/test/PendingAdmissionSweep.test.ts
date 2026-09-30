import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

// No filesystem effects: Jj supplies an unused host port; stores use real SQLite.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "pending-sweep" as never, changeId: "pending-sweep" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)
const stores = Layer.mergeAll(TestStores.layerAt(":memory:"), StepBoundary.layerTest(), jj)
const child = Flow.make("PendingAdmissionSweep/Child", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("done")
})
const admission = (flowName: string = child._tag) =>
  JSON.stringify({
    version: 1,
    flowName,
    payload: {},
    capabilityCeilings: [[]],
    onParentExit: "detach"
  })
const tick = Effect.gen(function*() {
  yield* TestClock.adjust("1 second")
  for (let turn = 0; turn < 1_000; turn++) yield* Effect.yieldNow
})

describe("pending admission sweep fairness and failures", () => {
  it.effect("gets past a refused batch in exactly two ticks without running at registration", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        for (let index = 0; index < 65; index++) {
          yield* runs.create(`denied-${String(index).padStart(2, "0")}`, admission())
        }
        yield* runs.create("z-allowed", admission())
        let calls = 0
        const engine = yield* EngineStore.make({
          owner: { hostId: "pending-fairness" },
          journalSource: "pending-fairness",
          canExecute: (row) => Effect.succeed(row.runId === "z-allowed")
        })
        yield* engine.register(child, () =>
          Effect.sync(() => {
            calls++
            return "done"
          }))
        expect(calls).toBe(0)
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        yield* tick
        expect(calls).toBe(0)
        yield* tick
        expect(calls).toBe(1)
        expect(Option.getOrThrow(yield* engine.poll(child, "z-allowed"))._tag).toBe("Complete")
        for (let index = 0; index < 65; index++) {
          expect((yield* runs.get(`denied-${String(index).padStart(2, "0")}`)).status).toBe("pending")
        }
      })).pipe(Effect.provide(stores))
    ))

  it.effect("revisits older refused work even with a full new batch arriving each tick", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        for (let index = 0; index < 64; index++) {
          yield* runs.create(`old-${String(index).padStart(2, "0")}`, admission())
        }
        let allowed = false
        let calls = 0
        const engine = yield* EngineStore.make({
          owner: { hostId: "pending-inflow" },
          journalSource: "pending-inflow",
          canExecute: (row) => Effect.succeed(allowed && row.runId === "old-00")
        })
        yield* engine.register(child, () =>
          Effect.sync(() => {
            calls++
            return "done"
          }))
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        yield* tick
        expect(calls).toBe(0)
        allowed = true
        for (let index = 0; index < 64; index++) {
          yield* runs.create(`new-${String(index).padStart(2, "0")}`, admission())
        }
        yield* tick
        expect(calls).toBe(1)
        expect((yield* runs.get("old-00")).status).toBe("completed")
      })).pipe(Effect.provide(stores))
    ))

  it.effect("rotates registered flows within exactly two ticks under a full refused backlog", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const second = Flow.make("PendingAdmissionSweep/Second", {
          payload: {},
          success: Schema.String,
          body: () => Node.succeed("done")
        })
        const engine = yield* EngineStore.make({
          owner: { hostId: "pending-flows" },
          journalSource: "pending-flows",
          canExecute: (row) => Effect.succeed(row.runId === "second-allowed")
        })
        let firstCalls = 0
        let secondCalls = 0
        yield* engine.register(child, () =>
          Effect.sync(() => {
            firstCalls++
            return "done"
          }))
        yield* engine.register(second, () =>
          Effect.sync(() => {
            secondCalls++
            return "done"
          }))
        for (let index = 0; index < 384; index++) {
          yield* runs.create(`denied-${String(index).padStart(3, "0")}`, admission())
        }
        yield* runs.create("second-allowed", admission(second._tag))
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        yield* tick
        expect(secondCalls).toBe(0)
        yield* tick
        expect(secondCalls).toBe(1)
        expect(firstCalls).toBe(0)
      })).pipe(Effect.provide(stores))
    ))

  it.effect("keeps registration alive through a storage failure and recovers on the next tick", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        yield* runs.create("read-failure", admission())
        let fail = true
        let reads = 0
        const failure = new RunStore.RunStoreError({
          code: "persistence_failed",
          method: "get",
          message: "temporary outage",
          cause: undefined
        })
        const engine = yield* EngineStore.make({
          owner: { hostId: "pending-storage" },
          journalSource: "pending-storage"
        }).pipe(
          Effect.provideService(RunStore.RunStore, {
            ...runs,
            get: (id) => {
              if (id === "read-failure" && fail) {
                reads++
                return Effect.fail(failure)
              }
              return runs.get(id)
            }
          })
        )
        let calls = 0
        const registration = yield* Effect.exit(engine.register(child, () =>
          Effect.sync(() => {
            calls++
            return "done"
          })))
        expect(Exit.isSuccess(registration)).toBe(true)
        expect(reads).toBe(0)
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        yield* tick
        expect(reads).toBe(1)
        expect(calls).toBe(0)
        expect((yield* runs.get("read-failure")).status).toBe("pending")
        fail = false
        yield* tick
        expect(calls).toBe(1)
        expect((yield* runs.get("read-failure")).status).toBe("completed")
      })).pipe(Effect.provide(stores))
    ))

  it.effect("cancels a pending admission before dispatching its handler", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        yield* runs.create("cancel-before-drive", admission())
        yield* runs.requestCancel("cancel-before-drive", 0)
        let calls = 0
        const engine = yield* EngineStore.make({ owner: { hostId: "pending-cancel" }, journalSource: "pending-cancel" })
        yield* engine.register(child, () =>
          Effect.sync(() => {
            calls++
            return "done"
          }))
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        yield* tick
        expect((yield* runs.get("cancel-before-drive")).status).toBe("cancelled")
        expect(calls).toBe(0)
      })).pipe(Effect.provide(stores))
    ))
  it.effect("one host cannot recover a fresh nested admission before its admitting host claims it", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const parent = Flow.make("PendingAdmissionSweep/LiveParent", {
          payload: {},
          success: Schema.String,
          body: () => Node.succeed("unused")
        })
        const wrapped: RunStore.Service = {
          ...runs,
          claim: (id, expected, owner, now) =>
            Effect.gen(function*() {
              if (id === "live-child") {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }
              return yield* runs.claim(id, expected, owner, now)
            })
        }
        const a = yield* EngineStore.make({ owner: { hostId: "admitting-host" }, journalSource: "admitting-host" })
          .pipe(
            Effect.provideService(RunStore.RunStore, wrapped)
          )
        const b = yield* EngineStore.make({ owner: { hostId: "recovering-host" }, journalSource: "recovering-host" })
        let aCalls = 0
        let bCalls = 0
        yield* a.register(child, () =>
          Effect.sync(() => {
            aCalls++
            return "host-a"
          }))
        yield* b.register(child, () =>
          Effect.sync(() => {
            bCalls++
            return "host-b"
          }))
        yield* a.register(parent, () => child.execute({}, { executionId: "live-child" }).pipe(Effect.orDie))
        const caller = yield* parent.execute({}, { executionId: "live-parent" }).pipe(
          Effect.provideService(FlowRuntime.FlowRuntime, a),
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        yield* tick
        const prematurelyRecovered = bCalls
        yield* Deferred.succeed(release, undefined)
        const value = yield* Fiber.join(caller)
        expect(prematurelyRecovered).toBe(0)
        expect(value).toBe("host-a")
        expect(aCalls).toBe(1)
        expect((yield* runs.get("live-child")).status).toBe("completed")
      })).pipe(Effect.provide(stores))
    ))

  it.effect("a corrupt pending row does not block a valid later admission", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const sql = yield* SqlClient
        yield* runs.create("a-poison", admission())
        yield* runs.create("b-valid", admission())
        yield* TestDatabase.checks(sql, false)
        yield* sql`UPDATE flows_runs SET owner_host_id = 'partial-owner' WHERE run_id = 'a-poison'`
        expect((yield* runs.get("a-poison").pipe(Effect.flip)).code).toBe("decode_failed")
        let calls = 0
        const engine = yield* EngineStore.make({ owner: { hostId: "pending-poison" }, journalSource: "pending-poison" })
        yield* engine.register(child, () =>
          Effect.sync(() => {
            calls++
            return "done"
          }))
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        yield* tick
        expect(calls).toBe(1)
        expect((yield* runs.get("b-valid")).status).toBe("completed")
        expect((yield* runs.get("a-poison").pipe(Effect.flip)).code).toBe("decode_failed")
      })).pipe(Effect.provide(stores))
    ))

  it.effect("a registration ending during eligibility stops every admitted handler", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        yield* runs.create("first", admission())
        yield* runs.create("second", admission())
        const registrationScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(registrationScope, Exit.void))
        let close = true
        let calls = 0
        const engine = yield* EngineStore.make({
          owner: { hostId: "pending-registration" },
          journalSource: "pending-registration",
          canExecute: () =>
            close ? Scope.close(registrationScope, Exit.void).pipe(Effect.as(true)) : Effect.succeed(true)
        })
        yield* engine.register(child, () =>
          Effect.sync(() => {
            calls++
            return "done"
          })).pipe(Scope.provide(registrationScope))
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        yield* tick
        expect(calls).toBe(0)
        expect((yield* runs.get("first")).status).toBe("pending")
        expect((yield* runs.get("second")).status).toBe("pending")
        close = false
        yield* engine.register(child, () =>
          Effect.sync(() => {
            calls++
            return "done"
          }))
        yield* tick
        expect(calls).toBe(2)
      })).pipe(Effect.provide(stores))
    ))

  it.effect("a row removed between enumeration and read cannot block the rest of the page", () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const sql = yield* SqlClient
        yield* runs.create("a-gone", admission())
        yield* runs.create("b-kept", admission())
        let remove = true
        const wrapped: RunStore.Service = {
          ...runs,
          get: (id) =>
            Effect.gen(function*() {
              if (id === "a-gone" && remove) {
                remove = false
                yield* sql`DELETE FROM flows_runs WHERE run_id = ${id}`.pipe(Effect.orDie)
              }
              return yield* runs.get(id)
            })
        }
        let calls = 0
        const engine = yield* EngineStore.make({
          owner: { hostId: "pending-retention" },
          journalSource: "pending-retention"
        }).pipe(
          Effect.provideService(RunStore.RunStore, wrapped)
        )
        yield* engine.register(child, () =>
          Effect.sync(() => {
            calls++
            return "done"
          }))
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        yield* tick
        expect(calls).toBe(1)
        expect((yield* runs.get("a-gone").pipe(Effect.flip)).code).toBe("not_found_row")
        expect((yield* runs.get("b-kept")).status).toBe("completed")
      })).pipe(Effect.provide(stores))
    ))
})
