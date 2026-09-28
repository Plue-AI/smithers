/**
 * What a reader folding the control journal sees when a native run completes.
 *
 * Two independent writers put a module run's outcome there. The control plane
 * writes `control.run.completed` from the flow body's exit, inside the engine's
 * registered handler. The `flows.engine.run-decision` that CARRIES the output
 * is committed by the engine only after that handler returns, and copied into
 * the control journal by the follower this supervisor drives. Nothing ordered
 * the two, so a gateway folding the journal between them saw `completed` with
 * no output — `Diagnosis.resolvedOutput` is `undefined` for a module run, whose
 * only output evidence is that copied decision
 * (`gateway/src/internal/nativeResolution.ts`). Two production runs of
 * `repository-jobs/issues` differed by exactly this, and the e2e lane's
 * `expect.poll` hid it.
 *
 * `awaitSettled` is the ordering. Nothing here sleeps or races the follower's
 * poll: the follower is held inside its own read until this suite releases it,
 * and the assertion is over every prefix of the journal, which is what a fold
 * of a bounded window actually reads.
 */
import { NodeCrypto } from "@effect/platform-node"
import { RunNotFound } from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type { Service as ControlRuntime, StoredPlan } from "@smthrs/control/ControlRuntime"
import type { ControlEvent, RunSummary } from "@smthrs/control/ControlSchema"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as Diagnosis from "@smthrs/gateway/Diagnosis"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Schedule, Scope } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Projection from "../src/internal/EngineJournalProjection.ts"
import { settledKind } from "../src/internal/EngineJournalSupervisor.ts"
import * as Supervisor from "../src/internal/EngineJournalSupervisor.ts"

const runId = "root"
const planId = "approved-plan"
const output = "the scheduler owns the retry budget"

const summary: RunSummary = {
  runId,
  flowId: "repository-jobs/issues",
  status: "running",
  planId,
  createdAt: 1,
  updatedAt: 1
}

/**
 * The engine's own terminal decision, in the shape `nativeResolution` accepts.
 *
 * Every field it checks is here because the projection copies the native
 * payload verbatim: a fixture that omitted one would make the fold answer
 * `undefined` for a reason that has nothing to do with ordering.
 */
const decision = {
  decision: "transitioned",
  status: "completed",
  executionFact: {
    version: 1,
    baseline: "created",
    observation: { executionId: runId, status: "completed", flowName: "agent/run" }
  },
  state: {
    version: 1,
    flowName: "agent/run",
    payload: { runId, planId },
    result: { _tag: "Complete", exit: { _tag: "Success", value: output } }
  }
}

const controlEvents = (entries: ReadonlyArray<JournalEvent.Entry>): ReadonlyArray<ControlEvent> =>
  entries.map((entry) => ({
    runId,
    sequence: entry.seq,
    occurredAt: entry.emittedAtMs,
    kind: entry.eventType,
    payload: entry.payload as ControlEvent["payload"]
  }))

const setup = Effect.gen(function*() {
  const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const destination = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const source = Context.get(native, Journal.Journal)
  const controlJournal = Context.get(destination, Journal.Journal)
  const engineState = Context.get(native, DurableEngineState.DurableEngineState)
  const runs = Context.get(native, RunStore.RunStore)
  const sql = Context.get(native, SqlClient.SqlClient)
  const lifetime = yield* Scope.Scope
  const reached = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  // The follower's ONE read of the native journal, held open. Everything else
  // about the engine journal is the real thing, including the generation reads
  // the projection brackets its page with.
  const engineJournal: Journal.Service = {
    ...source,
    entries: (request) =>
      Effect.andThen(
        Effect.andThen(
          Effect.sync(() => Deferred.doneUnsafe(reached, Effect.void)),
          Deferred.await(release)
        ),
        source.entries(request)
      )
  }
  const control: Pick<ControlRuntime, "getRun" | "pageRunIds"> = {
    getRun: (id) => id === runId ? Effect.succeed(summary) : Effect.fail(new RunNotFound({ runId: id })),
    pageRunIds: () => Effect.succeed({ ids: [summary.runId] })
  }
  return {
    controlJournal,
    reached,
    release,
    make: (overrides: Partial<Supervisor.Options> = {}) =>
      Effect.gen(function*() {
        const scope = yield* Scope.fork(lifetime)
        const supervisor = yield* Supervisor.make({
          engineJournal,
          controlJournal,
          engineState,
          runs,
          control,
          ...overrides
        }).pipe(Effect.provideService(Scope.Scope, scope))
        return { ...supervisor, close: Scope.close(scope, Exit.void) }
      }),
    /** The native wrapper row this control run is bound to. */
    create: runs.create(
      runId,
      JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId, runId } })
    ),
    /** The engine's terminal commit: the decision, then the row it settles. */
    finish: source.transact(Effect.gen(function*() {
      yield* source.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: runId as JournalEvent.RunId,
          sourceId: "engine" as JournalEvent.SourceId,
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: "flows.engine.run-decision",
          payload: decision
        })
      )
      yield* sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = ${runId}`
    })),
    /** The control plane's own terminal write, as `AgentSession` makes it. */
    complete: controlJournal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: runId as JournalEvent.RunId,
        sourceId: "/control/executor" as JournalEvent.SourceId,
        eventType: "control.run.completed",
        payload: { runId, status: "completed" }
      })
    ),
    rows: controlJournal.entries({ runId: runId as JournalEvent.RunId, limit: 1000 }).pipe(
      Effect.map((page) => page.entries)
    )
  }
}).pipe(Effect.provide(NodeCrypto.layer))

const until = <A, E>(read: Effect.Effect<A, E>, ready: (value: A) => boolean) =>
  Effect.retry(
    read.pipe(Effect.flatMap((value) => ready(value) ? Effect.succeed(value) : Effect.fail("not observed yet"))),
    { times: 250, schedule: Schedule.spaced("20 millis") }
  ).pipe(Effect.timeout("10 seconds"))

describe("a terminal control status ordered against the native projection", () => {
  it(
    "is readable only once the copied decision that answers for the output is",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create
        const supervisor = yield* f.make()
        yield* f.controlJournal.transact(supervisor.start(runId))
        // The follower is inside its read of the native journal, so the
        // decision below cannot be copied until this suite lets it.
        yield* Deferred.await(f.reached).pipe(Effect.timeout("10 seconds"))
        yield* f.finish

        // The engine's terminal evidence exists and has not been copied. The
        // ordering must hold here, and "hold" is asserted by giving every other
        // runnable fiber the scheduler for as long as it can use it — no clock,
        // no poll interval, nothing that a loaded machine changes.
        const held = yield* Effect.raceFirst(
          Effect.as(supervisor.awaitSettled(runId), "ordering-released"),
          Effect.as(Effect.repeat(Effect.yieldNow, { times: 500 }), "ordering-held")
        )
        expect(held).toBe("ordering-held")
        expect((yield* f.rows).map((entry) => entry.eventType)).not.toContain("control.run.completed")

        const wrote = Deferred.makeUnsafe<void>()
        yield* Effect.forkScoped(
          Effect.andThen(
            supervisor.awaitSettled(runId),
            Effect.andThen(f.complete, Effect.sync(() => Deferred.doneUnsafe(wrote, Effect.void)))
          )
        )
        yield* Deferred.succeed(f.release, void 0)
        yield* Deferred.await(wrote).pipe(Effect.timeout("10 seconds"))
        yield* until(f.rows, (rows) => rows.some((entry) => entry.eventType === settledKind))

        const events = controlEvents(yield* f.rows)
        const whole = Diagnosis.digest(events)
        expect(whole.status).toBe("completed")
        expect(Diagnosis.resolvedOutput(whole)).toBe(output)
        // A reader folds a window, not the whole run, so the invariant is over
        // every prefix: none of them may report a terminal status with no
        // output to show for it.
        for (let length = 1; length <= events.length; length++) {
          const digest = Diagnosis.digest(events.slice(0, length))
          if (digest.status === "completed") expect(Diagnosis.resolvedOutput(digest)).toBe(output)
        }
      }))),
    30_000
  )

  it(
    "holds a run whose body finishes before its observation is registered",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const lifetime = yield* Scope.Scope
        yield* f.create
        // A grace long enough that only the observation can be what ends the
        // wait below. Giving up is a different outcome and records a gap.
        const supervisor = yield* f.make({ orderingGrace: Duration.minutes(5) })
        // `AgentSession.launch` releases the drive before it returns
        // `accepted`, so a module flow with no provider call reaches its own
        // terminal commit inside the launch call, and asks for this ordering
        // from there. An ordering registered after `launch` returns would have
        // nothing to hold by then.
        yield* f.finish
        const ordered = Deferred.makeUnsafe<string>()
        const released = Deferred.makeUnsafe<void>()
        const executor = ControlExecutor.makeNoop({
          launch: () =>
            Effect.gen(function*() {
              // `AgentSession.settleTerminal` asks for the ordering on its own
              // fiber, from inside the handler this launch is still in.
              yield* Effect.forkIn(
                Effect.andThen(
                  supervisor.awaitSettled(runId),
                  Effect.sync(() => Deferred.doneUnsafe(released, Effect.void))
                ),
                lifetime
              )
              const verdict = yield* Effect.raceFirst(
                Effect.as(Deferred.await(released), "ordering-released"),
                Effect.as(Effect.repeat(Effect.yieldNow, { times: 500 }), "ordering-held")
              )
              Deferred.doneUnsafe(ordered, Effect.succeed(verdict))
              return "accepted" as const
            })
        })
        yield* f.controlJournal.transact(
          supervisor.wrap(executor).launch({ run: summary, plan: {} as StoredPlan })
        )
        expect(yield* Deferred.await(ordered)).toBe("ordering-held")

        yield* Deferred.await(f.reached).pipe(Effect.timeout("10 seconds"))
        expect((yield* f.rows).map((entry) => entry.eventType)).not.toContain("control.run.completed")
        yield* Deferred.succeed(f.release, void 0)
        // The observation adopts the hold the launch registered, so the wait
        // that began before there was anything to observe is ended by the
        // settlement itself rather than by the grace running out.
        yield* Deferred.await(released).pipe(Effect.timeout("10 seconds"))
        yield* f.complete
        yield* until(f.rows, (rows) => rows.some((entry) => entry.eventType === settledKind))

        const events = controlEvents(yield* f.rows)
        expect(events.map((entry) => entry.kind)).not.toContain(Projection.gapKind)
        // The order a watcher sees. The terminal status is last, so a watch
        // closed on `projection-settled` ends one event too early.
        expect(events.map((entry) => entry.kind)).toEqual([
          Supervisor.startedKind,
          "control.engine.bound",
          Projection.eventKind,
          settledKind,
          "control.run.completed"
        ])
        const whole = Diagnosis.digest(events)
        expect(whole.status).toBe("completed")
        expect(Diagnosis.resolvedOutput(whole)).toBe(output)
        for (let length = 1; length <= events.length; length++) {
          const digest = Diagnosis.digest(events.slice(0, length))
          if (digest.status === "completed") expect(Diagnosis.resolvedOutput(digest)).toBe(output)
        }
      }))),
    30_000
  )

  it(
    "holds a resumed run whose body finishes before its observation is registered",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const lifetime = yield* Scope.Scope
        yield* f.create
        const supervisor = yield* f.make({ orderingGrace: Duration.minutes(5) })
        yield* f.finish
        const ordered = Deferred.makeUnsafe<string>()
        const released = Deferred.makeUnsafe<void>()
        const executor = ControlExecutor.makeNoop({
          // `AgentSession.resumeRun` forks the re-drive before it answers
          // `resuming`, so a resumed body reaches its terminal write from
          // inside this call, exactly as a launched one does.
          resumeRun: () =>
            Effect.gen(function*() {
              yield* Effect.forkIn(
                Effect.andThen(
                  supervisor.awaitSettled(runId),
                  Effect.sync(() => Deferred.doneUnsafe(released, Effect.void))
                ),
                lifetime
              )
              const verdict = yield* Effect.raceFirst(
                Effect.as(Deferred.await(released), "ordering-released"),
                Effect.as(Effect.repeat(Effect.yieldNow, { times: 500 }), "ordering-held")
              )
              Deferred.doneUnsafe(ordered, Effect.succeed(verdict))
              return "resuming" as const
            })
        })
        yield* f.controlJournal.transact(supervisor.wrap(executor).resumeRun({ runId }))
        expect(yield* Deferred.await(ordered)).toBe("ordering-held")

        yield* Deferred.await(f.reached).pipe(Effect.timeout("10 seconds"))
        yield* Deferred.succeed(f.release, void 0)
        yield* Deferred.await(released).pipe(Effect.timeout("10 seconds"))
        yield* f.complete
        yield* until(f.rows, (rows) => rows.some((entry) => entry.eventType === settledKind))

        const events = controlEvents(yield* f.rows)
        expect(events.map((entry) => entry.kind)).not.toContain(Projection.gapKind)
        // The same order a launched run produces: the terminal status is last,
        // so a watch closed on `projection-settled` never sees it.
        expect(events.map((entry) => entry.kind)).toEqual([
          Supervisor.startedKind,
          "control.engine.bound",
          Projection.eventKind,
          settledKind,
          "control.run.completed"
        ])
        const whole = Diagnosis.digest(events)
        expect(whole.status).toBe("completed")
        expect(Diagnosis.resolvedOutput(whole)).toBe(output)
        for (let length = 1; length <= events.length; length++) {
          const digest = Diagnosis.digest(events.slice(0, length))
          if (digest.status === "completed") expect(Diagnosis.resolvedOutput(digest)).toBe(output)
        }
      }))),
    30_000
  )

  it(
    "releases a hold whose host goes away before anything observes the run",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const lifetime = yield* Scope.Scope
        yield* f.create
        const supervisor = yield* f.make({ orderingGrace: Duration.minutes(5) })
        const released = Deferred.makeUnsafe<void>()
        const holding = Deferred.makeUnsafe<void>()
        const proceed = Deferred.makeUnsafe<void>()
        const executor = ControlExecutor.makeNoop({
          launch: () =>
            Effect.gen(function*() {
              yield* Effect.forkIn(
                Effect.andThen(
                  supervisor.awaitSettled(runId),
                  Effect.sync(() => Deferred.doneUnsafe(released, Effect.void))
                ),
                lifetime
              )
              // The launch is still in flight, so nothing has admitted this
              // run: the hold it registered is the only thing holding.
              yield* Effect.repeat(Effect.yieldNow, { times: 100 })
              Deferred.doneUnsafe(holding, Effect.void)
              yield* Deferred.await(proceed)
              return "accepted" as const
            })
        })
        const launched = yield* Effect.forkScoped(
          f.controlJournal.transact(supervisor.wrap(executor).launch({ run: summary, plan: {} as StoredPlan }))
        )
        yield* Deferred.await(holding).pipe(Effect.timeout("10 seconds"))
        expect(
          yield* Effect.raceFirst(
            Effect.as(Deferred.await(released), "ordering-released"),
            Effect.as(Effect.repeat(Effect.yieldNow, { times: 500 }), "ordering-held")
          )
        ).toBe("ordering-held")

        // No observation ever adopted this hold, so no observation's death can
        // end it. A run still owes a terminal status when its host goes away.
        yield* supervisor.close
        yield* Deferred.await(released).pipe(Effect.timeout("10 seconds"))
        yield* Deferred.succeed(proceed, void 0)
        yield* Fiber.await(launched).pipe(Effect.timeout("10 seconds"))
      }))),
    30_000
  )

  it(
    "releases when the observation it waits for dies with its host",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create
        const supervisor = yield* f.make()
        yield* f.controlJournal.transact(supervisor.start(runId))
        yield* Deferred.await(f.reached).pipe(Effect.timeout("10 seconds"))

        // The follower is still held, so nothing will ever settle. Closing the
        // supervisor's scope is what a host going away does, and a run whose
        // observer has gone must still be able to end.
        const waiting = yield* Effect.forkScoped(supervisor.awaitSettled(runId))
        yield* supervisor.close
        const exit = yield* Fiber.await(waiting).pipe(Effect.timeout("10 seconds"))

        expect(Exit.isSuccess(exit)).toBe(true)
      }))),
    30_000
  )

  it(
    "names what it waited for when the projection never settles",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        yield* f.create
        const supervisor = yield* f.make({ orderingGrace: Duration.millis(1) })
        yield* f.controlJournal.transact(supervisor.start(runId))
        yield* Deferred.await(f.reached).pipe(Effect.timeout("10 seconds"))

        // The follower is held, so nothing will settle. A run still ends, and
        // the journal says which wait gave up rather than leaving a gap nobody
        // can name.
        yield* supervisor.awaitSettled(runId).pipe(Effect.timeout("10 seconds"))
        yield* f.complete

        const gaps = (yield* f.rows).filter((entry) => entry.eventType === Projection.gapKind)
        expect(gaps.map((entry) => (entry.payload as { phase?: unknown }).phase)).toContain("terminal-ordering")
        expect(String((gaps.at(-1)?.payload as { detail?: unknown }).detail)).toContain(settledKind)
      }))),
    30_000
  )

  it(
    "holds nothing for a run this process is not observing",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const f = yield* setup
        const supervisor = yield* f.make()

        yield* supervisor.awaitSettled("a-run-nobody-here-observes").pipe(
          Effect.timeout("10 seconds"),
          Effect.orDie
        )
      }))),
    30_000
  )
})
