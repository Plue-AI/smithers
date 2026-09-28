import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("Ownership/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const ownerA: Ownership.OwnerId = {
  hostId: "host-a",
  pid: 1,
  nonce: "owner-a"
}

const ownerB: Ownership.OwnerId = {
  hostId: "host-b",
  pid: 2,
  nonce: "owner-b"
}

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const persistedState = JSON.stringify({
  version: 1,
  flowName: TestFlow._tag,
  payload: {}
})

const makeDriver = (
  owner: Ownership.OwnerId,
  isAlive: (owner: Ownership.OwnerId) => Effect.Effect<boolean> = () => Effect.succeed(true)
) =>
  RunDriver.make({
    owner,
    journalSource: `ownership-${owner.nonce}`,
    isAlive,
    engine: Effect.succeed(fakeEngine)
  })

const activate = (
  store: RunStore.Service,
  runId: string,
  owner: Ownership.OwnerId
) =>
  Effect.gen(function*() {
    yield* store.create(runId, persistedState)
    const row = yield* store.get(runId)
    const expected = {
      status: row.status,
      owner: row.owner,
      heartbeatAtMs: row.heartbeatAtMs
    }
    const claim = yield* store.claim(runId, expected, owner, 0)
    expect(claim).toEqual({
      _tag: "Claimed",
      claimedAtMs: 0
    })
    if (claim._tag !== "Claimed") return
    expect(yield* store.activate(runId, owner, claim.claimedAtMs, expected)).toEqual({
      _tag: "Activated"
    })
  })

const provideJournal = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(TestStores.layer()),
    Effect.provide(DurableEngineState.layerMemory),
    Effect.provide(TestClock.layer())
  )

describe("RunDriver ownership", () => {
  it.effect("refuses a workspace-routed run before taking any ownership", () =>
    Effect.gen(function*() {
      let executions = 0
      let admissions = 0
      const row = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* store.create("foreign-workspace", persistedState)
        const driver = yield* RunDriver.make({
          owner: ownerA,
          journalSource: "workspace-routing",
          engine: Effect.succeed(fakeEngine),
          canExecute: (candidate) =>
            Effect.sync(() => {
              admissions++
              expect(candidate.runId).toBe("foreign-workspace")
              return false
            })
        })
        yield* driver.register(TestFlow, () =>
          Effect.sync(() => {
            executions++
            return "wrong workspace"
          }))
        yield* driver.resume(TestFlow, "foreign-workspace")
        return yield* store.get("foreign-workspace")
      })))
      expect(admissions).toBeGreaterThan(0)
      expect(executions).toBe(0)
      expect(row.status).toBe("pending")
      expect(row.owner).toBeNull()
      expect(row.claim).toBeNull()
    }))

  it.effect("allows one concurrent claimant to drive an execution", () =>
    Effect.gen(function*() {
      let executions = 0
      const row = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const first = yield* makeDriver(ownerA)
        const second = yield* makeDriver(ownerB)
        const handler = () =>
          Effect.sync(() => {
            executions++
            return "done"
          })
        yield* first.register(TestFlow, handler)
        yield* second.register(TestFlow, handler)

        yield* Effect.all([
          first.execute(TestFlow, {
            executionId: "concurrent",
            payload: {},
            discard: true
          }),
          second.execute(TestFlow, {
            executionId: "concurrent",
            payload: {},
            discard: true
          })
        ], { concurrency: "unbounded" })
        return yield* (yield* RunStore.RunStore).get("concurrent")
      })))

      expect(executions).toBe(1)
      expect(row.status).toBe("completed")
    }))

  it.effect("refuses to steal from a fresh owner without probing liveness", () =>
    Effect.gen(function*() {
      let probes = 0
      const row = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* activate(store, "fresh", ownerA)
        const driver = yield* makeDriver(ownerB, () =>
          Effect.sync(() => {
            probes++
            return false
          }))
        yield* driver.register(TestFlow, () => Effect.succeed("wrong"))
        yield* driver.resume(TestFlow, "fresh")
        return yield* store.get("fresh")
      })))

      expect(probes).toBe(0)
      expect(row.status).toBe("running")
      expect(row.owner).toEqual(ownerA)
    }))

  it.effect("steals a stale owner only after the liveness probe supplies evidence", () =>
    Effect.gen(function*() {
      let probes = 0
      const row = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* activate(store, "stale", ownerA)
        yield* TestClock.adjust("31 seconds")

        const driver = yield* makeDriver(ownerB, (owner) =>
          Effect.sync(() => {
            probes++
            expect(owner).toEqual(ownerA)
            return false
          }))
        yield* driver.register(TestFlow, () => Effect.succeed("recovered"))
        yield* driver.resume(TestFlow, "stale")
        return yield* store.get("stale")
      })))

      expect(probes).toBe(1)
      expect(row.status).toBe("completed")
      expect(row.owner).toBeNull()
      expect(row.heartbeatAtMs).toBeNull()
    }))

  it.effect("abandons an activation race without starting a handler", () =>
    Effect.gen(function*() {
      let executions = 0
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        yield* activate(base, "activation-race", ownerA)
        yield* TestClock.adjust("31 seconds")

        let abandoned = 0
        const racing = RunStore.makeNoop({
          ...base,
          activate: (runId, claimant, claimedAtMs, expected) =>
            base.heartbeat(runId, ownerA, 31_000).pipe(
              Effect.andThen(
                base.activate(runId, claimant, claimedAtMs, expected)
              )
            ),
          abandonClaim: (runId, claimant, claimedAtMs) =>
            base.abandonClaim(runId, claimant, claimedAtMs).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  abandoned++
                })
              )
            )
        })
        const driver = yield* makeDriver(ownerB, () => Effect.succeed(false)).pipe(
          Effect.provideService(RunStore.RunStore, racing)
        )
        yield* driver.register(TestFlow, () =>
          Effect.sync(() => {
            executions++
            return "wrong"
          }))
        yield* driver.resume(TestFlow, "activation-race")
        return {
          abandoned,
          row: yield* base.get("activation-race")
        }
      })))

      expect(executions).toBe(0)
      expect(result.abandoned).toBe(1)
      expect(result.row.owner).toEqual(ownerA)
      expect(result.row.claim).toBeNull()
    }))

  it.effect("suspension atomically clears owner and heartbeat", () =>
    Effect.gen(function*() {
      const row = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver(ownerA)
        yield* driver.register(TestFlow, () =>
          Effect.flatMap(
            FlowRuntime.FlowInstance,
            Flow.suspend
          ))
        yield* driver.execute(TestFlow, {
          executionId: "suspended",
          payload: {},
          discard: true
        })
        return yield* (yield* RunStore.RunStore).get("suspended")
      })))

      expect(row.status).toBe("suspended")
      expect(row.owner).toBeNull()
      expect(row.heartbeatAtMs).toBeNull()
    }))

  it.effect("interrupts the driver when its heartbeat fence is lost", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver(ownerA)
        const started = yield* Deferred.make<void>()
        let interrupted = false
        yield* driver.register(TestFlow, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                interrupted = true
              })
            )
          ))

        const fiber = yield* driver.execute(TestFlow, {
          executionId: "fence-loss",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        expect(
          yield* store.transitionOwned("fence-loss", ownerA, "suspended")
        ).toEqual({ _tag: "Transitioned" })
        yield* TestClock.adjust(Ownership.heartbeatInterval)
        yield* Effect.yieldNow
        const exit = yield* Fiber.await(fiber)
        return {
          interrupted,
          exit,
          row: yield* store.get("fence-loss")
        }
      })))

      expect(result.interrupted).toBe(true)
      expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
      expect(result.row.status).toBe("suspended")
      expect(result.row.owner).toBeNull()
    }))
})
