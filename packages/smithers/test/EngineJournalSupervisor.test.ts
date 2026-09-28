import { NodeCrypto } from "@effect/platform-node"
import { LaunchFailed, PersistenceError, RunNotFound } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type { Service as ControlRuntime, StoredPlan } from "@smthrs/control/ControlRuntime"
import type { RunSummary } from "@smthrs/control/ControlSchema"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Context, Deferred, Effect, Exit, Layer, Option, Schedule, Scope } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Projection from "../src/internal/EngineJournalProjection.ts"
import * as Supervisor from "../src/internal/EngineJournalSupervisor.ts"

const summary = (id = "root", status: RunSummary["status"] = "running"): RunSummary => ({
  runId: id,
  flowId: "coding/ImplementPlan",
  status,
  planId: "approved-plan",
  createdAt: 1,
  updatedAt: 1
})
const input = (run: RunSummary): ControlExecutor.Launch => ({ run, plan: {} as StoredPlan })
const setup = Effect.gen(function*() {
  const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const destination = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const engineJournal = Context.get(native, Journal.Journal)
  const controlJournal = Context.get(destination, Journal.Journal)
  const engineState = Context.get(native, DurableEngineState.DurableEngineState)
  const runs = Context.get(native, RunStore.RunStore)
  const sql = Context.get(native, SqlClient.SqlClient)
  const controls = new Map<string, RunSummary>([["root", summary()]])
  const control: Pick<ControlRuntime, "getRun" | "pageRunIds"> = {
    getRun: (id) =>
      Effect.suspend(() => {
        const run = controls.get(id)
        return run === undefined ? Effect.fail(new RunNotFound({ runId: id })) : Effect.succeed(run)
      }),
    pageRunIds: () => Effect.sync(() => ({ ids: [...controls.keys()] }))
  }
  const options = { engineJournal, controlJournal, engineState, runs, control }
  const lifetime = yield* Scope.Scope
  return {
    ...options,
    sql,
    controlSql: Context.get(destination, SqlClient.SqlClient),
    controls,
    make: (overrides: Partial<Supervisor.Options> = {}) =>
      Effect.gen(function*() {
        const scope = yield* Scope.fork(lifetime)
        const supervisor = yield* Supervisor.make({ ...options, ...overrides }).pipe(
          Effect.provideService(Scope.Scope, scope)
        )
        return { ...supervisor, close: Scope.close(scope, Exit.void) }
      }),
    create: (id = "root", planId = "approved-plan", parentExecutionId?: string, flowName = "agent/run") =>
      runs.create(
        id,
        JSON.stringify({
          version: 1,
          flowName,
          payload: { planId, runId: "copied-old-fork-input" },
          ...(parentExecutionId === undefined ? {} : { parentExecutionId })
        })
      ),
    finish: (id = "root") =>
      engineJournal.transact(Effect.gen(function*() {
        yield* engineJournal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: id as JournalEvent.RunId,
            sourceId: "result" as JournalEvent.SourceId,
            sourceSeq: 0 as JournalEvent.SourceSeq,
            eventType: "flows.engine.run-decision",
            payload: { actualResult: id }
          })
        )
        yield* sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = ${id}`
      })),
    /** One native record of a given kind, as the engine would journal it. */
    native: (eventType: string, payload: unknown, sourceId: string, id = "root") =>
      engineJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: id as JournalEvent.RunId,
          sourceId: sourceId as JournalEvent.SourceId,
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType,
          payload
        })
      ),
    rows: (id = "root") =>
      controlJournal.entries({ runId: id as JournalEvent.RunId, limit: 1000 }).pipe(
        Effect.map((page) => page.entries.filter((entry) => entry.eventType !== "control.engine.bound"))
      )
  }
}).pipe(Effect.provide(NodeCrypto.layer))

const until = <A, E>(read: Effect.Effect<A, E>, ready: (value: A) => boolean) =>
  Effect.retry(
    read.pipe(Effect.flatMap((value) => ready(value) ? Effect.succeed(value) : Effect.fail("not observed yet"))),
    { times: 250, schedule: Schedule.spaced("20 millis") }
  ).pipe(Effect.timeout("10 seconds"))
const isSettled = (rows: ReadonlyArray<JournalEvent.Entry>) =>
  rows.some((entry) => entry.eventType === Supervisor.settledKind)

describe("private native journal supervision", () => {
  it(
    "retains the admission transaction for control reads while native reads and following use the clean host",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        yield* f.finish()
        const controlReads: Array<boolean> = []
        const nativeReads: Array<boolean> = []
        const supervisor = yield* f.make({
          control: {
            ...f.control,
            getRun: (id) =>
              Effect.gen(function*() {
                controlReads.push(Option.isSome(yield* Effect.serviceOption(f.controlSql.transactionService)))
                return yield* f.control.getRun(id)
              })
          },
          runs: {
            get: (id) =>
              Effect.gen(function*() {
                nativeReads.push(Option.isSome(yield* Effect.serviceOption(f.controlSql.transactionService)))
                return yield* f.runs.get(id)
              })
          }
        })
        yield* f.controlJournal.transact(supervisor.start("root"))
        yield* until(f.rows(), isSettled)
        expect(controlReads[0]).toBe(true)
        expect(controlReads.slice(1).every((inside) => !inside)).toBe(true)
        expect(nativeReads.every((inside) => !inside)).toBe(true)
      }))),
    30_000
  )

  it(
    "rebuilds a flow whose entry file a run applied, and none whose bundle only proposed one",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        const bundle = (identity: string, overrides: Record<string, unknown> = {}) => ({
          runId: "root",
          stepKeyDigest: "digest-1",
          attempt: 1,
          bundleIdentity: identity,
          ...overrides
        })
        // One bundle that touched a registry entry and reached the host.
        yield* f.native(
          "flows.engine.diff-bundle-captured",
          bundle("applied", { changedPaths: ["flows/authored/flow.ts"] }),
          "captured-applied"
        )
        yield* f.native("flows.engine.copy-back-settled", bundle("applied", { rebases: 0 }), "settled-applied")
        // One that proposed the same kind of change and never settled: an
        // attempt that failed, or a bundle that lost its rebase. Acting on it
        // would rebuild a catalog from bytes no run ever applied.
        yield* f.native(
          "flows.engine.diff-bundle-captured",
          bundle("proposed", { changedPaths: ["flows/proposed/flow.ts"] }),
          "captured-proposed"
        )
        yield* f.finish()

        const rebuilt: Array<string> = []
        const supervisor = yield* f.make({
          onSourceApplied: (flowId) => Effect.sync(() => void rebuilt.push(flowId))
        })
        yield* f.controlJournal.transact(supervisor.start("root"))
        yield* until(f.rows(), isSettled)

        expect(rebuilt).toEqual(["authored"])
      }))),
    30_000
  )

  it(
    "deduplicates the same refusal despite changing process stack traces",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        let incarnation = 0
        const source: Journal.Service = {
          ...f.engineJournal,
          generation: () =>
            Effect.suspend(() => {
              const error = new Journal.JournalError({ code: "read_failed", message: "native store unavailable" })
              error.stack = `different process stack ${incarnation++}`
              return Effect.fail(error)
            })
        }
        const first = yield* f.make({ engineJournal: source })
        yield* first.start("root")
        const recorded = yield* f.rows()
        yield* first.close
        const restarted = yield* f.make({ engineJournal: source })
        yield* restarted.recover
        expect(yield* f.rows()).toEqual(recorded)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]?.payload).toMatchObject({ detail: "read_failed: native store unavailable" })
      }))),
    30_000
  )

  it(
    "a previously observed row removed after a rewind produces a gap with the freshly observed generation",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        const reading = yield* Deferred.make<void>()
        const supervisor = yield* f.make({
          engineJournal: {
            ...f.engineJournal,
            entries: (options) =>
              f.engineJournal.entries(options).pipe(Effect.tap(() => Deferred.succeed(reading, undefined)))
          }
        })
        yield* supervisor.start("root")
        yield* Deferred.await(reading)
        yield* f.engineJournal.transact(Effect.gen(function*() {
          yield* f.sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('root', 1, -1)`
          yield* f.sql`DELETE FROM flows_runs WHERE run_id = 'root'`
          yield* f.engineJournal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: "root" as JournalEvent.RunId,
              sourceId: "retention" as JournalEvent.SourceId,
              eventType: "fixture.retention",
              payload: null
            })
          )
        }))
        const rows = yield* until(f.rows(), (entries) =>
          entries.some((entry) =>
            entry.eventType === Projection.gapKind && (entry.payload as { phase?: string }).phase === "follow"
          ))
        expect(
          rows.find((entry) =>
            (entry.payload as { phase?: string }).phase === "follow"
          )?.payload
        ).toMatchObject({
          generation: 1,
          detail: "decode_failed: Native lineage omitted its requested member"
        })
        expect(isSettled(rows)).toBe(false)
      }))),
    30_000
  )

  it(
    "records a gap when accepted control work settles before any native wrapper exists",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        f.controls.set("root", summary("root", "failed"))
        const supervisor = yield* f.make()
        yield* supervisor.start("root")
        const rows = yield* until(
          f.rows(),
          (entries) => entries.some((entry) => entry.eventType === Projection.gapKind)
        )
        expect(rows.map((row) => row.eventType)).toEqual([Supervisor.startedKind, Projection.gapKind])
        expect(rows[1]?.payload).toMatchObject({
          phase: "native-root",
          detail: "Control run settled without a native wrapper"
        })
      }))),
    30_000
  )

  it(
    "a new native rewind generation gets its own observation and result after an earlier generation settled",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        yield* f.finish()
        const supervisor = yield* f.make()
        yield* supervisor.start("root")
        yield* until(f.rows(), isSettled)
        yield* f.engineJournal.transact(Effect.gen(function*() {
          yield* f.sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('root', 1, -1)`
          yield* f.sql`UPDATE flows_journal_events SET payload_json = ${
            JSON.stringify({ actualResult: "rewritten" })
          } WHERE run_id = 'root' AND seq = 0`
        }))
        yield* supervisor.start("root")
        const rows = yield* until(
          f.rows(),
          (entries) => entries.filter((entry) => entry.eventType === Supervisor.settledKind).length === 2
        )
        expect(rows.filter((row) => row.eventType === Supervisor.startedKind).map((row) => row.payload)).toEqual([
          { version: 1, executionId: "root", generation: 0 },
          { version: 1, executionId: "root", generation: 1 }
        ])
        expect(
          rows.filter((row) => row.eventType === Projection.eventKind).map((row) => row.payload)
        ).toMatchObject([
          { generation: 0, payload: { actualResult: "root" } },
          { generation: 1, payload: { actualResult: "rewritten" } }
        ])
      }))),
    30_000
  )

  it(
    "records started before accepted returns, preserves control completion, and settles after the real native terminal drain",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        const supervisor = yield* f.make()
        const executor = supervisor.wrap(ControlExecutor.makeNoop({ launch: () => Effect.succeed("accepted") }))
        expect(yield* executor.launch(input(summary()))).toBe("accepted")
        expect((yield* f.rows()).map((row) => row.eventType)).toEqual([Supervisor.startedKind])
        f.controls.set("root", summary("root", "completed"))
        yield* Effect.yieldNow
        expect(isSettled(yield* f.rows())).toBe(false)
        yield* f.finish()
        const rows = yield* until(f.rows(), isSettled)
        expect(rows.map((row) => row.eventType)).toEqual([
          Supervisor.startedKind,
          Projection.eventKind,
          Supervisor.settledKind
        ])
        expect(rows[1]?.payload).toMatchObject({ payload: { actualResult: "root" } })
        expect(rows[2]?.payload).toEqual({ version: 1, executionId: "root", generation: 0 })
      }))),
    30_000
  )

  it(
    "starts after commit in a clean host context, and a rolled-back admission starts no follower",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        yield* f.finish()
        const supervisor = yield* f.make()
        const rolledBack = yield* Effect.result(f.controlJournal.transact(
          supervisor.start("root").pipe(
            Effect.andThen(Effect.fail("rollback admission"))
          )
        ))
        expect(rolledBack._tag).toBe("Failure")
        expect(yield* f.rows()).toEqual([])
        yield* f.controlJournal.transact(Effect.gen(function*() {
          yield* supervisor.start("root")
          expect((yield* f.rows()).map((row) => row.eventType)).toEqual([Supervisor.startedKind])
        }))
        const rows = yield* until(f.rows(), isSettled)
        expect(rows.map((row) => row.eventType)).toEqual([
          Supervisor.startedKind,
          Projection.eventKind,
          Supervisor.settledKind
        ])
      }))),
    30_000
  )

  it(
    "does not create observations for pending or rejected delegate launches",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const supervisor = yield* f.make()
        expect(yield* supervisor.wrap(ControlExecutor.makeNoop()).launch(input(summary()))).toBe("pending")
        const refusal = new LaunchFailed({ runId: "root", message: "module not registered" })
        const rejected = yield* Effect.result(
          supervisor.wrap(ControlExecutor.makeNoop({ launch: () => Effect.fail(refusal) })).launch(input(summary()))
        )
        expect(rejected).toMatchObject({ _tag: "Failure", failure: refusal })
        expect(yield* f.rows()).toEqual([])
        // A launch holds this run's terminal ordering from before the executor
        // runs. Neither of these produced a run to observe, so neither may
        // leave a terminal write waiting out the grace for an observation that
        // is never going to start.
        expect(
          yield* Effect.raceFirst(
            Effect.as(supervisor.awaitSettled("root"), "ordering-released"),
            Effect.as(Effect.repeat(Effect.yieldNow, { times: 500 }), "ordering-held")
          )
        ).toBe("ordering-released")
      }))),
    30_000
  )

  it(
    "does not create observations for resumes this executor does not take up",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const supervisor = yield* f.make()
        expect(yield* supervisor.wrap(ControlExecutor.makeNoop()).resumeRun({ runId: "root" })).toBe("unknown")
        const refusal = new PersistenceError({ operation: "resumeRun", message: "the engine row could not be read" })
        const rejected = yield* Effect.result(
          supervisor.wrap(ControlExecutor.makeNoop({ resumeRun: () => Effect.fail(refusal) })).resumeRun({
            runId: "root"
          })
        )
        expect(rejected).toMatchObject({ _tag: "Failure", failure: refusal })
        expect(yield* f.rows()).toEqual([])
        // A resume holds the ordering from before the executor runs, for the
        // launch's reason. Neither of these re-drives anything here.
        expect(
          yield* Effect.raceFirst(
            Effect.as(supervisor.awaitSettled("root"), "ordering-released"),
            Effect.as(Effect.repeat(Effect.yieldNow, { times: 500 }), "ordering-held")
          )
        ).toBe("ordering-released")
      }))),
    30_000
  )

  it(
    "waits for the admitted native wrapper and refuses same-ID foreign or child rows without copying their data",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const supervisor = yield* f.make()
        yield* supervisor.start("root")
        expect((yield* f.rows()).map((row) => row.eventType)).toEqual([Supervisor.startedKind])
        yield* f.create()
        yield* f.finish()
        yield* until(f.rows(), isSettled)
        for (
          const [id, plan, parent, flow] of [
            ["wrong-plan", "foreign", undefined, "agent/run"],
            ["wrong-flow", "approved-plan", undefined, "private/data"],
            ["child", "approved-plan", "other", "agent/run"],
            ["edge-only-child", "approved-plan", undefined, "agent/run"]
          ] as const
        ) {
          f.controls.set(id, summary(id, "completed"))
          yield* f.create(id, plan, parent, flow)
          if (id === "edge-only-child") yield* f.engineState.recordRunParent(id, "other")
          yield* f.finish(id)
          yield* supervisor.start(id)
          const rows = yield* f.rows(id)
          expect(rows.some((row) => row.eventType === Projection.eventKind)).toBe(false)
          expect(rows.map((row) => row.eventType)).toEqual([Projection.gapKind])
        }
      }))),
    30_000
  )

  it(
    "recovers terminal native/control roots with no marker, then skips settled generations without replaying source pages",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        yield* f.finish()
        f.controls.set("root", summary("root", "completed"))
        f.controls.set("control-only", summary("control-only", "accepted"))
        let reads = 0
        const source = {
          ...f.engineJournal,
          entries: (options: Journal.EntriesOptions) =>
            f.engineJournal.entries(options).pipe(Effect.tap(() => {
              reads++
              return Effect.void
            }))
        }
        const first = yield* f.make({ engineJournal: source })
        yield* first.recover
        const rows = yield* until(f.rows(), isSettled)
        expect(yield* f.rows("control-only")).toEqual([])
        yield* first.close
        const previousReads = reads
        const restarted = yield* f.make({ engineJournal: source })
        yield* restarted.recover
        expect(yield* f.rows()).toEqual(rows)
        expect(reads).toBe(previousReads)
      }))),
    30_000
  )

  it(
    "scope shutdown leaves pending observation for restart, without inventing a failure gap",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        const first = yield* f.make()
        yield* Effect.all([first.start("root"), first.start("root")], { concurrency: 2 })
        yield* first.close
        expect((yield* f.rows()).map((row) => row.eventType)).toEqual([Supervisor.startedKind])
        yield* f.finish()
        const restarted = yield* f.make()
        yield* restarted.recover
        const rows = yield* until(f.rows(), isSettled)
        expect(rows.map((row) => row.eventType)).toEqual([
          Supervisor.startedKind,
          Projection.eventKind,
          Supervisor.settledKind
        ])
      }))),
    30_000
  )

  it(
    "preserves accepted execution on marker failure and recovers it from actual native state",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create()
        const faulty: Journal.Service = {
          ...f.controlJournal,
          emitDurableUnfenced: (entry) =>
            entry.eventType === Supervisor.startedKind
              ? Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "marker write refused" }))
              : f.controlJournal.emitDurableUnfenced(entry)
        }
        const first = yield* f.make({ controlJournal: faulty })
        const executor = first.wrap(ControlExecutor.makeNoop({ launch: () => Effect.succeed("accepted") }))
        expect(yield* executor.launch(input(summary()))).toBe("accepted")
        expect((yield* f.rows()).map((row) => row.eventType)).toEqual([Projection.gapKind])
        yield* f.finish()
        const restarted = yield* f.make()
        yield* restarted.recover
        expect((yield* until(f.rows(), isSettled)).map((row) => row.eventType)).toEqual([
          Projection.gapKind,
          Supervisor.startedKind,
          Projection.eventKind,
          Supervisor.settledKind
        ])
      }))),
    30_000
  )
})
