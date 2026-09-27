import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import * as Migrations from "../src/Migrations.ts"
import { withCrypto } from "./Sha256.ts"

const owner = {
  hostId: "deferred-test",
  pid: 1,
  nonce: "owner"
}

const TestFlow = Flow.make("DeferredPersistence/Test", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const makeJournal = (events: Array<string>) =>
  (() => {
    const admissions = new Map<string, {
      readonly seq: JournalEvent.Seq
      readonly sourceSeq: JournalEvent.SourceSeq
    }>()
    const record = (input: JournalEvent.Input, channel: string) =>
      Effect.sync(() => {
        const sourceSeq = input.sourceSeq ?? 0 as JournalEvent.SourceSeq
        const key = JSON.stringify([input.runId, input.sourceId, sourceSeq])
        const existing = admissions.get(key)
        if (existing !== undefined) {
          return {
            _tag: "Duplicate" as const,
            ...existing,
            status: "committed" as const
          }
        }
        const row = {
          seq: admissions.size as JournalEvent.Seq,
          sourceSeq
        }
        admissions.set(key, row)
        events.push(`${channel}:${input.eventType}`)
        return {
          _tag: "Accepted" as const,
          ...row
        }
      })
    return Journal.makeNoop({
      emitDurable: (input) => record(input, "emit"),
      emitDurableUnfenced: (input) => record(input, "emit"),
      flush: Effect.sync(() => {
        events.push("flush")
      })
    })
  })()

const build = (
  state: DurableEngineState.Service,
  journal: Journal.Service,
  resumes: Array<string>,
  onResume?: () => void,
  fireRetryPolicy?: DeferredPersistence.FireRetryPolicy
) =>
  DeferredPersistence.make({
    owner,
    journalSource: "deferred-test",
    scheduleResume: (_flowName, executionId, reason) =>
      Effect.sync(() => {
        onResume?.()
        resumes.push(`${executionId}:${reason}`)
      }),
    fireRetryPolicy
  }).pipe(
    Effect.provideService(DurableEngineState.DurableEngineState, state),
    Effect.provideService(Journal.Journal, journal)
  )

describe("DeferredPersistence", () => {
  it.effect("rehydrates valid exits and leaves malformed lookalikes inert", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const malformed: ReadonlyArray<unknown> = [
        1,
        { _id: "Other" },
        { _id: "Exit", _tag: "Other" },
        { _id: "Exit", _tag: "Failure", cause: null },
        { _id: "Exit", _tag: "Failure", cause: {} },
        { _id: "Exit", _tag: "Failure", cause: { failures: [null] } },
        { _id: "Exit", _tag: "Failure", cause: { failures: [{ _tag: "Unknown" }] } }
      ]
      for (const [index, exit] of malformed.entries()) {
        const completed = yield* state.completeDeferred({
          flowName: TestFlow._tag,
          executionId: `malformed-${index}`,
          deferredName: "answer",
          exit,
          completedAtMs: 0
        })
        expect(completed.row.exit).toEqual(exit)
      }

      const interrupted = yield* state.completeDeferred({
        flowName: TestFlow._tag,
        executionId: "numeric-interrupt",
        deferredName: "answer",
        exit: {
          _id: "Exit",
          _tag: "Failure",
          cause: { failures: [{ _tag: "Interrupt", fiberId: 7 }] }
        },
        completedAtMs: 0
      })
      expect(Exit.isFailure(interrupted.row.exit as Exit.Exit<unknown, unknown>)).toBe(true)
      expect((interrupted.row.exit as Exit.Failure<unknown, unknown>).cause.reasons[0]).toMatchObject({
        _tag: "Interrupt",
        fiberId: 7
      })
    }))

  it.effect("keeps the first duplicate or divergent completion", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        const events: Array<string> = []
        const resumes: Array<string> = []
        const service = yield* build(state, makeJournal(events), resumes)
        const address = {
          flowName: TestFlow._tag,
          executionId: "duplicate",
          deferredName: "answer"
        }

        yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
        yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
        yield* service.deferredDone({ ...address, exit: Exit.succeed("different") })
        return {
          row: Option.getOrThrow(yield* state.deferred(address)),
          events,
          resumes
        }
      })))

      expect(result.row.exit).toEqual(Exit.succeed("first"))
      expect(result.events).toEqual([
        "emit:flows.engine.deferred-completed",
        "flush",
        "flush",
        "flush"
      ])
      expect(result.resumes).toEqual([
        "duplicate:deferred",
        "duplicate:deferred",
        "duplicate:deferred"
      ])
    }))

  it.effect("admits only the exact active wait and converges concurrent duplicates", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        const events: Array<string> = []
        const resumes: Array<string> = []
        const service = yield* build(state, makeJournal(events), resumes)
        const address = {
          flowName: TestFlow._tag,
          executionId: "approval-cas",
          deferredName: "answer"
        }
        const completion = {
          ...address,
          reason: "approval",
          token: "attempt-1",
          exit: Exit.succeed("yes")
        }

        const unopened = yield* service.deferredDoneIfWaiting(completion)
        yield* state.park(address.executionId, {
          reason: "approval",
          token: completion.token
        }, owner)
        const duplicates = yield* Effect.all([
          service.deferredDoneIfWaiting(completion),
          service.deferredDoneIfWaiting({ ...completion, exit: Exit.succeed("different") })
        ], { concurrency: "unbounded" })

        yield* state.park(address.executionId, {
          reason: "approval",
          token: "attempt-2"
        }, owner)
        const stale = yield* service.deferredDoneIfWaiting({
          ...completion,
          deferredName: "answer-2"
        })
        const current = yield* service.deferredDoneIfWaiting({
          ...completion,
          deferredName: "answer-2",
          token: "attempt-2"
        })

        return {
          unopened,
          duplicates,
          stale,
          current,
          first: Option.getOrThrow(yield* state.deferred(address)),
          second: Option.getOrThrow(yield* state.deferred({ ...address, deferredName: "answer-2" })),
          events,
          resumes
        }
      })))

      expect(result.unopened).toBe("NotWaiting")
      expect([...result.duplicates].sort()).toEqual(["Completed", "Existing"])
      expect(result.stale).toBe("NotWaiting")
      expect(result.current).toBe("Completed")
      expect([Exit.succeed("yes"), Exit.succeed("different")]).toContainEqual(result.first.exit)
      expect(result.second.exit).toEqual(Exit.succeed("yes"))
      expect(result.events.filter((event) => event === "emit:flows.engine.deferred-completed")).toHaveLength(2)
      expect(result.resumes).toHaveLength(3)
    }))

  it.effect("makes delivery durable before scheduling a resume", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const events: Array<string> = []
      const resumes: Array<string> = []
      let durableAtResume = false
      const address = {
        flowName: TestFlow._tag,
        executionId: "ordered",
        deferredName: "answer"
      }

      yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const service = yield* build(state, makeJournal(events), resumes, () => {
          durableAtResume = events.at(-1) === "flush"
        })
        yield* service.deferredDone({
          ...address,
          exit: Exit.succeed("done"),
          metadata: { correlationId: "opaque" }
        })
      })))

      expect(durableAtResume).toBe(true)
      expect(Option.getOrThrow(yield* withCrypto(state.deferred(address))).metadata).toEqual({
        correlationId: "opaque"
      })
    }))

  it.effect("reads a completion from a fresh persistence instance", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        const journal = makeJournal([])
        const first = yield* build(state, journal, [])
        yield* first.deferredDone({
          flowName: TestFlow._tag,
          executionId: "restart",
          deferredName: "answer",
          exit: Exit.succeed("persisted")
        })

        const restarted = yield* build(state, journal, [])
        const instance = FlowEngine.makeInstance(
          TestFlow,
          "restart"
        )
        return yield* restarted.deferredResult(
          DurableDeferred.make("answer", {
            success: Schema.String
          })
        ).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance)
        )
      })))

      expect(Option.getOrThrow(result)).toEqual(Exit.succeed("persisted"))
    }))

  it.effect("re-arms a future clock after restart and fires its original deadline", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          const journal = makeJournal(events)
          const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })

          yield* Effect.scoped(Effect.gen(function*() {
            const first = yield* build(state, journal, resumes)
            yield* first.scheduleClock(TestFlow, {
              executionId: "clock-run",
              clock
            })
          }))
          yield* TestClock.adjust("5 seconds")

          const restarted = yield* build(state, journal, resumes)
          yield* restarted.sweepDue(TestFlow._tag)
          const before = Option.getOrThrow(
            yield* state.clock({
              flowName: TestFlow._tag,
              executionId: "clock-run",
              clockName: "wake"
            })
          )

          yield* TestClock.adjust("4999 millis")
          yield* Effect.yieldNow
          const pending = Option.getOrThrow(yield* state.clock(before))
          yield* TestClock.adjust("1 millis")
          yield* Effect.yieldNow
          const after = Option.getOrThrow(yield* state.clock(before))
          return { before, pending, after, events, resumes }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result.before.dueAtMs).toBe(10_000)
      expect(result.pending.completedAtMs).toBeNull()
      expect(result.after.completedAtMs).toBe(10_000)
      expect(result.resumes).toEqual(["clock-run:clock"])
      expect(result.events.filter((event) => event === "emit:flows.engine.clock-scheduled")).toHaveLength(1)
      expect(result.events.filter((event) => event === "emit:flows.engine.deferred-completed")).toHaveLength(1)
    }))

  it.effect("does not fire a clock again when a replayed sleep re-schedules it", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const resumes: Array<string> = []
          const service = yield* build(state, makeJournal([]), resumes)
          const clock = DurableClock.make({ name: "replayed", duration: "1 second" })
          yield* service.scheduleClock(TestFlow, { executionId: "replay-run", clock })
          yield* TestClock.adjust("1 second")
          yield* Effect.yieldNow
          const fired = [...resumes]
          // The woken run replays its sleep, which schedules the same clock
          // and gets the fired row back. Re-firing it would wake the run
          // again, and that replay would schedule it again, forever.
          yield* service.scheduleClock(TestFlow, { executionId: "replay-run", clock })
          yield* TestClock.adjust("1 second")
          yield* Effect.yieldNow
          return { fired, resumes }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result.fired).toEqual(["replay-run:clock"])
      expect(result.resumes).toEqual(["replay-run:clock"])
    }))

  it.effect("redispatches a clock fire with backoff after a transient journal failure instead of losing the timer", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          // The first two durable emits at fire time die (e.g. SQLITE_BUSY
          // surfaced through the orDie journal path); the third succeeds.
          let failuresRemaining = 0
          let fireFailures = 0
          const base = makeJournal(events)
          const journal = {
            ...base,
            emitDurableUnfenced: (input: JournalEvent.Input) =>
              Effect.suspend(() => {
                if (failuresRemaining > 0 && input.eventType === "flows.engine.deferred-completed") {
                  failuresRemaining--
                  fireFailures++
                  return Effect.die(new Error("transient journal failure"))
                }
                return base.emitDurableUnfenced(input)
              })
          }
          const clock = DurableClock.make({ name: "retry", duration: "10 seconds" })
          const service = yield* build(state, journal as never, resumes)
          yield* service.scheduleClock(TestFlow, { executionId: "retry-run", clock })
          failuresRemaining = 2
          const address = {
            flowName: TestFlow._tag,
            executionId: "retry-run",
            clockName: "retry"
          }

          yield* TestClock.adjust("10 seconds")
          yield* Effect.yieldNow
          // First fire failed at the journal; without redispatch the timer
          // fiber is dead and the clock row never completes in this process.
          const afterFirstFailure = Option.getOrThrow(yield* state.clock(address))
          yield* TestClock.adjust("100 millis")
          yield* Effect.yieldNow
          const afterSecondFailure = Option.getOrThrow(yield* state.clock(address))
          yield* TestClock.adjust("200 millis")
          yield* Effect.yieldNow
          const afterRetry = Option.getOrThrow(yield* state.clock(address))
          return { afterFirstFailure, afterSecondFailure, afterRetry, fireFailures, resumes }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result.fireFailures).toBe(2)
      expect(result.afterFirstFailure.completedAtMs).toBeNull()
      expect(result.afterSecondFailure.completedAtMs).toBeNull()
      expect(result.afterRetry.completedAtMs).not.toBeNull()
      expect(result.resumes).toEqual(["retry-run:clock"])
    }))

  it.effect("redispatches on a supplied policy instead of the default backoff", () =>
    Effect.gen(function*() {
      // The default ladder starts at 100ms (`defaultFireRetryPolicy`); this
      // composition supplies a flat 5s one instead, so the redispatch that the
      // test above observed after 100ms must not have happened yet at 4999ms.
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          let failuresRemaining = 0
          const base = makeJournal(events)
          const journal = {
            ...base,
            emitDurableUnfenced: (input: JournalEvent.Input) =>
              Effect.suspend(() => {
                if (failuresRemaining > 0 && input.eventType === "flows.engine.deferred-completed") {
                  failuresRemaining--
                  return Effect.die(new Error("transient journal failure"))
                }
                return base.emitDurableUnfenced(input)
              })
          }
          const clock = DurableClock.make({ name: "slow-retry", duration: "10 seconds" })
          const service = yield* build(state, journal as never, resumes, undefined, Schedule.spaced("5 seconds"))
          yield* service.scheduleClock(TestFlow, { executionId: "slow-retry-run", clock })
          failuresRemaining = 1
          const address = {
            flowName: TestFlow._tag,
            executionId: "slow-retry-run",
            clockName: "slow-retry"
          }

          yield* TestClock.adjust("10 seconds")
          yield* Effect.yieldNow
          yield* TestClock.adjust("4999 millis")
          yield* Effect.yieldNow
          const beforeSuppliedDelay = Option.getOrThrow(yield* state.clock(address))
          yield* TestClock.adjust("1 millis")
          yield* Effect.yieldNow
          const afterSuppliedDelay = Option.getOrThrow(yield* state.clock(address))
          return { beforeSuppliedDelay, afterSuppliedDelay, resumes }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result.beforeSuppliedDelay.completedAtMs).toBeNull()
      expect(result.afterSuppliedDelay.completedAtMs).not.toBeNull()
      expect(result.resumes).toEqual(["slow-retry-run:clock"])
    }))

  it.effect("delivers deferred completions and clock fires while the lossy sink failure is latched", () =>
    Effect.gen(function*() {
      // Issue #43: SqlJournal latches `sinkFailure` forever after one lossy
      // writer error, so `flush` fails on every subsequent call while
      // `emitDurable` keeps committing. Durable delivery must survive that.
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const state = DurableEngineState.makeMemory()
          const events: Array<string> = []
          const resumes: Array<string> = []
          let flushFailures = 0
          const base = makeJournal(events)
          const journal: Journal.Service = {
            ...base,
            flush: Effect.suspend(() => {
              flushFailures++
              return Effect.fail(
                new Journal.JournalError({
                  code: "sink_failed",
                  message: "journal sink failed"
                })
              )
            })
          }
          const service = yield* build(state, journal, resumes)

          const deferredAddress = {
            flowName: TestFlow._tag,
            executionId: "latched-run",
            deferredName: "answer"
          }
          yield* service.deferredDone({
            ...deferredAddress,
            exit: Exit.succeed("still delivered")
          })
          const deferredRow = Option.getOrThrow(yield* state.deferred(deferredAddress))

          const clock = DurableClock.make({ name: "latched", duration: "10 seconds" })
          yield* service.scheduleClock(TestFlow, { executionId: "latched-run", clock })
          yield* TestClock.adjust("10 seconds")
          yield* Effect.yieldNow
          const clockRow = Option.getOrThrow(
            yield* state.clock({
              flowName: TestFlow._tag,
              executionId: "latched-run",
              clockName: "latched"
            })
          )
          return { deferredRow, clockRow, events, resumes, flushFailures }
        })).pipe(Effect.provide(TestClock.layer()))
      )

      // Every flush attempt failed with the latched sink error...
      expect(result.flushFailures).toBeGreaterThanOrEqual(3)
      // ...yet the durable channel committed and delivery still happened.
      expect(result.deferredRow.exit).toEqual(Exit.succeed("still delivered"))
      expect(result.clockRow.completedAtMs).not.toBeNull()
      expect(result.events).toContain("emit:flows.engine.deferred-completed")
      expect(result.events).toContain("emit:flows.engine.clock-scheduled")
      expect(result.resumes).toEqual(["latched-run:deferred", "latched-run:clock"])
    }))

  it.effect("re-delivers a wake for a completion recorded before registration", () =>
    Effect.gen(function*() {
      const resumes: Array<string> = []
      yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        yield* state.completeDeferred({
          flowName: TestFlow._tag,
          executionId: "completion-during-downtime",
          deferredName: "answer",
          exit: Exit.succeed("ready"),
          completedAtMs: 1
        })
        const restarted = yield* build(state, makeJournal([]), resumes)
        yield* restarted.sweepDue(TestFlow._tag)
      })))

      expect(resumes).toEqual(["completion-during-downtime:deferred"])
    }))

  it.effect("stops sweeping a completion once deferredResult has served it", () =>
    withCrypto(Effect.scoped(Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const journal = makeJournal([])
      const resumes: Array<string> = []
      const service = yield* build(state, journal, resumes)
      const address = {
        flowName: TestFlow._tag,
        executionId: "consumed-completion",
        deferredName: "answer"
      }
      const deferred = DurableDeferred.make("answer", { success: Schema.String })
      const result = service.deferredResult(deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(TestFlow, address.executionId))
      )
      expect(yield* result).toEqual(Option.none())
      yield* state.completeDeferred({ ...address, exit: Exit.succeed("ready"), completedAtMs: 1 })
      yield* service.sweepDue(TestFlow._tag)
      expect(resumes).toEqual(["consumed-completion:deferred"])
      expect(yield* result).toEqual(Option.some(Exit.succeed("ready")))
      // Point reads and replay retain the first result, including after a
      // duplicate completion. Neither operation re-arms registration recovery.
      yield* state.completeDeferred({ ...address, exit: Exit.succeed("duplicate"), completedAtMs: 2 })
      expect(yield* result).toEqual(Option.some(Exit.succeed("ready")))
      const restarted = yield* build(state, journal, resumes)
      yield* restarted.sweepDue(TestFlow._tag)
      expect(resumes).toEqual(["consumed-completion:deferred"])
    }))))

  it.effect("uses one stable wake identity across repeated registration sweeps", () =>
    Effect.gen(function*() {
      const sourceIds: Array<string> = []
      yield* withCrypto(Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        yield* state.completeDeferred({
          flowName: TestFlow._tag,
          executionId: "historical-completion",
          deferredName: "answer",
          exit: Exit.succeed("ready"),
          completedAtMs: 1
        })
        const service = yield* DeferredPersistence.make({
          owner,
          journalSource: "deferred-test",
          scheduleResume: (_flowName, _executionId, _reason, sourceId) => Effect.sync(() => sourceIds.push(sourceId!))
        }).pipe(
          Effect.provideService(DurableEngineState.DurableEngineState, state),
          Effect.provideService(Journal.Journal, makeJournal([]))
        )
        yield* service.sweepDue(TestFlow._tag)
        yield* service.sweepDue(TestFlow._tag)
      })))

      expect(sourceIds).toEqual([
        "deferred-test:wake:[\"DeferredPersistence/Test\",\"historical-completion\",\"answer\"]",
        "deferred-test:wake:[\"DeferredPersistence/Test\",\"historical-completion\",\"answer\"]"
      ])
    }))
})

describe("active-wait deferred admission on SQLite", () => {
  const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

  const seedRun = (sql: SqlClient.SqlClient, runId: string) =>
    sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        owner_host_id,
        owner_pid,
        owner_nonce,
        heartbeat_at_ms,
        state_json
      ) VALUES (
        ${runId},
        'running',
        0,
        ${owner.hostId},
        ${owner.pid},
        ${owner.nonce},
        0,
        '{}'
      )
    `.pipe(Effect.orDie, Effect.asVoid)

  it.effect("commits only the exact parked token across fresh persistence instances", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const state = yield* DurableEngineState.make
          const events: Array<string> = []
          const resumes: Array<string> = []
          const service = yield* build(state, makeJournal(events), resumes)
          const runId = "sql-approval-cas"
          const unopenedRunId = "sql-unopened-cas"
          yield* seedRun(sql, runId)
          yield* seedRun(sql, unopenedRunId)
          yield* state.park(runId, { reason: "approval", token: "attempt-1" }, owner)

          const base = {
            flowName: TestFlow._tag,
            executionId: runId,
            deferredName: "answer",
            reason: "approval",
            token: "attempt-1",
            exit: Exit.succeed("accepted")
          }
          const wrong = yield* service.deferredDoneIfWaiting({ ...base, token: "other" })
          const duplicates = yield* Effect.all([
            service.deferredDoneIfWaiting(base),
            service.deferredDoneIfWaiting({ ...base, exit: Exit.succeed("duplicate") })
          ], { concurrency: "unbounded" })
          const unopened = yield* service.deferredDoneIfWaiting({
            ...base,
            executionId: unopenedRunId
          })

          const restarted = yield* DurableEngineState.make
          return {
            wrong,
            duplicates,
            unopened,
            row: Option.getOrThrow(yield* restarted.deferred(base)),
            unopenedRow: yield* restarted.deferred({ ...base, executionId: unopenedRunId }),
            events,
            resumes
          }
        }).pipe(Effect.provide(migratedDatabase))
      ))

      expect(result.wrong).toBe("NotWaiting")
      expect([...result.duplicates].sort()).toEqual(["Completed", "Existing"])
      expect(result.unopened).toBe("NotWaiting")
      expect([Exit.succeed("accepted"), Exit.succeed("duplicate")]).toContainEqual(result.row.exit)
      expect(Option.isNone(result.unopenedRow)).toBe(true)
      expect(result.events.filter((event) => event === "emit:flows.engine.deferred-completed")).toHaveLength(1)
      expect(result.resumes).toHaveLength(2)
    }))
})

/**
 * B-08: the blast radius of a corrupt row must be that row.
 *
 * `completedDeferreds` and `pendingClocks` decoded their whole batch through
 * `Effect.orDie`, and `register` sweeps both. One unreadable row anywhere in a
 * flow's history therefore killed every registration of that flow in every
 * process: the registration died, so nothing was registered, so no run of that
 * flow ever resumed again — an operator-visible outage caused by a single row
 * nothing was going to act on anyway.
 *
 * The rows are written straight through SQL because that is the only way to
 * produce the shape: the service's own writers cannot emit one, and the point
 * is what the reader does with a row it did not write.
 */
describe("a malformed sweep row is skipped, not fatal (B-08)", () => {
  const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.sqliteLayer)

  /** A run row, so the sweep's run-status join has something live to find. */
  const seedRun = (sql: SqlClient.SqlClient, runId: string) =>
    sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES (${runId}, 'suspended', 0, '{}')
    `.pipe(Effect.orDie, Effect.asVoid)

  it.effect("registration still sweeps every readable row, and says which row it dropped", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const capture = Logger.make((options) => {
        logs.push(String(options.message))
      })
      const resumes: Array<string> = []
      const events: Array<string> = []

      yield* withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* Effect.service(SqlClient.SqlClient)
            const state = yield* DurableEngineState.make
            yield* seedRun(sql, "readable-run")
            yield* seedRun(sql, "corrupt-run")

            // Readable rows: one completion and one pending clock.
            yield* state.completeDeferred({
              flowName: TestFlow._tag,
              executionId: "readable-run",
              deferredName: "answer",
              exit: Exit.succeed("ready"),
              completedAtMs: 1
            })
            yield* sql`
            INSERT INTO flows_clock_deadlines
              (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
            VALUES (${TestFlow._tag}, 'readable-run', 'readable-clock', 'answer', 60000, NULL)
          `.pipe(Effect.orDie)

            // The corrupt pair. A BLOB satisfies the table's `length(...) > 0`
            // check and its TEXT affinity — SQLite does not coerce a blob — and
            // fails the row schema, which is what a page-level corruption or a
            // foreign writer leaves behind.
            yield* sql`
            INSERT INTO flows_deferred_completions
              (flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms)
            VALUES (${TestFlow._tag}, 'corrupt-run', x'00ff', '{}', NULL, 1)
          `.pipe(Effect.orDie)
            yield* sql`
            INSERT INTO flows_clock_deadlines
              (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
            VALUES (${TestFlow._tag}, 'corrupt-run', x'00ff', 'answer', 60000, NULL)
          `.pipe(Effect.orDie)

            const service = yield* build(state, makeJournal(events), resumes)
            yield* service.sweepDue(TestFlow._tag)
          }).pipe(
            Effect.provide(migratedDatabase),
            Effect.provide(Logger.layer([capture]))
          )
        ) as Effect.Effect<void>
      )

      // The registration survived, and every readable row was swept.
      expect(resumes).toEqual(["readable-run:deferred"])
      expect(events.filter((event) => event.endsWith("clock-scheduled"))).toEqual([
        "emit:flows.engine.clock-scheduled"
      ])
      // Both corrupt rows are named by their primary key, which is what an
      // operator needs to find and repair them.
      const warnings = logs.filter((message) => message.includes("malformed"))
      expect(warnings).toHaveLength(2)
      expect(warnings.some((message) => message.includes("deferred completion") && message.includes("corrupt-run")))
        .toBe(true)
      expect(warnings.some((message) => message.includes("clock deadline") && message.includes("corrupt-run"))).toBe(
        true
      )
    }))
})
