import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Clock, Effect, Exit, Fiber, Latch, Schema } from "effect"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeAndDrain } from "./ExecuteAndDrain.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const First = Flow.make("LineageCancel/First", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const Next = Flow.make("LineageCancel/Next", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const fakeEngine = {} as FlowRuntime.FlowRuntime["Service"]
const driver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: "lineage-test", pid: 1, nonce },
    journalSource: "lineage-test",
    isAlive: () => Effect.succeed(true),
    engine: Effect.succeed(fakeEngine)
  })
const state = (onParentExit: "cancel" | "detach" = "cancel") =>
  JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: Next._tag, payload: {}, onParentExit })

const seedOwner = { hostId: "seed", pid: 1, nonce: "seed" }
const complete = (store: RunStore.Service, id: string, value = state()) =>
  Effect.gen(function*() {
    yield* store.claimAndOwn(
      id,
      { status: "pending", owner: null, heartbeatAtMs: null },
      seedOwner,
      yield* Clock.currentTimeMillis
    )
    yield* store.transitionOwned(id, seedOwner, "completed", value)
  })

const seedHandoff = (store: RunStore.Service, contents = state()) =>
  Effect.gen(function*() {
    yield* store.create("root", contents, { lineageId: "root", roundOrdinal: 0 })
    yield* store.create("next", contents, { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
    yield* complete(store, "root", contents)
  })

const cancelFromProcess = (filename: string, runId: string) =>
  Effect.promise(() =>
    promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("./fixtures/cancel-lineage-process.mjs", import.meta.url)),
      filename,
      runId
    ], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" },
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 524_288
    })
  )

describe("cancellation follows logical runs", () => {
  for (const status of ["running", "suspended"] as const) {
    it(`a separate process cancels a ${status} successor through its completed root`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "smithers-lineage-owned-"))
      const filename = join(directory, "engine.db")
      try {
        await Effect.runPromise(
          Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const durableState = yield* DurableEngineState.DurableEngineState
            const owner = yield* driver("live-owner")
            const entered = yield* Latch.make()
            let calls = 0
            let cleanup = 0
            yield* owner.register(Next, () =>
              Effect.gen(function*() {
                calls++
                yield* entered.open
                if (status === "running") return yield* Effect.never
                return yield* Flow.suspend(yield* FlowRuntime.FlowInstance)
              }).pipe(Effect.ensuring(Effect.sync(() => {
                cleanup++
              }))))
            yield* seedHandoff(store)
            const drive = yield* executeAndDrain(owner, Next, {
              executionId: "next",
              payload: {},
              discard: true,
              round: { ...FlowEngine.Round.initial("root"), ordinal: 1, previousExecutionId: "root" }
            }).pipe(Effect.forkScoped)
            yield* entered.await
            if (status === "suspended") yield* Fiber.join(drive)
            expect((yield* store.get("next")).status).toBe(status)
            const result = yield* cancelFromProcess(filename, "root")
            expect(JSON.parse(result.stdout)).toEqual({ requested: "root" })
            let row = yield* store.get("next")
            for (let tick = 0; tick < 200 && row.status !== "cancelled"; tick++) {
              yield* Effect.sleep("50 millis")
              row = yield* store.get("next")
            }
            expect(row.status).toBe("cancelled")
            expect(row.cancelRequestedAtMs).not.toBeNull()
            expect((yield* store.get("root")).status).toBe("completed")
            expect((yield* durableState.waiting("next"))._tag).toBe("None")
            expect(calls).toBe(1)
            expect(cleanup).toBe(1)
            yield* Fiber.join(drive)
          }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(filename)), withCrypto)
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, 120_000)
  }

  it("cancels a successor from a fresh OS process with no shared driver or connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smithers-lineage-cancel-"))
    const filename = join(directory, "engine.db")
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const owner = yield* driver("owner")
          yield* seedHandoff(store)
          const result = yield* cancelFromProcess(filename, "root")
          expect(JSON.parse(result.stdout)).toEqual({ requested: "root" })
          expect((yield* store.get("next")).cancelRequestedAtMs).not.toBeNull()
          let calls = 0
          yield* owner.register(Next, () =>
            Effect.sync(() => {
              calls++
              return "forbidden"
            }))
          yield* executeAndDrain(owner, Next, {
            executionId: "next",
            payload: {},
            discard: true,
            round: { ...FlowEngine.Round.initial("root"), ordinal: 1, previousExecutionId: "root" }
          })
          expect(calls).toBe(0)
          expect((yield* store.get("next")).status).toBe("cancelled")
        }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(filename)), withCrypto)
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it.effect("cancellation that commits before handoff admission prevents successor creation", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      const observer = yield* driver("observer")
      let cancelBeforeNextTransaction = false
      const intercepted: DurableEngineState.Service = {
        ...state,
        transaction: (effect) =>
          Effect.gen(function*() {
            if (cancelBeforeNextTransaction) {
              cancelBeforeNextTransaction = false
              yield* observer.interrupt(First, "racing-root").pipe(Effect.orDie)
            }
            return yield* state.transaction(effect)
          })
      }
      const owner = yield* driver("owner").pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, intercepted)
      )
      yield* owner.register(First, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
          cancelBeforeNextTransaction = true
          return "handoff"
        }))
      yield* executeAndDrain(owner, First, { executionId: "racing-root", payload: {}, discard: true })
      const next = yield* FlowEngine.Round.next(FlowEngine.Round.initial("racing-root"), {
        flowName: First._tag,
        maxRounds: undefined
      })
      expect((yield* store.get("racing-root")).status).toBe("cancelled")
      expect((yield* Effect.flip(store.get(next.executionId))).code).toBe("not_found_row")
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

  for (const policy of ["cancel", "detach"] as const) {
    for (const ending of ["completed", "exhausted"] as const) {
      it.effect(`applies ${policy} policy to earlier-round children when the logical parent is ${ending}`, () =>
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const edges = yield* DurableEngineState.DurableEngineState
          const owner = yield* driver("owner")
          yield* seedHandoff(store, JSON.stringify({ ...JSON.parse(state()), maxRounds: 2 }))
          yield* store.create("child", state(policy), { lineageId: "child", roundOrdinal: 0 })
          yield* store.create(
            "child-next",
            JSON.stringify({
              ...JSON.parse(state()),
              flowName: "LineageCancel/unregistered-child"
            }),
            { lineageId: "child", roundOrdinal: 1, parentRunId: "child" }
          )
          yield* complete(store, "child", state(policy))
          yield* edges.recordRunParent("child", "root")
          yield* owner.register(Next, () =>
            Effect.gen(function*() {
              if (ending === "exhausted") {
                const instance = yield* FlowRuntime.FlowInstance
                instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
              }
              return "finished"
            }))
          yield* executeAndDrain(owner, Next, {
            executionId: "next",
            payload: {},
            discard: true,
            round: { ...FlowEngine.Round.initial("root"), ordinal: 1, previousExecutionId: "root" }
          })
          expect((yield* store.get("next")).status).toBe(ending === "completed" ? "completed" : "failed")
          expect((yield* store.get("child-next")).cancelRequestedAtMs !== null).toBe(policy === "cancel")
        }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))
    }
  }

  it.effect("inherits cancellation onto a child admitted under an earlier completed round", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const owner = yield* driver("owner")
      yield* seedHandoff(store)
      yield* owner.interrupt(First, "root")
      let calls = 0
      yield* owner.register(Next, () =>
        Effect.sync(() => {
          calls++
          return "forbidden"
        }))
      yield* executeAndDrain(owner, Next, {
        executionId: "late-child",
        payload: {},
        discard: true,
        parent: { executionId: "root" } as FlowRuntime.FlowInstance["Service"]
      })
      expect(calls).toBe(0)
      expect((yield* store.get("late-child")).status).toBe("cancelled")
      expect((yield* store.get("late-child")).cancelRequestedAtMs).toBe((yield* store.get("next")).cancelRequestedAtMs)
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

  it.effect("rolls back every request when a later descendant write fails, then retries", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const edges = yield* DurableEngineState.DurableEngineState
      yield* seedHandoff(store)
      yield* store.create("child", state())
      yield* edges.recordRunParent("child", "next")
      const broken = {
        ...store,
        requestCancel: (id: string, at: number) =>
          id === "child"
            ? Effect.fail(
              new RunStore.RunStoreError({
                method: "requestCancel",
                code: "persistence_failed",
                message: "injected",
                cause: undefined
              })
            )
            : store.requestCancel(id, at)
      }
      const canceller = yield* driver("broken").pipe(Effect.provideService(RunStore.RunStore, broken))
      expect(Exit.isFailure(yield* Effect.exit(canceller.interrupt(First, "root")))).toBe(true)
      expect((yield* store.get("next")).cancelRequestedAtMs).toBeNull()
      expect((yield* store.get("child")).cancelRequestedAtMs).toBeNull()
      yield* (yield* driver("retry")).interrupt(First, "root")
      expect((yield* store.get("next")).cancelRequestedAtMs).not.toBeNull()
      expect((yield* store.get("child")).cancelRequestedAtMs).not.toBeNull()
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

  it.effect("does not interrupt local work before an enclosing cancellation transaction commits", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const journal = yield* Journal.Journal
      const owner = yield* driver("owner")
      const started = yield* Latch.make(false)
      let finalized = 0
      yield* owner.register(First, () =>
        Latch.open(started).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => {
            finalized++
          }))
        ))
      const work = yield* executeAndDrain(owner, First, { executionId: "live", payload: {}, discard: true })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Latch.await(started)
      const failed = yield* Effect.exit(journal.transact(Effect.gen(function*() {
        yield* owner.interrupt(First, "live")
        expect(finalized).toBe(0)
        return yield* Effect.fail("rollback")
      })))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(finalized).toBe(0)
      expect((yield* store.get("live")).cancelRequestedAtMs).toBeNull()
      yield* owner.interrupt(First, "live")
      yield* Fiber.await(work)
      expect(finalized).toBe(1)
      expect((yield* store.get("live")).status).toBe("cancelled")
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

  it.effect("cancels an unregistered handoff successor from the original execution ID", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const owner = yield* driver("owner")
      const observer = yield* driver("observer")
      yield* owner.register(First, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.handoff = new Flow.Handoff({ flow: Next._tag, payload: {} })
          return "handoff"
        }))
      yield* executeAndDrain(owner, First, { executionId: "root", payload: {}, discard: true })
      const next = yield* FlowEngine.Round.next(FlowEngine.Round.initial("root"), {
        flowName: First._tag,
        maxRounds: undefined
      })
      expect((yield* store.get("root")).status).toBe("completed")
      yield* observer.interrupt(First, "root")
      expect((yield* store.get(next.executionId)).cancelRequestedAtMs).not.toBeNull()
      let executions = 0
      yield* owner.register(Next, () =>
        Effect.sync(() => {
          executions++
          return "must not run"
        }))
      yield* executeAndDrain(owner, Next, {
        executionId: next.executionId,
        payload: {},
        discard: true,
        round: { ...next.round, previousExecutionId: "root" }
      })
      expect(executions).toBe(0)
      expect((yield* store.get(next.executionId)).status).toBe("cancelled")
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

  it.effect("cascades through earlier-round children and child handoffs, not fork ancestry", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const edges = yield* DurableEngineState.DurableEngineState
      const observer = yield* driver("observer")
      const owner = { hostId: "seed", pid: 1, nonce: "seed" }
      const createRound = (id: string, lineageId: string, ordinal: number, parentRunId?: string) =>
        store.create(id, state(), { lineageId, roundOrdinal: ordinal, ...(parentRunId ? { parentRunId } : {}) })
      const finish = (id: string) =>
        Effect.gen(function*() {
          yield* store.claimAndOwn(
            id,
            { status: "pending", owner: null, heartbeatAtMs: null },
            owner,
            yield* Clock.currentTimeMillis
          )
          yield* store.transitionOwned(id, owner, "completed", state())
        })
      yield* createRound("root", "root", 0)
      yield* createRound("middle", "root", 1, "root")
      yield* createRound("last", "root", 2, "middle")
      yield* finish("root")
      yield* finish("middle")
      yield* createRound("child", "child", 0)
      yield* createRound("child-next", "child", 1, "child")
      yield* finish("child")
      yield* store.create("grandchild", state())
      yield* store.create("fork", state(), { parentRunId: "root", lineageId: "fork", roundOrdinal: 0 })
      yield* edges.recordRunParent("child", "root")
      yield* edges.recordRunParent("grandchild", "child-next")
      yield* observer.interrupt(First, "middle")
      for (const id of ["last", "child-next", "grandchild"]) {
        expect((yield* store.get(id)).cancelRequestedAtMs, id).not.toBeNull()
      }
      expect((yield* store.get("fork")).cancelRequestedAtMs).toBeNull()
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))
})
