import { executeAndDrain } from "./ExecuteAndDrain.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Pins the crash-consistency invariant: every engine-store lifecycle journal
 * entry commits in the SAME write transaction as the executable state
 * transition it describes.
 *
 * Before this, the store wrote first and journalled second — the attempt row
 * then the attempt event, the run-row CAS then the decision — so a crash in
 * the interstitial left durable state the journal could not explain. Audit,
 * sync, and time travel read the journal as the account of record and saw a
 * hole in it.
 *
 * Each test injects a crash at one closed interstitial through the
 * `Journal.Notifying` fault harness (Skyframe's `NotifyingHelper`, adapted)
 * and asserts journal/state EQUIVALENCE after the restart: either both halves
 * of the pair are durable, or neither is. Prior art for the invariant is
 * Temporal, which submits mutable state and its event batches as one
 * persistence request
 * (`reference/temporal/service/history/workflow/transaction_impl.go`).
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { DurableClock, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, type JournalEvent, SqlJournal } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as Clocks from "./Clocks.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "wal-host", pid: 1, nonce: "wal-owner" }

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "wal-snapshot" as never, changeId: "wal-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/**
 * The whole durable stack over ONE database — journal, run/attempt/cache
 * stores, and the SQL engine state — because the invariant under test is that
 * their writes share a transaction. A memory twin anywhere would make the
 * rollback vacuous.
 */
const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase), Layer.merge(StepBoundary.layerTest()), Layer.merge(jj))

type Services = Layer.Success<typeof services> | TestClock.TestClock | Crypto.Crypto | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(Effect.scoped(effect).pipe(Effect.provide(services), Effect.provide(TestClock.layer())))

class CrashInjected extends Error {
  override readonly name = "CrashInjected"
}

/** Dies at the named service operation — the interstitial being closed. */
const crashAt = (
  op: string,
  order: Notifying.Order,
  when: (args: ReadonlyArray<unknown>) => boolean = () => true
): Notifying.Hook =>
(actualOp, actualOrder, args) =>
  actualOp === op && actualOrder === order && when(args)
    ? Effect.die(new CrashInjected(`crash injected ${order} ${op}`))
    : Effect.void

const isCrash = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CrashInjected

const eventsOf = (runId: string, eventType: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 200 })
    return page.entries.filter((entry) => entry.eventType === eventType)
  })

const activate = (runId: string, claimant: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    yield* takeover(runId, claimant)
  })

const takeover = (runId: string, claimant: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const stealing = row.status === "running" && row.owner !== null
    if (stealing) {
      yield* TestClock.adjust(Duration.millis(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1))
    }
    const now = yield* Clock.currentTimeMillis
    const evidence: Ownership.LivenessEvidence | undefined = stealing
      ? {
        expectedOwner: row.owner!,
        checkedAtMs: now,
        kind: row.owner!.hostId === claimant.hostId ? "same-host-pid-dead" : "cross-host-unreachable-stale"
      }
      : undefined
    // The store decides staleness from the clock IT reads, never from `now`,
    // so the steal is taken at the skewed moment rather than merely described
    // by it (`@smthrs/run-store` `claimAndOwn`).
    const outcome = yield* Clocks.at(now, runs.claimAndOwn(runId, snapshot, claimant, now, evidence))
    if (outcome._tag !== "Activated") {
      return yield* Effect.die(new Error(`run ${runId} takeover was lost: ${outcome._tag}`))
    }
  })

const dispatch = (options: {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly key: string
  readonly result: unknown
  readonly counter?: { count: number } | undefined
}) =>
  ActionPersistence.make({
    runId: options.runId,
    owner: options.owner,
    sourceId: `wal-${options.runId}`,
    execute: () =>
      Effect.sync(() => {
        if (options.counter !== undefined) options.counter.count++
        return options.result
      })
  })({ action: {}, attempt: 1, key: options.key, tier: "sealed", metadata: boundary })

describe("lifecycle history is atomic with executable state", () => {
  it.effect("a crash between the attempt admission and its started event leaves neither", () =>
    Effect.gen(function*() {
      const runId = "wal-admission"
      const key = "wal/admission"
      const result = yield* run(Effect.gen(function*() {
        yield* activate(runId, owner)
        const attempts = yield* AttemptStore.AttemptStore
        const counter = { count: 0 }
        const crashed = yield* dispatch({ runId, owner, key, result: "v1", counter }).pipe(
          Effect.provideService(
            AttemptStore.AttemptStore,
            Notifying.wrap(attempts, crashAt("put", "after"))
          ),
          Effect.exit
        )
        const rowAfterCrash = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
        const startedAfterCrash = yield* eventsOf(runId, "flows.engine.attempt-started")

        const recovered = yield* dispatch({ runId, owner, key, result: "v1", counter })
        return {
          crashed,
          rowAfterCrash,
          startedAfterCrash,
          recovered,
          row: yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 }),
          started: yield* eventsOf(runId, "flows.engine.attempt-started"),
          dispatches: counter.count
        }
      }))

      expect(isCrash(result.crashed)).toBe(true)
      // Equivalence: the admitted row and its announcement roll back together.
      expect(Option.isNone(result.rowAfterCrash)).toBe(true)
      expect(result.startedAfterCrash).toHaveLength(0)
      expect(result.recovered).toBe("v1")
      expect(Option.getOrThrow(result.row).state).toBe("succeeded")
      expect(result.started).toHaveLength(1)
      expect(result.dispatches).toBe(1)
    }))

  it.effect("a crash between the terminal attempt write and its finished event leaves neither", () =>
    Effect.gen(function*() {
      const runId = "wal-terminal-attempt"
      const key = "wal/terminal-attempt"
      const succeeded = (args: ReadonlyArray<unknown>): boolean =>
        (args[0] as { readonly state: string }).state === "succeeded"
      const result = yield* run(Effect.gen(function*() {
        yield* activate(runId, owner)
        const attempts = yield* AttemptStore.AttemptStore
        const counter = { count: 0 }
        const crashed = yield* dispatch({ runId, owner, key, result: "v1", counter }).pipe(
          Effect.provideService(
            AttemptStore.AttemptStore,
            Notifying.wrap(attempts, crashAt("finish", "after", succeeded))
          ),
          Effect.exit
        )
        const rowAfterCrash = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
        const finishedAfterCrash = yield* eventsOf(runId, "flows.engine.attempt-finished")

        // Restart: a new incarnation steals the run, adopts the still-running
        // row, and re-executes it under its original attempt number.
        const restarted: Ownership.OwnerId = { ...owner, nonce: "wal-owner-restarted" }
        yield* takeover(runId, restarted)
        const recovered = yield* dispatch({ runId, owner: restarted, key, result: "v1", counter })
        return {
          crashed,
          rowAfterCrash,
          finishedAfterCrash,
          recovered,
          row: yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 }),
          finished: yield* eventsOf(runId, "flows.engine.attempt-finished"),
          dispatches: counter.count
        }
      }))

      expect(isCrash(result.crashed)).toBe(true)
      // The completion is not durable, so the journal must not claim it is.
      expect(Option.getOrThrow(result.rowAfterCrash).state).toBe("running")
      expect(result.finishedAfterCrash).toHaveLength(0)
      expect(result.recovered).toBe("v1")
      expect(Option.getOrThrow(result.row).state).toBe("succeeded")
      expect(result.finished).toHaveLength(1)
      expect(result.dispatches).toBe(2)
    }))

  it.effect("a crash between the cache provenance append and the cache row leaves neither", () =>
    Effect.gen(function*() {
      const runId = "wal-cache"
      const key = "wal/cache"
      const result = yield* run(Effect.gen(function*() {
        yield* activate(runId, owner)
        const attempts = yield* AttemptStore.AttemptStore
        const cache = yield* CacheStore.CacheStore
        const counter = { count: 0 }
        const crashed = yield* dispatch({ runId, owner, key, result: "v1", counter }).pipe(
          Effect.provideService(CacheStore.CacheStore, Notifying.wrap(cache, crashAt("put", "after"))),
          Effect.exit
        )
        const cachedAfterCrash = yield* cache.get(sha256(key))
        const provenanceAfterCrash = yield* eventsOf(runId, "flows.engine.cache-provenance")
        const rowAfterCrash = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })

        // The attempt itself committed, so the re-drive replays it and
        // converges the cache — without re-executing the body.
        const recovered = yield* dispatch({ runId, owner, key, result: "v2", counter })
        return {
          crashed,
          cachedAfterCrash,
          provenanceAfterCrash,
          rowAfterCrash,
          recovered,
          cached: yield* cache.get(sha256(key)),
          provenance: yield* eventsOf(runId, "flows.engine.cache-provenance"),
          dispatches: counter.count
        }
      }))

      expect(isCrash(result.crashed)).toBe(true)
      expect(Option.isNone(result.cachedAfterCrash)).toBe(true)
      expect(result.provenanceAfterCrash).toHaveLength(0)
      expect(Option.getOrThrow(result.rowAfterCrash).state).toBe("succeeded")
      expect(result.recovered).toBe("v1")
      expect(result.dispatches).toBe(1)
      // Exactly one recorded row and exactly one provenance entry for it.
      expect(Option.getOrThrow(result.cached).result).toBe("v1")
      expect(result.provenance).toHaveLength(1)
      expect(Option.getOrThrow(result.cached).recordedEventSeq).toBe(result.provenance[0]!.seq)
    }))
})

const DriverFlow = Flow.make("WalAtomicity/Driver", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: "wal-driver-host", pid: 2, nonce },
    journalSource: "wal-driver",
    isAlive: () => Effect.succeed(false),
    engine: Effect.succeed(fakeEngine)
  })

describe("run lifecycle history is atomic with the run row", () => {
  it.effect("a crash between the terminal run transition and its decision leaves neither", () =>
    Effect.gen(function*() {
      const executionId = "wal-run-terminal"
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const terminal = (args: ReadonlyArray<unknown>): boolean => args[2] === "completed"
        const crashingScope = yield* Scope.make()
        const crashingDriver = yield* makeDriver("crasher").pipe(
          Scope.provide(crashingScope),
          Effect.provideService(
            RunStore.RunStore,
            Notifying.wrap(store, crashAt("transitionOwned", "after", terminal))
          )
        )
        yield* crashingDriver.register(DriverFlow, () => Effect.succeed("done"))
        const crashed = yield* crashingDriver.execute(DriverFlow, {
          executionId,
          payload: {},
          discard: false
        }).pipe(Effect.forkChild({ startImmediately: true }), Effect.flatMap(Fiber.await))
        const rowAfterCrash = yield* store.get(executionId)
        const decisionsAfterCrash = yield* eventsOf(executionId, "flows.engine.run-decision")

        yield* Scope.close(crashingScope, Exit.void)
        // A restarted worker steals the stale-running row and finalizes it.
        const driver = yield* makeDriver("healthy")
        yield* driver.register(DriverFlow, () => Effect.succeed("done"))
        yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
        yield* executeAndDrain(driver, DriverFlow, { executionId, payload: {}, discard: true })
        yield* TestDatabase.until(store.get(executionId).pipe(Effect.map((row) => row.status === "completed")))
        const decisions = yield* eventsOf(executionId, "flows.engine.run-decision")
        return {
          crashed,
          rowAfterCrash,
          transitionedAfterCrash: decisionsAfterCrash.filter((entry) =>
            (entry.payload as { decision?: string }).decision === "transitioned"
          ),
          row: yield* store.get(executionId),
          transitioned: decisions.filter((entry) =>
            (entry.payload as { decision?: string }).decision === "transitioned"
          )
        }
      }))

      expect(Exit.isFailure(result.crashed)).toBe(true)
      // The run is not durably terminal, so no `transitioned` decision may exist.
      expect(result.rowAfterCrash.status).toBe("running")
      expect(result.transitionedAfterCrash).toHaveLength(0)
      expect(result.row.status).toBe("completed")
      expect(result.transitioned).toHaveLength(1)
    }))
})

describe("durable primitive history is atomic with its state row", () => {
  const address = {
    flowName: DriverFlow._tag,
    executionId: "wal-deferred",
    deferredName: "answer"
  }

  const persistence = (resumes: Array<string>) =>
    DeferredPersistence.make({
      owner,
      journalSource: "wal-deferred-source",
      scheduleResume: (_flowName, executionId, reason) =>
        Effect.sync(() => {
          resumes.push(`${executionId}:${reason}`)
        })
    })

  it.effect("a crash between the deferred completion row and its event leaves neither", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const runs = yield* RunStore.RunStore
        yield* runs.create(address.executionId, "{}")
        const resumes: Array<string> = []
        const crashing = yield* persistence(resumes).pipe(
          Effect.provideService(
            DurableEngineState.DurableEngineState,
            Notifying.wrap(state, crashAt("completeDeferred", "after"))
          )
        )
        const crashed = yield* crashing.deferredDone({ ...address, exit: Exit.succeed("first") }).pipe(Effect.exit)
        const rowAfterCrash = yield* state.deferred(address)
        const eventsAfterCrash = yield* eventsOf(address.executionId, "flows.engine.deferred-completed")

        const healthy = yield* persistence(resumes)
        yield* healthy.deferredDone({ ...address, exit: Exit.succeed("second") })
        return {
          crashed,
          rowAfterCrash,
          eventsAfterCrash,
          row: yield* state.deferred(address),
          events: yield* eventsOf(address.executionId, "flows.engine.deferred-completed"),
          resumes
        }
      }))

      expect(isCrash(result.crashed)).toBe(true)
      expect(Option.isNone(result.rowAfterCrash)).toBe(true)
      expect(result.eventsAfterCrash).toHaveLength(0)
      // The rolled-back completion never happened, so the retry is the first
      // writer and its value is the durable one.
      expect(Option.getOrThrow(result.row).exit).toMatchObject({ _tag: "Success", value: "second" })
      expect(result.events).toHaveLength(1)
      expect(result.resumes).toEqual([`${address.executionId}:deferred`])
    }))

  it.effect("a crash between the clock row and its scheduled event leaves neither", () =>
    Effect.gen(function*() {
      const executionId = "wal-clock"
      const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })
      const result = yield* run(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        // `scheduleClock` is owner-fenced, so the run must be activated here.
        yield* activate(executionId, owner)
        const resumes: Array<string> = []
        const crashing = yield* persistence(resumes).pipe(
          Effect.provideService(
            DurableEngineState.DurableEngineState,
            Notifying.wrap(state, crashAt("scheduleClock", "after"))
          )
        )
        const crashed = yield* crashing.scheduleClock(DriverFlow, { executionId, clock }).pipe(Effect.exit)
        const rowsAfterCrash = yield* state.pendingClocks({ executionId })
        const eventsAfterCrash = yield* eventsOf(executionId, "flows.engine.clock-scheduled")

        const healthy = yield* persistence(resumes)
        yield* healthy.scheduleClock(DriverFlow, { executionId, clock })
        return {
          crashed,
          rowsAfterCrash,
          eventsAfterCrash,
          rows: yield* state.pendingClocks({ executionId }),
          events: yield* eventsOf(executionId, "flows.engine.clock-scheduled")
        }
      }))

      expect(isCrash(result.crashed)).toBe(true)
      expect(result.rowsAfterCrash).toHaveLength(0)
      expect(result.eventsAfterCrash).toHaveLength(0)
      expect(result.rows).toHaveLength(1)
      expect(result.events).toHaveLength(1)
    }))
})
