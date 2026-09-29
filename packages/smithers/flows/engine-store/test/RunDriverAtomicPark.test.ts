import { describe, expect, it } from "@effect/vitest"
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
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
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WakeBus from "../src/WakeBus.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("RunDriverAtomicPark/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const firstOwner: Ownership.OwnerId = { hostId: "atomic-first", pid: 1, nonce: "first" }
const nextOwner: Ownership.OwnerId = { hostId: "atomic-next", pid: 2, nonce: "next" }
const engine = Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
const executionId = "atomic-park"

/** Advance only the steal's arbitration clock, without running heartbeat fibers. */
const takeOver = (store: RunStore.Service, state: DurableEngineState.Service, waiting: DurableEngineState.Waiting) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const row = yield* store.get(executionId)
    const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const nowMs = row.heartbeatAtMs! + 31_000
    const clock = yield* Clock.Clock
    const advancedClock: Clock.Clock = {
      ...clock,
      currentTimeMillis: Effect.succeed(nowMs),
      currentTimeMillisUnsafe: () => nowMs,
      currentTimeNanos: Effect.succeed(BigInt(nowMs) * 1_000_000n),
      currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n
    }
    yield* state.transaction(journal.transact(Effect.gen(function*() {
      const claim = yield* store.steal(executionId, expected, nextOwner, nowMs, {
        expectedOwner: firstOwner,
        checkedAtMs: nowMs,
        kind: "lease-expired"
      }).pipe(Effect.provideService(Clock.Clock, advancedClock))
      expect(claim._tag).toBe("Claimed")
      if (claim._tag !== "Claimed") return yield* Effect.die("replacement claim lost")
      expect((yield* store.activate(executionId, nextOwner, claim.claimedAtMs, expected))._tag).toBe("Activated")
      expect((yield* state.park(executionId, waiting, nextOwner))._tag).toBe("Parked")
      expect((yield* store.transitionOwned(executionId, nextOwner, "suspended", row.stateJson))._tag).toBe(
        "Transitioned"
      )
    })))
  })

for (const adapter of ["sqlite", "memory"] as const) {
  describe(`RunDriver atomic park (${adapter})`, () => {
    const scenario = (
      replacement?: DurableEngineState.Waiting,
      recover = false,
      refuseTransition = false,
      journalOwnsTransaction = true
    ) =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const sql = yield* SqlClient.SqlClient
          const sqlState = yield* DurableEngineState.DurableEngineState
          // The memory layer shares the real SQL run store. Its permissive run
          // view deliberately lets an old park reach the final SQL owner fence:
          // a failed transition must restore the memory snapshot, not commit it.
          const state = adapter === "sqlite" ? sqlState : DurableEngineState.makeMemory()
          const releasing = yield* Deferred.make<void>()
          const continueRelease = yield* Deferred.make<void>()
          const running = yield* Deferred.make<void>()
          let armed = false
          let pauseNextTransaction = false
          let markerReads = 0
          let markerClears = 0
          let parksInSqlTransaction = 0
          let refused = 0
          const observedState: DurableEngineState.Service = {
            ...state,
            transaction: (effect, options) =>
              Effect.suspend(() => {
                if (!pauseNextTransaction) return state.transaction(effect, options)
                pauseNextTransaction = false
                return Deferred.succeed(releasing, undefined).pipe(
                  Effect.andThen(Deferred.await(continueRelease)),
                  Effect.andThen(state.transaction(effect, options))
                )
              }),
            park: (runId, waiting, owner) =>
              Effect.gen(function*() {
                const transaction = yield* Effect.serviceOption(sql.transactionService)
                if (armed && Option.isSome(transaction)) parksInSqlTransaction++
                const parked = yield* state.park(runId, waiting, owner)
                // Without an enclosing transaction the old park has already
                // committed. Reproduce the original race at that boundary so
                // old code fails marker assertions instead of waiting forever
                // for the transaction entry it never reaches.
                if (armed && pauseNextTransaction && Option.isNone(transaction)) {
                  pauseNextTransaction = false
                  yield* Deferred.succeed(releasing, undefined)
                  yield* Deferred.await(continueRelease)
                }
                return parked
              }),
            waiting: (runId) =>
              Effect.suspend(() => {
                if (armed) markerReads++
                return state.waiting(runId)
              }),
            wake: (runId) =>
              Effect.suspend(() => {
                if (armed) markerClears++
                return state.wake(runId)
              })
          }
          const observedStore = RunStore.makeNoop({
            ...store,
            transitionOwned: (runId, owner, status, persisted, guard) =>
              store.transitionOwned(
                runId,
                armed && refuseTransition && status === "suspended" ? nextOwner : owner,
                status,
                persisted,
                guard
              ).pipe(Effect.tap((outcome) =>
                Effect.sync(() => {
                  if (armed && outcome._tag !== "Transitioned") refused++
                })
              ))
          })
          const driverScope = yield* Scope.make()
          const journal = yield* Journal.Journal
          // The real journal runs whenCommitted immediately without an open
          // SQL transaction. A pass-through boundary models that documented
          // journal contract; every store operation still uses real SQLite.
          const observedJournal: Journal.Service = journalOwnsTransaction
            ? journal
            : { ...journal, transact: (effect) => effect }
          const driver = yield* RunDriver.make({ owner: firstOwner, journalSource: "atomic-first", engine }).pipe(
            Effect.provideService(Journal.Journal, observedJournal),
            Effect.provideService(DurableEngineState.DurableEngineState, observedState),
            Effect.provideService(RunStore.RunStore, observedStore),
            Scope.provide(driverScope)
          )
          yield* driver.register(flow, () => Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never)))
          const execution = yield* driver.execute(flow, { executionId, payload: {}, discard: true }).pipe(
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(running)
          const originalWaiting = { reason: "event", token: "before-release", wakeAt: 777 } as const
          if (refuseTransition) yield* state.park(executionId, originalWaiting, firstOwner)
          const bytes = Effect.gen(function*() {
            // Include every flows_runs column, not merely the reason being
            // compared. The memory marker is separate from that SQL row.
            const rows = yield* sql`SELECT * FROM flows_runs WHERE run_id = ${executionId}`
            return JSON.stringify({ rows, marker: yield* state.waiting(executionId) })
          })
          const originalBytes = yield* bytes
          armed = true
          pauseNextTransaction = replacement !== undefined
          const closing = yield* Scope.close(driverScope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
          let replacementBytes: string | undefined
          if (replacement !== undefined) {
            // The old owner has already read its running row and chosen release,
            // but has not entered the transaction. This is the last point where
            // an independent replacement can commit before the old settlement.
            yield* Deferred.await(releasing)
            yield* takeOver(store, state, replacement)
            replacementBytes = yield* bytes
            yield* Deferred.succeed(continueRelease, undefined)
          }
          yield* Fiber.join(closing)
          yield* Fiber.await(execution)
          const row = yield* store.get(executionId)
          const waiting = yield* state.waiting(executionId)
          const afterBytes = yield* bytes
          // A committed release observes its own waiting marker for the
          // lifecycle fact. A refusal must never inspect a replacement's row.
          expect(markerReads).toBe(replacement === undefined && !refuseTransition ? 1 : 0)
          expect(markerClears).toBe(0)
          expect(parksInSqlTransaction).toBe(journalOwnsTransaction ? 1 : 0)
          if (replacement !== undefined) {
            expect(afterBytes).toBe(replacementBytes)
            expect(row.status).toBe("suspended")
            expect(Option.getOrThrow(waiting)).toEqual({
              runId: executionId,
              reason: replacement.reason,
              token: replacement.token ?? null,
              wakeAt: replacement.wakeAt ?? null
            })
          } else if (refuseTransition) {
            expect(refused).toBe(1)
            expect(afterBytes).toBe(originalBytes)
            expect(row.status).toBe("running")
            expect(Option.getOrThrow(waiting)).toEqual({ runId: executionId, ...originalWaiting })
          } else {
            expect(row.status).toBe("suspended")
            expect(row.owner).toBeNull()
            expect(Option.getOrThrow(waiting)).toEqual({
              runId: executionId,
              reason: "released",
              token: null,
              wakeAt: null
            })
          }
          if (replacement?.reason === "released" || (replacement === undefined && !refuseTransition)) {
            expect((yield* state.waitingRuns({ reason: "released" })).map((row) => row.runId)).toEqual([executionId])
          }
          if (recover) {
            const completed = yield* Deferred.make<void>()
            let executions = 0
            const recovering = yield* RunDriver.make({
              owner: { hostId: "atomic-recovery", pid: 3, nonce: "recovery" },
              journalSource: "atomic-recovery",
              engine,
              wakeBus: WakeBus.makeNoop({ wake: () => Deferred.succeed(completed, undefined).pipe(Effect.asVoid) })
            }).pipe(Effect.provideService(DurableEngineState.DurableEngineState, state))
            yield* recovering.register(flow, () =>
              Effect.sync(() => {
                executions++
                return "recovered"
              }))
            // No execute/resume call: only the heartbeat's released-run sweep
            // can dispatch this run. The wake signal follows the durable commit.
            yield* TestClock.adjust(Ownership.heartbeatInterval)
            yield* Deferred.await(completed)
            expect(executions).toBe(1)
            expect((yield* store.get(executionId)).status).toBe("completed")
            expect(Option.isNone(yield* state.waiting(executionId))).toBe(true)
            expect(yield* state.waitingRuns({ reason: "released" })).toEqual([])
            const result = Option.getOrThrow(yield* recovering.poll(flow, executionId))
            expect(result._tag).toBe("Complete")
            if (result._tag === "Complete") expect(result.exit).toEqual(Exit.succeed("recovered"))
          }
        })).pipe(Effect.provide(TestStores.layerAt(":memory:")), Effect.provide(TestClock.layer()))
      )

    it.effect("leaves a same-reason replacement byte-identical after the old settlement", () =>
      scenario({ reason: "released", token: "replacement-owner-marker" }))

    it.effect("preserves a replacement with identical reason, token and wakeAt", () => scenario({ reason: "released" }))

    it.effect("leaves a different-reason replacement byte-identical after the old settlement", () =>
      scenario({ reason: "event", token: "replacement-event", wakeAt: 1234 }))

    it.effect("parks and suspends its own release in the journal transaction", () => scenario())

    it.effect("rolls back its park to the previous marker when the real transition refuses its owner", () =>
      scenario(undefined, false, true))

    if (adapter === "memory") {
      it.effect("ignores an immediate commit callback until the body succeeds and rolls back a refused park", () =>
        scenario(undefined, false, true, false))
    }

    it.effect("re-drives the replacement's released run through a second driver's recovery sweep", () =>
      scenario({ reason: "released", token: "replacement-owner-marker" }, true))
  })
}

for (const adapter of ["sqlite", "memory"] as const) {
  describe(`RunDriver transaction publication (${adapter})`, () => {
    for (const settlement of ["suspend", "shutdown"] as const) {
      it.effect(`reads committed waiting state during ${settlement} compaction without advancing the clock`, () =>
        withCrypto(
          Effect.scoped(Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const sql = yield* SqlClient.SqlClient
            const sqlState = yield* DurableEngineState.DurableEngineState
            const state = adapter === "sqlite" ? sqlState : DurableEngineState.makeMemory()
            const capturing = yield* Deferred.make<void>()
            const running = yield* Deferred.make<void>()
            let captures = 0
            let readCount = 0
            const journal = Context.get(
              yield* Layer.build(SqlJournal.layer({
                capacity: 1024,
                overflow: "reject",
                compaction: {
                  entryThreshold: 1,
                  capture: (runId) =>
                    Effect.gen(function*() {
                      const row = yield* store.get(runId)
                      if (row.status !== "suspended") return {}
                      captures++
                      expect(Option.isNone(yield* Effect.serviceOption(sql.transactionService))).toBe(true)
                      expect(row.owner).toBeNull()
                      yield* Deferred.succeed(capturing, undefined)
                      const waiting = yield* state.transaction(state.waiting(runId))
                      readCount++
                      expect(waiting).toEqual(Option.some({
                        runId,
                        reason: settlement === "suspend" ? "event" : "released",
                        token: null,
                        wakeAt: null
                      }))
                      return { waiting }
                    })
                }
              })),
              Journal.Journal
            )
            const driverScope = yield* Scope.make()
            const driver = yield* RunDriver.make({ owner: firstOwner, journalSource: "capture-read", engine }).pipe(
              Effect.provideService(Journal.Journal, journal),
              Effect.provideService(DurableEngineState.DurableEngineState, state),
              Scope.provide(driverScope)
            )
            yield* driver.register(flow, () =>
              Effect.gen(function*() {
                yield* Deferred.succeed(running, undefined)
                if (settlement === "shutdown") return yield* Effect.never
                const instance = yield* FlowRuntime.FlowInstance
                instance.waiting = { reason: "event" }
                return yield* Flow.suspend(instance)
              }))
            const before = yield* Clock.currentTimeMillis
            const execution = yield* driver.execute(flow, { executionId, payload: {}, discard: true }).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            yield* Deferred.await(running)
            const settled = settlement === "suspend"
              ? execution
              : yield* Scope.close(driverScope, Exit.void).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(capturing)
            // Flush runnable fibers at the same virtual instant. A blocked
            // capture remains asleep, so the assertion fails without a timeout.
            yield* TestClock.adjust(0)
            const observed = { captures, readCount, elapsed: (yield* Clock.currentTimeMillis) - before }
            // On a regression, let the existing capture timeout release the
            // uninterruptible shutdown finalizer so the failing test can exit.
            if (readCount === 0) yield* TestClock.adjust("31 seconds")
            yield* Fiber.join(settled)
            yield* Fiber.await(execution)
            yield* Scope.close(driverScope, Exit.void)
            expect(observed).toEqual({ captures: 1, readCount: 1, elapsed: 0 })
            const checkpoint = Option.getOrThrow(yield* journal.latestCheckpoint(JournalEvent.RunId.make(executionId)))
            expect(checkpoint.state).toEqual({
              waiting: {
                _id: "Option",
                _tag: "Some",
                value: {
                  runId: executionId,
                  reason: settlement === "suspend" ? "event" : "released",
                  token: null,
                  wakeAt: null
                }
              }
            })
          })).pipe(Effect.provide(TestStores.layerAt(":memory:")))
        ))
    }

    for (const interruption of ["shutdown", "self"] as const) {
      it.effect(`preserves a committed park after ${interruption} interruption in compaction`, () =>
        withCrypto(
          Effect.scoped(Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const sql = yield* SqlClient.SqlClient
            const sqlState = yield* DurableEngineState.DurableEngineState
            const state = adapter === "sqlite" ? sqlState : DurableEngineState.makeMemory()
            const capturing = yield* Deferred.make<void>()
            const finishedCapture = yield* Deferred.make<void>()
            const journal = Context.get(
              yield* Layer.build(SqlJournal.layer({
                capacity: 1024,
                overflow: "reject",
                compaction: {
                  entryThreshold: 1,
                  capture: (runId) =>
                    Effect.gen(function*() {
                      const row = yield* store.get(runId)
                      if (row.status !== "suspended") return {}
                      // This is real automatic maintenance, after SQL COMMIT. Read
                      // through the actual connection before permitting shutdown.
                      expect(Option.isNone(yield* Effect.serviceOption(sql.transactionService))).toBe(true)
                      expect(row.owner).toBeNull()
                      yield* Deferred.succeed(capturing, undefined)
                      return yield* (interruption === "shutdown" ? Effect.never : Effect.interrupt).pipe(
                        Effect.ensuring(Deferred.succeed(finishedCapture, undefined))
                      )
                    })
                }
              })),
              Journal.Journal
            )
            const driverScope = yield* Scope.make()
            const driver = yield* RunDriver.make({ owner: firstOwner, journalSource: "publication", engine }).pipe(
              Effect.provideService(Journal.Journal, journal),
              Effect.provideService(DurableEngineState.DurableEngineState, state),
              Scope.provide(driverScope)
            )
            yield* driver.register(flow, () =>
              Effect.gen(function*() {
                const instance = yield* FlowRuntime.FlowInstance
                instance.waiting = { reason: "released" }
                return yield* Flow.suspend(instance)
              }))
            const execution = yield* driver.execute(flow, { executionId, payload: {}, discard: true }).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            yield* Deferred.await(capturing)
            if (interruption === "shutdown") yield* Scope.close(driverScope, Exit.void)
            yield* Deferred.await(finishedCapture)
            yield* Fiber.await(execution)
            if (interruption === "self") yield* Scope.close(driverScope, Exit.void)
            const row = yield* store.get(executionId)
            expect(row.status).toBe("suspended")
            expect(row.owner).toBeNull()
            expect(yield* state.waiting(executionId)).toEqual(Option.some({
              runId: executionId,
              reason: "released",
              token: null,
              wakeAt: null
            }))
            expect((yield* state.waitingRuns({ reason: "released" })).map((row) => row.runId)).toEqual([executionId])
          })).pipe(Effect.provide(TestStores.layerAt(":memory:")))
        ))
    }

    it.effect("restores the marker when SQL fails after a successful park and transition", () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const sql = yield* SqlClient.SqlClient
          const writer = yield* DurableWriter
          const journal = yield* Journal.Journal
          const sqlState = yield* DurableEngineState.DurableEngineState
          const state = adapter === "sqlite" ? sqlState : DurableEngineState.makeMemory()
          const stateJson = JSON.stringify({ version: 1, flowName: flow._tag, payload: {} })
          yield* sql`INSERT INTO flows_runs (
            run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
          ) VALUES (
            ${executionId}, 'running', 0, ${firstOwner.hostId}, ${firstOwner.pid}, ${firstOwner.nonce}, 0, ${stateJson}
          )`
          yield* state.park(executionId, { reason: "event", token: "previous" }, firstOwner)
          const before = yield* sql`SELECT * FROM flows_runs WHERE run_id = ${executionId}`
          const marker = yield* state.waiting(executionId)
          const failure = new DatabaseError({ code: "io" })
          let commit = Effect.void
          let publications = 0
          const exit = yield* Effect.exit(state.transaction(
            writer.write(Effect.gen(function*() {
              yield* journal.whenCommitted(commit)
              yield* journal.whenCommitted(Effect.sync(() => {
                publications++
              }))
              expect((yield* state.park(executionId, { reason: "released" }, firstOwner))._tag).toBe("Parked")
              expect((yield* store.transitionOwned(executionId, firstOwner, "suspended", stateJson))._tag).toBe(
                "Transitioned"
              )
              // Inject at the outer writer after both successful mutations,
              // before COMMIT. No commit callback may accept the memory state.
              return yield* Effect.fail(failure)
            })),
            {
              onCommit: (accept) => {
                commit = accept
              }
            }
          ))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(publications).toBe(0)
          expect(yield* sql`SELECT * FROM flows_runs WHERE run_id = ${executionId}`).toEqual(before)
          expect(yield* state.waiting(executionId)).toEqual(marker)
          // Rollback releases the gate for a different fiber too.
          const read = yield* state.waiting(executionId).pipe(Effect.forkChild({ startImmediately: true }))
          expect(yield* Fiber.join(read)).toEqual(marker)
        })).pipe(Effect.provide(TestStores.layerAt(":memory:")))
      ))

    for (const holderBoundary of ["state", "journal"] as const) {
      for (const boundary of ["caller interruption", "deadline"] as const) {
        it.effect(`honors ${boundary} while waiting for ${holderBoundary} transaction acquisition`, () =>
          withCrypto(
            Effect.scoped(Effect.gen(function*() {
              const store = yield* RunStore.RunStore
              const state = adapter === "sqlite"
                ? yield* DurableEngineState.DurableEngineState
                : DurableEngineState.makeMemory()
              const journal = yield* Journal.Journal
              const acquired = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const driver = yield* RunDriver.make({ owner: firstOwner, journalSource: "acquisition", engine }).pipe(
                Effect.provideService(DurableEngineState.DurableEngineState, state)
              )
              yield* store.create(executionId, JSON.stringify({ version: 1, flowName: flow._tag, payload: {} }))
              const hold = holderBoundary === "state" ? state.transaction : journal.transact
              const holder = yield* hold(
                Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release)))
              ).pipe(Effect.forkChild({ startImmediately: true }))
              yield* Deferred.await(acquired)
              const request = driver.interrupt(flow, executionId)
              const caller = yield* (boundary === "deadline" ? request.pipe(Effect.timeoutOption("1 second")) : request)
                .pipe(
                  Effect.forkChild({ startImmediately: true })
                )
              yield* TestClock.adjust(0)
              if (boundary === "caller interruption") caller.interruptUnsafe()
              yield* TestClock.adjust("1 second")
              const beforeRelease = caller.pollUnsafe()
              let entered = false
              const next = yield* state.transaction(journal.transact(Effect.sync(() => {
                entered = true
              }))).pipe(Effect.forkChild({ startImmediately: true }))
              yield* TestClock.adjust(0)
              const enteredBeforeRelease = entered
              // Always release the unrelated holder before asserting, including on
              // the broken implementation, so a failed probe cannot hang cleanup.
              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(holder)
              yield* Fiber.join(next)
              const exit = yield* Fiber.await(caller)
              expect(beforeRelease).toBeDefined()
              expect(enteredBeforeRelease).toBe(false)
              if (boundary === "deadline") {
                expect(exit).toEqual(Exit.succeed(Option.none()))
              } else {
                expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
              }
              expect((yield* store.get(executionId)).cancelRequestedAtMs).toBeNull()
              // The cancelled waiter must not release the holder's permit or leave
              // an abandoned request that starts writing once the holder finishes.
              yield* driver.interrupt(flow, executionId)
              expect((yield* store.get(executionId)).cancelRequestedAtMs).not.toBeNull()
            })).pipe(Effect.provide(TestStores.layerAt(":memory:")))
          ))
      }
    }

    for (
      const fault of [
        "begin",
        "storage-defect",
        "commit",
        "defect",
        "mixed-defect",
        "mixed-interrupt",
        "typed-mixed-defect",
        "typed-mixed-interrupt"
      ] as const
    ) {
      it.effect(`preserves cancellation error channels and rows on a writer ${fault} failure`, () =>
        withCrypto(
          Effect.scoped(Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const writer = yield* DurableWriter
            const storageFailure = new DatabaseError({ code: "io" })
            const unexpected = new Error("unexpected writer defect")
            let armed = false
            let injected = 0
            const failingWriter: DurableWriter["Service"] = {
              write: (effect) =>
                Effect.gen(function*() {
                  const enclosing = yield* Effect.serviceOption(sql.transactionService)
                  if (!armed || Option.isSome(enclosing)) return yield* writer.write(effect)
                  injected++
                  if (fault.includes("mixed-")) {
                    return yield* (fault.startsWith("typed-")
                      ? Effect.fail(storageFailure)
                      : Effect.die(storageFailure)).pipe(
                        Effect.ensuring(fault.endsWith("defect") ? Effect.die(unexpected) : Effect.interrupt)
                      )
                  }
                  if (fault === "storage-defect") return yield* Effect.die(storageFailure)
                  if (fault === "defect") return yield* Effect.die(unexpected)
                  if (fault === "begin") return yield* Effect.fail(storageFailure)
                  // Fail after the real body, still before COMMIT. All parent and
                  // descendant requests must roll back along with the writer.
                  return yield* writer.write(effect.pipe(Effect.andThen(Effect.fail(storageFailure))))
                })
            }
            const store = yield* RunStore.make.pipe(
              Effect.provide(SqlConsensus.layer),
              Effect.provideService(DurableWriter, failingWriter)
            )
            const state = adapter === "sqlite"
              ? yield* DurableEngineState.make.pipe(Effect.provideService(DurableWriter, failingWriter))
              : DurableEngineState.makeMemory()
            const journal = Context.get(
              yield* Layer.build(SqlJournal.layer({ capacity: 1024, overflow: "reject" })).pipe(
                Effect.provideService(DurableWriter, failingWriter)
              ),
              Journal.Journal
            )
            yield* store.create(executionId, JSON.stringify({ version: 1, flowName: flow._tag, payload: {} }))
            yield* store.create("publication-child", JSON.stringify({ version: 1, flowName: flow._tag, payload: {} }))
            yield* state.recordRunParent("publication-child", executionId)
            const driver = yield* RunDriver.make({ owner: firstOwner, journalSource: "writer-fault", engine }).pipe(
              Effect.provideService(RunStore.RunStore, store),
              Effect.provideService(DurableEngineState.DurableEngineState, state),
              Effect.provideService(Journal.Journal, journal),
              Effect.provideService(DurableWriter, failingWriter)
            )
            const before = yield* sql`SELECT * FROM flows_runs ORDER BY run_id`
            armed = true
            const exit = yield* Effect.exit(driver.interrupt(flow, executionId))
            armed = false
            expect(injected).toBe(1)
            expect(yield* sql`SELECT * FROM flows_runs ORDER BY run_id`).toEqual(before)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isSuccess(exit)) return
            if (fault.includes("mixed-")) {
              expect(exit.cause.reasons).toHaveLength(2)
              // Both shapes arrive as defects. `interrupt` declares
              // `CancelRequestFailed` and nothing else, so a typed writer
              // failure that cannot be normalized into one keeps its identity
              // and loses its channel instead of escaping the declared type.
              expect(
                exit.cause.reasons.some((reason) =>
                  Cause.isDieReason(reason) && Object.is(reason.defect, storageFailure)
                )
              ).toBe(true)
              expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false)
              if (fault.endsWith("defect")) {
                expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === unexpected))
                  .toBe(true)
              } else {
                expect(Cause.hasInterrupts(exit.cause)).toBe(true)
              }
            } else if (fault === "defect") {
              expect(Cause.hasDies(exit.cause)).toBe(true)
              expect(Cause.squash(exit.cause)).toBe(unexpected)
            } else {
              expect(Cause.hasDies(exit.cause)).toBe(false)
              const error = Cause.squash(exit.cause)
              expect(error).toBeInstanceOf(FlowRuntime.CancelRequestFailed)
              expect(error).toMatchObject({ code: "cancel_request_failed", executionId })
            }
            // The same durable request remains retryable and cascades fully.
            yield* driver.interrupt(flow, executionId)
            expect((yield* store.get(executionId)).cancelRequestedAtMs).not.toBeNull()
            expect((yield* store.get("publication-child")).cancelRequestedAtMs).not.toBeNull()
          })).pipe(Effect.provide(TestStores.layerAt(":memory:")))
        ))
    }
  })
}
