/**
 * Private host lifetime for the existing native-to-control journal projection.
 * @since 1.0.0
 */

import type * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type * as ControlRuntime from "@smthrs/control/ControlRuntime"
import type { RunSummary } from "@smthrs/control/ControlSchema"
import * as Sha256 from "@smthrs/crypto/Sha256"
import type * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { RunState } from "@smthrs/engine-store/RunState"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Deferred, Duration, Effect, Fiber, Option, Schema, Scope, Semaphore } from "effect"
import * as AuthoredSources from "./AuthoredSources.ts"
import * as Projection from "./EngineJournalProjection.ts"

/**
 * Existing host services retained by the observer.
 * @since 1.0.0
 * @private
 */
export interface Options {
  readonly engineJournal: Journal.Service
  readonly controlJournal: Journal.Service
  readonly engineState: Pick<DurableEngineState.Service, "runChildren" | "runParents">
  readonly runs: Pick<RunStore.Service, "get"> & Partial<Pick<RunStore.Service, "lineage">>
  readonly control: Pick<ControlRuntime.Service, "getRun" | "listRuns">
  /** Overrides {@link orderingGrace}; a suite with no follower to wait for shortens it. */
  readonly orderingGrace?: Duration.Duration | undefined
  /**
   * Called with each discovered flow whose registry entry file a settled
   * copy-back applied, as the observation copies that record across.
   *
   * This is the host's one notice that its own `flows/` directory changed
   * under it. A native host's executable catalog is built once at startup, so
   * without it a flow an agent authors mid-run has a descriptor and no
   * executable: `flow.plan` answers `FlowNotFound` or a plan with no nodes
   * until the host is restarted. The observer already reads every native
   * record for the projection, so nothing new is opened to see this.
   *
   * A capture alone never fires it: see {@link module:AuthoredSources}.
   */
  readonly onSourceApplied?: ((flowId: string) => Effect.Effect<void>) | undefined
}

/**
 * Durable start of observing one native generation.
 * @since 1.0.0
 * @private
 */
export const startedKind = "control.engine.projection-started"
/**
 * Observation drained after native root terminal commit.
 * @since 1.0.0
 * @private
 */
export const settledKind = "control.engine.projection-settled"

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(RunState))
const decodeMarker = Schema.decodeUnknownOption(Schema.Struct({
  version: Schema.Literal(1),
  executionId: Schema.String,
  generation: Schema.Number
}))
const producer = (identity: ReadonlyArray<unknown>): JournalEvent.SourceId =>
  `engine-observation:${Sha256.digestSync(JSON.stringify(identity))}` as JournalEvent.SourceId
const terminalControl = new Set(["completed", "failed", "cancelled"])

/**
 * How long a terminal control write waits for this run's projection before it
 * proceeds anyway, naming in the journal what it waited for.
 *
 * Every ordinary release is prompt: the wait ends on the observation itself,
 * and an observation ends when it settles, when it records a gap, and when its
 * fiber is interrupted with the host scope. The bound exists for the one case
 * none of those cover — a wedged store holding the follower open — so that a
 * stuck projection costs a late terminal status rather than a run that never
 * ends.
 */
const orderingGrace = Duration.seconds(30)
const orderingPhase = "terminal-ordering"

/**
 * The generation of a hold a launch registered and no observation has adopted.
 *
 * Below every real generation, so an admission that arrives later adopts the
 * hold rather than reading it as a newer observer it must not replace.
 */
const unobserved = -1

/**
 * Construct in the host scope, outside an admission transaction. No new service,
 * table or checkpoint: recovery reads native wrapper identity and existing markers.
 * @since 1.0.0
 * @private
 */
export const make = (options: Options) =>
  Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const host = yield* Effect.context<never>()
    const gate = yield* Semaphore.make(1)
    interface Active {
      /** {@link unobserved} until an observation adopts this hold. */
      readonly generation: number
      /** Completed when this observation ends, however it ends. */
      readonly ended: Deferred.Deferred<void>
      fiber?: Fiber.Fiber<void, never>
    }
    const active = new Map<string, Active>()
    const runId = (id: string) => id as JournalEvent.RunId

    /** Ends a hold, whether or not an observation ever adopted it. */
    const release = (id: string, entry: Active | undefined) =>
      Effect.sync(() => {
        if (entry === undefined) return
        if (active.get(id) === entry) active.delete(id)
        Deferred.doneUnsafe(entry.ended, Effect.void)
      })

    /**
     * Registers a run's hold before anything observes it.
     *
     * Nothing when this run is already held: an observation in progress is the
     * stronger hold, and replacing it would orphan its fiber.
     */
    const hold = (id: string) =>
      Effect.gen(function*() {
        if (active.has(id)) return undefined
        const entry: Active = { generation: unobserved, ended: yield* Deferred.make<void>() }
        active.set(id, entry)
        return entry
      })

    // An unadopted hold has no fiber whose interruption would end it, so the
    // host going away between a launch and its admission must end it here.
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        for (const [id, entry] of [...active]) {
          if (entry.fiber === undefined) {
            active.delete(id)
            Deferred.doneUnsafe(entry.ended, Effect.void)
          }
        }
      })
    )

    // Native reads must not accidentally reuse the caller's control SQL
    // transaction. Supplying a different Journal service alone does not remove it.
    const isolated = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        Effect.sync(() => Effect.runForkWith(host)(effect)),
        Fiber.join,
        Fiber.interrupt
      )

    const emit = (id: string, generation: number, kind: string) =>
      options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: runId(id),
          sourceId: producer([id, generation, kind]),
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: kind,
          payload: { version: 1, executionId: id, generation }
        })
      )
    const gap = (id: string, generation: number | null, phase: string, cause: unknown) => {
      const payload = { executionId: id, generation, phase, reason: "observation-failed", detail: String(cause) }
      return options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: runId(id),
          sourceId: producer(["gap", payload]),
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: Projection.gapKind,
          payload
        })
      ).pipe(Effect.asVoid)
    }
    const report = (id: string, generation: number | null, phase: string, cause: Cause.Cause<unknown>) => {
      const failure = Cause.squash(cause)
      const code = typeof failure === "object" && failure !== null && "code" in failure
        ? String(failure.code)
        : "unknown"
      const detail = failure instanceof Error
        ? failure.message
        : typeof failure === "string"
        ? failure
        : "Unexpected observation failure"
      // Both producer identity and payload stay stable across processes. Putting
      // changing stacks under a stable producer would cause idempotency conflicts.
      return Cause.hasInterruptsOnly(cause) ? Effect.void : gap(id, generation, phase, `${code}: ${detail}`).pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("Engine observation could not be recorded", {
            runId: id,
            generation,
            phase,
            cause: Cause.pretty(cause),
            recordingFailure: Cause.pretty(failure)
          })
        )
      )
    }

    const nativeRoot = (id: string, control: RunSummary) =>
      options.engineJournal.transact(Effect.gen(function*() {
        const generation = options.engineJournal.generation === undefined ?
          0 :
          (yield* options.engineJournal.generation(runId(id))).generation
        const found = yield* Effect.result(options.runs.get(id))
        if (found._tag === "Failure") {
          if (found.failure.code === "not_found_row") return { generation, control, row: undefined }
          return yield* Effect.fail(found.failure)
        }
        const decoded = decodeState(found.success.stateJson)
        const state = Option.getOrUndefined(decoded)
        const payload = state?.payload as { readonly planId?: unknown } | null | undefined
        if (
          state?.flowName !== "agent/run" || control.planId === undefined || payload?.planId !== control.planId ||
          state.parentExecutionId !== undefined || (yield* options.engineState.runParents(id)).length !== 0
        ) {
          return yield* Effect.fail(
            new Journal.JournalError({
              code: "decode_failed",
              message: "Native execution is not the control run's recorded wrapper"
            })
          )
        }
        // Forks legitimately copy payload.runId and have row.parentRunId. Neither
        // is the identity of this wrapper; the native row and plan association are.
        return { generation, control, row: found.success }
      }))
    const root = (id: string) => options.control.getRun(id).pipe(Effect.flatMap((control) => nativeRoot(id, control)))

    const settled = (id: string, generation: number) =>
      Effect.gen(function*() {
        let after: JournalEvent.Seq | undefined
        for (;;) {
          const page = yield* options.controlJournal.entries({
            runId: runId(id),
            ...(after === undefined ? {} : { after }),
            limit: 256
          })
          for (const entry of page.entries) {
            if (entry.eventType !== settledKind) continue
            const marker = decodeMarker(entry.payload)
            if (Option.isSome(marker) && marker.value.executionId === id && marker.value.generation === generation) {
              return true
            }
          }
          if (!page.hasMore) return false
          const last = page.entries.at(-1)
          if (last === undefined || (after !== undefined && last.seq <= after)) {
            return yield* Effect.fail(
              new Journal.JournalError({ code: "decode_failed", message: "Observation history did not advance" })
            )
          }
          after = last.seq
        }
      })

    const observe = (id: string, initialGeneration: number) =>
      Effect.gen(function*() {
        let generation = initialGeneration
        // A launch can be accepted before its independent native driver creates the
        // row. Do not copy any source evidence until real wrapper identity is known.
        for (;;) {
          const current = yield* root(id)
          if (current.row !== undefined) break
          if (terminalControl.has(current.control.status)) {
            return yield* gap(id, current.generation, "native-root", "Control run settled without a native wrapper")
          }
          yield* Effect.sleep("1 second")
        }
        // One matcher per observation: a bundle captured under an attempt can
        // only settle under that same attempt, and a recovered observation
        // rereads both halves from the journal rather than inheriting them.
        const applied = AuthoredSources.make()
        const onSourceApplied = options.onSourceApplied
        const projection = yield* Projection.make({
          ...options,
          runLineage: options.runs.lineage,
          controlRunId: id,
          executionId: id,
          ...(onSourceApplied === undefined ? {} : {
            onRecord: (entry, generation) =>
              Effect.forEach(applied.observe(entry, generation), onSourceApplied, { discard: true })
          })
        })
        for (;;) {
          const before = yield* root(id)
          if (before.row === undefined) {
            return yield* gap(id, before.generation, "native-root", "Previously observed native wrapper was removed")
          }
          if (before.generation !== generation) {
            generation = before.generation
            yield* emit(id, generation, startedKind)
          }
          yield* projection.followUntilSettled({
            get: (runId) =>
              options.runs.get(runId).pipe(Effect.catch((error) =>
                error.code === "not_found_row"
                  ? Effect.fail(
                    new RunStore.RunStoreError({
                      code: "invalid_run",
                      method: "get",
                      message: "Previously observed native wrapper was removed",
                      cause: error
                    })
                  )
                  : Effect.fail(error)
              ))
          })
          const after = yield* root(id)
          if (after.row === undefined) {
            return yield* gap(id, after.generation, "native-root", "Previously observed native wrapper was removed")
          }
          if (after.generation !== generation || !RunStore.isTerminalRunStatus(after.row.status)) {
            continue
          }
          // followUntilSettled observed the native terminal commit and drained again.
          yield* emit(id, generation, settledKind)
          return
        }
      }).pipe(Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void
        if (options.engineJournal.generation === undefined) return report(id, 0, "follow", cause)
        return Effect.flatMap(
          Effect.result(options.engineJournal.generation(runId(id))),
          (current) => report(id, current._tag === "Success" ? current.success.generation : null, "follow", cause)
        )
      }))

    const begin = (id: string, generation: number) =>
      gate.withPermits(1)(Effect.gen(function*() {
        const previous = active.get(id)
        // A delayed older admission callback must not replace a newer observer.
        if (previous !== undefined && previous.generation >= generation) return
        if (previous?.fiber !== undefined) yield* Fiber.interrupt(previous.fiber)
        // A hold the launch registered belongs to this observation: the caller
        // waiting on it is the terminal write this observation has to precede,
        // and it began waiting before there was anything to observe.
        const entry: Active = {
          generation,
          ended: previous !== undefined && previous.fiber === undefined
            ? previous.ended
            : yield* Deferred.make<void>()
        }
        active.set(id, entry)
        entry.fiber = yield* Effect.forkIn(
          // The release is in the finalizer, not after `observe`, because a
          // caller held by {@link awaitSettled} must also be released when this
          // fiber is interrupted or dies — otherwise a supervisor that goes away
          // leaves the run it was observing with no terminal status at all.
          observe(id, generation).pipe(Effect.ensuring(release(id, entry))),
          scope
        )
      }))

    /** Answers whether an observation is on its way to adopt {@link hold}'s entry. */
    const admit = (id: string, allowMissing: boolean, pending?: Active) =>
      Effect.gen(function*() {
        // This row can still be uncommitted in the admission transaction.
        // Keep its read in the caller's control context; isolate native reads only.
        const control = yield* options.control.getRun(id)
        const native = yield* isolated(nativeRoot(id, control))
        if (native.row === undefined && !allowMissing) return false
        if (yield* settled(id, native.generation)) return false
        yield* emit(id, native.generation, startedKind)
        const registered = yield* options.controlJournal.whenCommitted(Effect.sync(() => {
          // Short callback only. Both the registration job and follower belong to
          // the captured host scope and cannot inherit the admission transaction.
          Effect.runForkWith(host)(Effect.forkIn(begin(id, native.generation), scope))
        }))
        if (!registered) {
          yield* gap(id, native.generation, "commit", "Caller transaction has no observable commit boundary")
          return false
        }
        return true
      }).pipe(
        Effect.catchCause((cause) => Effect.as(report(id, null, "admission", cause), false)),
        // Nothing is coming to adopt the launch's hold, so the terminal write
        // waiting on it would wait out the grace for an observation that will
        // never start.
        Effect.tap((adopting) => adopting ? Effect.void : release(id, pending))
      )

    /**
     * Holds one terminal control write until this run's native evidence has
     * been copied into the control journal.
     *
     * The control plane writes `control.run.completed` from the flow body's
     * exit, inside the engine's registered handler; the `flows.engine.run-decision`
     * that CARRIES the run's output is committed only after that handler
     * returns, and copied here after that. A reader folding the control journal
     * between the two saw `completed` with no output — two production runs of
     * `repository-jobs/issues` differed by exactly that. This is the wait that
     * closes the gap.
     *
     * The caller must not hold the engine's handler open on it. What this waits
     * for is the native terminal commit, which only that handler's return
     * produces, so awaiting it in the handler would be the run waiting for
     * itself. `AgentSession` writes the status on its own fiber for that reason.
     *
     * A run this process does not observe has nothing to order against and is
     * not held at all.
     */
    const awaitSettled = (id: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(id)
        if (entry === undefined) return Effect.void
        const grace = options.orderingGrace ?? orderingGrace
        return Effect.raceFirst(
          Deferred.await(entry.ended),
          Effect.sleep(grace).pipe(
            Effect.andThen(
              gap(
                id,
                entry.generation === unobserved ? null : entry.generation,
                orderingPhase,
                `No ${settledKind} within ${Duration.format(grace)}`
              )
            ),
            Effect.ignore
          )
        )
      })

    const startHeld = (id: string, pending: Active | undefined) => Effect.asVoid(admit(id, true, pending))
    /** Accepted work retains its actual acceptance even if observation fails. */
    const start = (id: string) => startHeld(id, undefined)
    const wrap = (executor: ControlExecutor.Service): ControlExecutor.Service => ({
      ...executor,
      launch: (input) =>
        Effect.gen(function*() {
          const id = input.run.runId
          // Held before the executor runs, because the run can end before the
          // admission below. `AgentSession.launch` releases the drive before it
          // returns `accepted`, and a module flow with no provider call reaches
          // its terminal write from there — an ordering registered afterwards
          // would have had nothing to hold, and the status would be readable
          // before the decision carrying the output was copied.
          const pending = yield* hold(id)
          const acceptance = yield* executor.launch(input).pipe(
            Effect.onError(() => release(id, pending))
          )
          // Nothing this host observes: a queued launch drives no execution
          // here, and its terminal status is another process's to order.
          if (acceptance !== "accepted") yield* release(id, pending)
          else yield* startHeld(id, pending)
          return acceptance
        }),
      resumeRun: (input) =>
        Effect.gen(function*() {
          const id = input.runId
          // The same window as a launch: `AgentSession.resumeRun` forks the
          // re-drive before it answers `resuming`, so the resumed body can
          // reach its terminal write before this admission registers anything.
          // A run already under observation keeps that observation.
          const pending = yield* hold(id)
          const uptake = yield* executor.resumeRun(input).pipe(
            Effect.onError(() => release(id, pending))
          )
          if (uptake !== "resuming") yield* release(id, pending)
          else yield* Effect.asVoid(admit(id, false, pending))
          return uptake
        })
    })
    const recover = options.control.listRuns.pipe(
      // Native validation happens before paging history. This includes terminal
      // control/native rows whose observation was interrupted before settlement.
      Effect.flatMap((runs) =>
        Effect.forEach(runs, (run) => admit(run.runId, false), { concurrency: 8, discard: true })
      )
    )
    return { start, wrap, recover, awaitSettled }
  })
