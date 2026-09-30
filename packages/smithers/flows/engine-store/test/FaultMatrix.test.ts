import { describe, expect, it } from "@effect/vitest"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as EffectRecords from "../src/internal/EffectRecords.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as Clocks from "./Clocks.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const ownerA: Ownership.OwnerId = { hostId: "fault-host-a", pid: 1, nonce: "fault-owner-a" }
const ownerB: Ownership.OwnerId = { hostId: "fault-host-b", pid: 2, nonce: "fault-owner-b" }

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "fault-snapshot" as never, changeId: "fault-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const layer = Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | AttemptStore.AttemptStore
    | CacheStore.CacheStore
    | Journal.Journal
    | RunStore.RunStore
    | StepBoundary.Service
    | Jj.Jj
    | Scope.Scope
    | Crypto.Crypto
  >
) =>
  withCrypto(
    effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped)
  )

/** Activates a fresh run under `owner`, mirroring the RunDriver claim path. */
const activate = (runId: string, owner: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    yield* takeover(runs, runId, owner)
  })

/** Claims and activates `runId` for `claimant` from whatever state it is in. */
const takeover = (runs: RunStore.Service, runId: string, claimant: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const stealing = row.status === "running" && row.owner !== null
    // Move the injected clock past the stale window so the store observes the
    // same time as the takeover evidence.
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

interface Executor {
  readonly dispatches: () => number
  readonly execute: (attempt: number) => Effect.Effect<
    unknown,
    unknown,
    | AttemptStore.AttemptStore
    | CacheStore.CacheStore
    | Journal.Journal
    | RunStore.RunStore
    | StepBoundary.Service
    | Jj.Jj
    | Crypto.Crypto
  >
}

const makeExecutor = (options: {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly key: string
  readonly result: unknown
  readonly body?: Effect.Effect<void>
  /** Defaults to the sealed tier the interstitial cases were written against. */
  readonly tier?: ActionPersistence.ActionInput["tier"]
  readonly idempotencyKey?: string
}): Executor => {
  let dispatches = 0
  const executor = ActionPersistence.make({
    runId: options.runId,
    owner: options.owner,
    sourceId: `fault-matrix-${options.owner.nonce}`,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    execute: () =>
      Effect.suspend(() => {
        dispatches++
        return (options.body ?? Effect.void).pipe(Effect.as(options.result))
      })
  })
  const tier = options.tier ?? "sealed"
  return {
    dispatches: () => dispatches,
    execute: (attempt) =>
      executor({
        action: {},
        attempt,
        key: options.key,
        tier,
        // A boundary descriptor is sealed-only machinery: declaring one for an
        // irreversible dispatch would route it through the isolated-execution
        // lane these cases are not about.
        ...(tier === "sealed" ? { metadata: boundary } : {})
      })
  }
}

class CrashInjected extends Error {
  override readonly name = "CrashInjected"
}

const crashAt = (
  op: string,
  order: Notifying.Order,
  when: (args: ReadonlyArray<unknown>) => boolean = () => true
): Notifying.Hook =>
(actualOp, actualOrder, args) =>
  actualOp === op && actualOrder === order && when(args)
    ? Effect.die(new CrashInjected(`crash injected ${order} ${op}`))
    : Effect.void

/**
 * Runs the fenced executor on a child fiber so a store-level fence loss —
 * surfaced by the executor as self-interruption — is observable as an Exit
 * instead of taking the test fiber down with it.
 */
const awaitExit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Exit.Exit<A, E>, never, R> =>
  effect.pipe(Effect.forkChild({ startImmediately: true }), Effect.flatMap(Fiber.await))

const isCrash = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CrashInjected

const succeededFinish = (args: ReadonlyArray<unknown>): boolean =>
  (args[0] as { readonly state: string }).state === "succeeded"

const eventTypeIs = (eventType: string) => (args: ReadonlyArray<unknown>): boolean =>
  (args[0] as JournalEvent.Input).eventType === eventType

describe("FaultMatrix", () => {
  describe("interstitial crashes", () => {
    it.effect("crash between attempts.finish and cache.put: restart replays the sealed completion without re-executing", () =>
      Effect.gen(function*() {
        const key = "fault/finish-then-cache"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("crash-after-finish", ownerA)
          const attempts = yield* AttemptStore.AttemptStore
          const cache = yield* CacheStore.CacheStore
          const first = makeExecutor({ runId: "crash-after-finish", owner: ownerA, key, result: "v1" })
          // The crash lands after the attempt's terminal transaction committed
          // and before the cache row is written. Injecting it *inside* that
          // transaction instead — between `attempts.finish` and its lifecycle
          // append — is the WalAtomicity matrix's job: both halves roll back,
          // so there is no durable completion left to replay.
          const crashed = yield* first.execute(1).pipe(
            Effect.provideService(CacheStore.CacheStore, Notifying.wrap(cache, crashAt("put", "before"))),
            Effect.exit
          )

          // Fresh engine instance over the same store: the restarted owner
          // replays the durable completion instead of dispatching again.
          const second = makeExecutor({ runId: "crash-after-finish", owner: ownerA, key, result: "v1-again" })
          const recovered = yield* second.execute(1)
          const row = yield* attempts.get({
            runId: "crash-after-finish",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const cached = yield* cache.get(sha256(key))
          const journal = yield* Journal.Journal
          yield* journal.flush
          const entries = yield* journal.entries({ runId: "crash-after-finish" as never, limit: 50 })
          return {
            crashed,
            recovered,
            firstDispatches: first.dispatches(),
            secondDispatches: second.dispatches(),
            row,
            cached,
            eventTypes: entries.entries.map((entry) => entry.eventType)
          }
        }))

        expect(isCrash(result.crashed)).toBe(true)
        expect(result.firstDispatches).toBe(1)
        expect(result.secondDispatches).toBe(0)
        expect(result.recovered).toBe("v1")
        expect(Option.getOrThrow(result.row).state).toBe("succeeded")
        // The restarted replay converges the cache with the sealed completion:
        // exactly one provenance-recorded cache row, under this run's id, its
        // `recorded` and `admitted` entries, and no conflict was ever journaled.
        const cached = Option.getOrThrow(result.cached)
        expect(cached.result).toBe("v1")
        expect(cached.recordedRunId).toBe("crash-after-finish")
        expect(Number.isSafeInteger(cached.recordedEventSeq)).toBe(true)
        expect(
          result.eventTypes.filter((eventType) => eventType === "flows.engine.cache-provenance")
        ).toHaveLength(2)
        expect(result.eventTypes).not.toContain("flows.engine.cache-conflict")
      }))

    it.effect("crash between boundary.settle and attempts.finish: the in-flight attempt is adopted and completes exactly once", () =>
      Effect.gen(function*() {
        const key = "fault/settle-then-finish"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("crash-before-finish", ownerA)
          const attempts = yield* AttemptStore.AttemptStore
          const first = makeExecutor({ runId: "crash-before-finish", owner: ownerA, key, result: "v2" })
          const crashed = yield* first.execute(1).pipe(
            Effect.provideService(
              AttemptStore.AttemptStore,
              Notifying.wrap(attempts, crashAt("finish", "before", succeededFinish))
            ),
            Effect.exit
          )

          // Restarted engine: attempt 1 is durably mid-flight — crash evidence,
          // not a live admission (issue #71). The restarted process is a new
          // incarnation (fresh ownership nonce, issue #86) that re-claims the
          // run; the re-drive adopts the row and re-executes under the original
          // attempt number instead of refusing admission, so a no-policy run
          // recovers instead of failing with an infrastructure tag.
          const runs = yield* RunStore.RunStore
          const ownerARestarted: Ownership.OwnerId = { ...ownerA, nonce: "fault-owner-a-restarted" }
          yield* takeover(runs, "crash-before-finish", ownerARestarted)
          const second = makeExecutor({ runId: "crash-before-finish", owner: ownerARestarted, key, result: "v2" })
          const readmitted = yield* second.execute(1)
          const digest = sha256(key)
          const rowOne = yield* attempts.get({ runId: "crash-before-finish", stepKeyDigest: digest, attempt: 1 })
          return { crashed, readmitted, rowOne, dispatches: first.dispatches() + second.dispatches() }
        }))

        expect(isCrash(result.crashed)).toBe(true)
        expect(result.readmitted).toBe("v2")
        // Exactly one durable completion, under the original attempt number.
        expect(Option.getOrThrow(result.rowOne).state).toBe("succeeded")
        expect(result.dispatches).toBe(2)
      }))

    it.effect(
      "crash between the succeeded effect boundary and attempts.finish: the irreversible body crosses exactly once",
      () =>
        Effect.gen(function*() {
          const key = "fault/crossing-then-finish"
          const result = yield* run(Effect.gen(function*() {
            yield* activate("crash-after-crossing", ownerA)
            const attempts = yield* AttemptStore.AttemptStore
            const first = makeExecutor({
              runId: "crash-after-crossing",
              owner: ownerA,
              key,
              result: "receipt-1",
              tier: "irreversible"
            })
            // The charge left the machine and its terminal boundary is durable;
            // the process dies before the attempt row settles. The row stays
            // `running`, which is the same shape a SIGKILL mid-body leaves —
            // and the difference between the two is exactly what the recorded
            // crossing has to answer.
            const crashed = yield* first.execute(1).pipe(
              Effect.provideService(
                AttemptStore.AttemptStore,
                Notifying.wrap(attempts, crashAt("finish", "before", succeededFinish))
              ),
              Effect.exit
            )

            const runs = yield* RunStore.RunStore
            const restarted: Ownership.OwnerId = { ...ownerA, nonce: "fault-owner-a-crossed" }
            yield* takeover(runs, "crash-after-crossing", restarted)
            const second = makeExecutor({
              runId: "crash-after-crossing",
              owner: restarted,
              key,
              // A different value: reaching it at all would prove the body ran
              // a second time.
              result: "receipt-2",
              tier: "irreversible"
            })
            const recovered = yield* second.execute(1)
            const row = yield* attempts.get({
              runId: "crash-after-crossing",
              stepKeyDigest: sha256(key),
              attempt: 1
            })
            const journal = yield* Journal.Journal
            yield* journal.flush
            const entries = yield* journal.entries({ runId: "crash-after-crossing" as never, limit: 50 })
            return {
              crashed,
              recovered,
              firstDispatches: first.dispatches(),
              secondDispatches: second.dispatches(),
              row,
              boundaries: entries.entries
                .filter((entry) => entry.eventType === EffectRecords.eventType)
                .map((entry) => (entry.payload as { readonly effect: { readonly status: string } }).effect.status),
              finished: entries.entries.filter((entry) => entry.eventType === "flows.engine.attempt-finished")
            }
          }))

          expect(isCrash(result.crashed)).toBe(true)
          expect(result.firstDispatches).toBe(1)
          // The whole point: the recorded crossing settles the adopted row, so
          // the charge is never sent a second time.
          expect(result.secondDispatches).toBe(0)
          expect(result.recovered).toBe("receipt-1")
          expect(Option.getOrThrow(result.row).state).toBe("succeeded")
          expect(Option.getOrThrow(result.row).outcome).toBe("receipt-1")
          // One crossing in the journal, and the terminal attempt record the
          // dead incarnation never got to write.
          expect(result.boundaries).toEqual(["intended", "succeeded"])
          expect(result.finished).toHaveLength(1)
        })
    )

    it.effect("crash between journal.emit and cache.put: completion survives, no divergent cache row is recorded", () =>
      Effect.gen(function*() {
        const key = "fault/emit-then-cache"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("crash-after-emit", ownerA)
          const journal = yield* Journal.Journal
          const first = makeExecutor({ runId: "crash-after-emit", owner: ownerA, key, result: "v3" })
          const crashed = yield* first.execute(1).pipe(
            Effect.provideService(
              Journal.Journal,
              Notifying.wrap(journal, crashAt("emitDurable", "after", eventTypeIs("flows.engine.cache-provenance")))
            ),
            Effect.exit
          )

          const second = makeExecutor({ runId: "crash-after-emit", owner: ownerA, key, result: "v3-again" })
          const recovered = yield* second.execute(1)
          const cache = yield* CacheStore.CacheStore
          const cached = yield* cache.get(sha256(key))
          yield* journal.flush
          const entries = yield* journal.entries({ runId: "crash-after-emit" as never, limit: 50 })
          return {
            crashed,
            recovered,
            cached,
            dispatches: first.dispatches() + second.dispatches(),
            eventTypes: entries.entries.map((entry) => entry.eventType)
          }
        }))

        expect(isCrash(result.crashed)).toBe(true)
        expect(result.recovered).toBe("v3")
        expect(result.dispatches).toBe(1)
        expect(result.eventTypes).toContain("flows.engine.attempt-finished")
        // The restarted replay converges the cache with the sealed completion
        // and never journals a conflict for its own recovery write.
        const cached = Option.getOrThrow(result.cached)
        expect(cached.result).toBe("v3")
        expect(cached.recordedRunId).toBe("crash-after-emit")
        expect(Number.isSafeInteger(cached.recordedEventSeq)).toBe(true)
        expect(result.eventTypes).not.toContain("flows.engine.cache-conflict")
      }))
  })

  /**
   * An irreversible crossing is recorded in the attempt row, in the same
   * transaction as the boundary record, because the row is the only copy
   * recovery may re-enter: the journal redacts payloads on write, so its
   * recorded output is observability rather than executable state.
   */
  describe("recorded effect crossings", () => {
    /** Kills the process after the body ran and before the attempt settles. */
    const killedMidCharge = (options: {
      readonly runId: string
      readonly key: string
      readonly idempotencyKey?: string
    }) =>
      Effect.gen(function*() {
        yield* activate(options.runId, ownerA)
        const attempts = yield* AttemptStore.AttemptStore
        const charging = makeExecutor({
          runId: options.runId,
          owner: ownerA,
          key: options.key,
          result: "unreachable",
          tier: "irreversible",
          // The body never returns an answer, so nothing terminal is recorded:
          // the crossing stays `intended` and no durable evidence can say
          // whether the charge reached the provider.
          body: Effect.die(new Error("the process died mid-charge")),
          ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey })
        })
        const crashed = yield* charging.execute(1).pipe(
          Effect.provideService(
            AttemptStore.AttemptStore,
            Notifying.wrap(attempts, crashAt("finish", "before"))
          ),
          Effect.exit
        )
        const runs = yield* RunStore.RunStore
        const restarted: Ownership.OwnerId = { ...ownerA, nonce: `${options.runId}-restarted` }
        yield* takeover(runs, options.runId, restarted)
        return { crashed, charging, attempts, restarted }
      })

    it.effect("an unresolved crossing with no idempotency key refuses rather than charging a second time", () =>
      Effect.gen(function*() {
        const key = "fault/crossing-unresolved"
        const result = yield* run(Effect.gen(function*() {
          const { attempts, charging, crashed, restarted } = yield* killedMidCharge({
            runId: "crossing-unresolved",
            key
          })
          const resumed = makeExecutor({
            runId: "crossing-unresolved",
            owner: restarted,
            key,
            result: "charged-again",
            tier: "irreversible"
          })
          const refused = yield* resumed.execute(1).pipe(Effect.result)
          const row = yield* attempts.get({
            runId: "crossing-unresolved",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          return { crashed, refused, row, dispatches: charging.dispatches() + resumed.dispatches() }
        }))

        expect(isCrash(result.crashed)).toBe(true)
        // One dispatch, from the incarnation that died. The resumed drive
        // surfaces the ambiguity instead of resolving it by charging.
        expect(result.dispatches).toBe(1)
        expect(result.refused).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey",
            actionName: "flows/engine-store/action",
            attempt: 1
          }
        })
        const row = Option.getOrThrow(result.row)
        expect(row.state).toBe("running")
        expect((row.meta as { readonly effectCrossing?: string }).effectCrossing).toBe("intended")
      }))

    it.effect("an unresolved crossing re-executes when an idempotency key makes the repeat safe", () =>
      Effect.gen(function*() {
        const key = "fault/crossing-keyed"
        const result = yield* run(Effect.gen(function*() {
          const { attempts, charging, restarted } = yield* killedMidCharge({
            runId: "crossing-keyed",
            key,
            idempotencyKey: "charge-request-1"
          })
          const resumed = makeExecutor({
            runId: "crossing-keyed",
            owner: restarted,
            key,
            result: "charged-once",
            tier: "irreversible",
            idempotencyKey: "charge-request-1"
          })
          const recovered = yield* resumed.execute(1)
          const row = yield* attempts.get({ runId: "crossing-keyed", stepKeyDigest: sha256(key), attempt: 1 })
          return { recovered, row, dispatches: charging.dispatches() + resumed.dispatches() }
        }))

        expect(result.recovered).toBe("charged-once")
        // The provider deduplicates the repeat, which is exactly what the key
        // is for, so the resumed drive re-enters the body.
        expect(result.dispatches).toBe(2)
        expect(Option.getOrThrow(result.row).state).toBe("succeeded")
      }))

    it.effect("a crossing that cannot be recorded interrupts before the body runs", () =>
      Effect.gen(function*() {
        const key = "fault/crossing-unrecordable"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("crossing-unrecordable", ownerA)
          const attempts = yield* AttemptStore.AttemptStore
          const executor = makeExecutor({
            runId: "crossing-unrecordable",
            owner: ownerA,
            key,
            result: "must-not-charge",
            tier: "irreversible"
          })
          // The row moved under this dispatch between admission and the
          // crossing. Dispatching anyway would send an effect whose evidence
          // has nowhere to land.
          const exit = yield* awaitExit(
            executor.execute(1).pipe(
              Effect.provideService(AttemptStore.AttemptStore, {
                ...attempts,
                patch: () => Effect.succeed({ _tag: "NotFound" } as const)
              })
            )
          )
          return { exit, dispatches: executor.dispatches() }
        }))

        expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
        expect(result.dispatches).toBe(0)
      }))

    it.effect("a recorded crossing whose settlement loses the fence self-interrupts, never re-dispatching", () =>
      Effect.gen(function*() {
        const key = "fault/crossing-fence-lost"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("crossing-fence", ownerA)
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          // The durable state a SIGKILL between the crossing and the
          // settlement leaves behind.
          yield* attempts.put({
            runId: "crossing-fence",
            stepKeyDigest: sha256(key),
            attempt: 1,
            state: "running",
            startedAtMs: 0,
            outcome: "receipt",
            meta: { tier: "irreversible", admittedBy: ownerA, effectCrossing: "succeeded" }
          }, ownerA)
          const steal: Notifying.Hook = (op, order) =>
            op === "finish" && order === "before"
              ? takeover(runs, "crossing-fence", ownerB).pipe(Effect.orDie)
              : Effect.void

          const executor = makeExecutor({
            runId: "crossing-fence",
            owner: ownerA,
            key,
            result: "must-not-charge",
            tier: "irreversible"
          })
          const exit = yield* awaitExit(
            executor.execute(1).pipe(
              Effect.provideService(AttemptStore.AttemptStore, Notifying.wrap(attempts, steal))
            )
          )
          const row = yield* attempts.get({ runId: "crossing-fence", stepKeyDigest: sha256(key), attempt: 1 })
          return { exit, row, dispatches: executor.dispatches() }
        }))

        expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
        // The crossing survives for the new owner to settle from; losing the
        // fence never turns into a second charge.
        expect(result.dispatches).toBe(0)
        expect(Option.getOrThrow(result.row).state).toBe("running")
      }))
  })

  describe("fence losses", () => {
    it.effect("fence lost at heartbeat: the fenced owner starts nothing and the new owner completes the run", () =>
      Effect.gen(function*() {
        const key = "fault/fence-heartbeat"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("fence-heartbeat", ownerA)
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          let stolen = false
          const steal: Notifying.Hook = (op, order) =>
            op === "heartbeat" && order === "before" && !stolen
              ? Effect.suspend(() => {
                stolen = true
                return takeover(runs, "fence-heartbeat", ownerB).pipe(Effect.orDie)
              })
              : Effect.void

          const fencedOut = makeExecutor({ runId: "fence-heartbeat", owner: ownerA, key, result: "wrong" })
          // Exercise the Layer-producing form of the wrapper here.
          const exit = yield* awaitExit(
            fencedOut.execute(1).pipe(
              Effect.provide(Notifying.layer(RunStore.RunStore, steal))
            )
          )

          const winner = makeExecutor({ runId: "fence-heartbeat", owner: ownerB, key, result: "right" })
          const value = yield* winner.execute(1)
          const row = yield* attempts.get({ runId: "fence-heartbeat", stepKeyDigest: sha256(key), attempt: 1 })
          return { exit, value, row, fencedDispatches: fencedOut.dispatches(), winnerDispatches: winner.dispatches() }
        }))

        expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
        expect(result.fencedDispatches).toBe(0)
        expect(result.winnerDispatches).toBe(1)
        expect(result.value).toBe("right")
        expect(Option.getOrThrow(result.row).state).toBe("succeeded")
      }))

    it.effect("fence lost before attempts.put: no attempt row or journal record leaks from the fenced owner", () =>
      Effect.gen(function*() {
        const key = "fault/fence-put"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("fence-put", ownerA)
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const journal = yield* Journal.Journal
          // The steal lands on the attempt probe that immediately precedes the
          // admission transaction, not inside it: `attempts.put` and its
          // `attemptStarted` append now share one transaction, and this test
          // database is a single SQLite connection, so a thief injected inside
          // that transaction would be rolled back with the victim rather than
          // racing it. Production thieves hold their own connection and simply
          // serialize against the victim's write. The fence check itself is
          // unchanged: `put` is owner-fenced and reports `FenceLost`.
          const steal: Notifying.Hook = (op, order) =>
            op === "get" && order === "after"
              ? takeover(runs, "fence-put", ownerB).pipe(Effect.orDie)
              : Effect.void

          const fencedOut = makeExecutor({ runId: "fence-put", owner: ownerA, key, result: "wrong" })
          const exit = yield* awaitExit(
            fencedOut.execute(1).pipe(
              Effect.provideService(AttemptStore.AttemptStore, Notifying.wrap(attempts, steal))
            )
          )
          const row = yield* attempts.get({ runId: "fence-put", stepKeyDigest: sha256(key), attempt: 1 })
          yield* journal.flush
          const entries = yield* journal.entries({ runId: "fence-put" as never, limit: 20 })

          const winner = makeExecutor({ runId: "fence-put", owner: ownerB, key, result: "right" })
          const value = yield* winner.execute(1)
          return {
            exit,
            row,
            value,
            fencedDispatches: fencedOut.dispatches(),
            eventTypes: entries.entries.map((entry) => entry.eventType)
          }
        }))

        expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
        expect(result.fencedDispatches).toBe(0)
        expect(Option.isNone(result.row)).toBe(true)
        expect(result.eventTypes).not.toContain("flows.engine.attempt-started")
        expect(result.value).toBe("right")
      }))

    it.effect("fence lost at attempts.finish: the fenced completion is discarded and exactly one durable completion survives", () =>
      Effect.gen(function*() {
        const key = "fault/fence-finish"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("fence-finish", ownerA)
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const steal: Notifying.Hook = (op, order, args) =>
            op === "finish" && order === "before" && succeededFinish(args)
              ? takeover(runs, "fence-finish", ownerB).pipe(Effect.orDie)
              : Effect.void

          const fencedOut = makeExecutor({ runId: "fence-finish", owner: ownerA, key, result: "wrong" })
          const exit = yield* awaitExit(
            fencedOut.execute(1).pipe(
              Effect.provideService(AttemptStore.AttemptStore, Notifying.wrap(attempts, steal))
            )
          )

          const winner = makeExecutor({ runId: "fence-finish", owner: ownerB, key, result: "right" })
          const value = yield* winner.execute(2)
          const digest = sha256(key)
          const rowOne = yield* attempts.get({ runId: "fence-finish", stepKeyDigest: digest, attempt: 1 })
          const rowTwo = yield* attempts.get({ runId: "fence-finish", stepKeyDigest: digest, attempt: 2 })
          const cache = yield* CacheStore.CacheStore
          const cached = yield* cache.get(digest)
          return { exit, value, rowOne, rowTwo, cached, fencedDispatches: fencedOut.dispatches() }
        }))

        expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
        expect(result.fencedDispatches).toBe(1)
        expect(result.value).toBe("right")
        // The fenced owner's completion never seals; the new owner's does.
        expect(Option.getOrThrow(result.rowOne).state).toBe("running")
        expect(Option.getOrThrow(result.rowTwo).state).toBe("succeeded")
        // First-recorded cache row is the winner's and is never silently
        // overwritten by the fenced owner.
        expect(Option.getOrThrow(result.cached).result).toBe("right")
      }))

    it.effect("claim takeover mid-write: owner B claims while owner A is executing, and A's later writes cannot corrupt state", () =>
      Effect.gen(function*() {
        const key = "fault/claim-takeover"
        const result = yield* run(Effect.gen(function*() {
          yield* activate("claim-takeover", ownerA)
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const cache = yield* CacheStore.CacheStore
          const started = yield* Deferred.make<void>()
          const gate = yield* Latch.make(false)

          const loser = makeExecutor({
            runId: "claim-takeover",
            owner: ownerA,
            key,
            result: "a-result",
            body: Deferred.succeed(started, undefined).pipe(Effect.andThen(gate.await))
          })
          const fiber = yield* loser.execute(1).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)

          // Owner B claims the run while A is mid-execute, then completes the
          // action under its own fence.
          yield* takeover(runs, "claim-takeover", ownerB)
          const winner = makeExecutor({ runId: "claim-takeover", owner: ownerB, key, result: "b-result" })
          const value = yield* winner.execute(2)

          // A resumes: every subsequent durable write is fenced out.
          yield* gate.open
          const exit = yield* Fiber.await(fiber)

          const digest = sha256(key)
          const rowOne = yield* attempts.get({ runId: "claim-takeover", stepKeyDigest: digest, attempt: 1 })
          const rowTwo = yield* attempts.get({ runId: "claim-takeover", stepKeyDigest: digest, attempt: 2 })
          const cached = yield* cache.get(digest)
          const row = yield* runs.get("claim-takeover")
          return { exit, value, rowOne, rowTwo, cached, owner: row.owner }
        }))

        expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
        expect(result.value).toBe("b-result")
        expect(result.owner).toEqual(ownerB)
        // B's completion is the only durable one; A's row never advances past
        // running and the first-recorded cache row is never overwritten.
        expect(Option.getOrThrow(result.rowOne).state).toBe("running")
        expect(Option.getOrThrow(result.rowTwo).state).toBe("succeeded")
        expect(Option.getOrThrow(result.cached).result).toBe("b-result")
        expect(Option.getOrThrow(result.cached).recordedRunId).toBe("claim-takeover")
      }))
  })

  describe("Notifying wrapper", () => {
    it.effect("fires the hook around Effect methods and Effect properties, delegating everything else untouched", () =>
      Effect.gen(function*() {
        const log: Array<string> = []
        const hook: Notifying.Hook = (op, order) =>
          Effect.sync(() => {
            log.push(`${op}:${order}`)
          })
        const service = {
          ping: Effect.succeed("pong"),
          add: (n: number) => Effect.succeed(n + 1),
          raw: (n: number) => n * 2,
          label: "constant"
        }
        const wrapped = Notifying.wrap(service, hook)

        expect(wrapped.label).toBe("constant")
        expect(wrapped.raw(3)).toBe(6)
        const added = yield* withCrypto(wrapped.add(1))
        const pinged = yield* withCrypto(wrapped.ping)

        expect(added).toBe(2)
        expect(pinged).toBe("pong")
        expect(log).toEqual(["add:before", "add:after", "ping:before", "ping:after"])
      }))

    it.effect("a hook that dies before the operation prevents the operation from running", () =>
      Effect.gen(function*() {
        let calls = 0
        const service = {
          op: () =>
            Effect.sync(() => {
              calls++
              return calls
            })
        }
        const wrapped = Notifying.wrap(service, crashAt("op", "before"))
        const exit = yield* Effect.exit(wrapped.op())

        expect(isCrash(exit)).toBe(true)
        expect(calls).toBe(0)
      }))
  })
})
