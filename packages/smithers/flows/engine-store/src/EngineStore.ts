/**
 * Durable `FlowEngine.Encoded` composition over `@smthrs/journal`.
 *
 * Governing designs: `docs/concepts/ownership-and-fencing.md`,
 * `docs/concepts/attempts-and-replay.md`, and
 * `apps/site/src/content/docs/docs/concepts/flows-actions-plans.mdx`.
 *
 * @since 0.1.0
 */

import { Sha256 } from "@smthrs/crypto"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import { FlowEngine } from "@smthrs/engine"
import { type Action, Flow, FlowRuntime } from "@smthrs/flow"
import { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import type { Ownership } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "./DurableEngineState.ts"
import * as ActionPersistence from "./internal/ActionPersistence.ts"
import * as AttemptAdmission from "./internal/AttemptAdmission.ts"
import * as AttemptProbe from "./internal/AttemptProbe.ts"
import * as CacheAgeVerdicts from "./internal/CacheAgeVerdicts.ts"
import * as DeferredPersistence from "./internal/DeferredPersistence.ts"
import * as EngineJj from "./internal/EngineJj.ts"
import * as NodeJournal from "./internal/NodeJournal.ts"
import * as RunDriver from "./internal/RunDriver.ts"
import * as OwnerIdentity from "./OwnerIdentity.ts"
import { RunState } from "./RunState.ts"
import * as StepBoundary from "./StepBoundary.ts"
import * as StepSandbox from "./StepSandbox.ts"
import * as WakeBus from "./WakeBus.ts"
import * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

/**
 * Why the engine itself asked a parked execution to resume, as reported to
 * {@link Options.requestResume}.
 *
 * @since 1.0.0-rc.0
 * @category models
 */
export type RequestedResumeReason = RunDriver.RequestedResumeReason

/**
 * Engine-store construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly owner: {
    readonly hostId: string
  }
  readonly journalSource: string
  /**
   * The directory a declaration path is recorded relative to.
   *
   * A node record can carry where its action was declared, and the path the
   * runtime reports is absolute. A journal is read on machines that did not
   * write it, so the absolute form is at best noise and at worst an
   * operator's home directory published into a run's history: the writer
   * strips this prefix, and omits the path entirely when it cannot.
   *
   * Defaults to the process working directory where there is one. A host
   * without a filesystem identity — a worker, a browser — passes nothing and
   * records no declaration paths at all, which is the honest answer.
   */
  readonly declarationRoot?: string | undefined
  /**
   * The revision of the tree this host read its flows out of.
   *
   * A node record can carry where its action was declared, and a path with a
   * line does not say which bytes were at that line: the tree moves, and the
   * same path after an edit is a different file. A host that can name the
   * revision it loaded from declares it here, and every recorded graph page
   * carries it, so a reader can open that file AT that revision.
   *
   * Absent by default, which is the honest answer for a host served out of
   * no version control or one that cannot name a revision holding what it
   * loaded. A reader with nothing shows no code rather than code it cannot
   * bind (D-068).
   *
   * A host that only learns the answer AFTER this store is built declares a
   * reader instead of a string, and it is asked once per recorded page. The
   * native host is one: the modules whose sites these records carry are read
   * during registration, which runs after this layer, so the revision that
   * describes them is not known when the store is composed. An answer that
   * is not a non-empty string records nothing, exactly as `undefined` does.
   */
  readonly sourceRevision?: string | (() => string | undefined) | undefined
  /**
   * Liveness arbitration consulted before this store steals a run whose lease
   * has expired. Answering `true` refuses the takeover.
   *
   * Optional. The default is `Ownership.leaseLiveness(heartbeatStaleAfter)`:
   * the owner is alive while its persisted heartbeat is younger than the
   * staleness cutoff, and gone once it is not. That is the weakest honest
   * answer and the one every host can give, so a composition that supplies
   * nothing still reclaims the runs of an owner killed with SIGKILL — the
   * steal it admits carries `lease-expired` evidence, which the run store
   * verifies against the row in the same write.
   *
   * A deployment that can say more supplies its own check and refuses the
   * takeover for longer: `Ownership.sameHostIncarnation` is the guard a local
   * `process.kill(pid, 0)` probe applies before reading `owner.pid`.
   */
  readonly isAlive?: Ownership.LivenessCheck | undefined
  /** Host routing, checked before claiming a run (including automatic wakes). */
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
  /**
   * Records, for a host that keeps one, that this engine has asked a parked
   * execution to resume: a durable clock fired, a durable deferred completed,
   * or a child settled under a parent that parked on it.
   *
   * A host that refuses to re-enter a parked run nobody asked for — the
   * control plane's executor does — reads the record to tell those wakes from
   * its own heartbeat sweep. Without it a run that slept never settled.
   *
   * Optional; a composition with no such host leaves it undefined.
   *
   * @since 1.0.0-rc.0
   */
  readonly requestResume?:
    | ((executionId: string, reason: RequestedResumeReason) => Effect.Effect<void>)
    | undefined
  /**
   * Redispatch policy for a durable clock whose fire failed. Defaults to
   * {@link DeferredPersistence.defaultFireRetryPolicy} — exponential from
   * 100ms, capped at 30s, forever. Same shape as the engine's
   * `suspendedRetryPolicy` option: the built-in behavior is the default, and
   * a deployment that wants a different backoff supplies one here rather than
   * patching the store.
   */
  readonly clockFireRetryPolicy?: Schedule.Schedule<unknown, unknown> | undefined
}

type PublicRequirements =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  // DECIDED (2026-08-11, pending review): hashing is a construction-time
  // requirement of this composition rather than a per-call one.
  // The run driver derives each trampoline round's execution id from
  // (lineage, ordinal) with the injected SHA-256, on the coordinator's own
  // fiber rather than a caller's, so hashing is a construction-time
  // requirement of the composition (`packages/smithers/flows/engine/docs/api.md`).
  | Crypto.Crypto
  | DurableEngineState.DurableEngineState
  | DurableWriter
  | Journal.Journal
  | Jj.Jj
  | OwnerIdentity.OwnerIdentity
  | RunStore.RunStore
  | Scope.Scope
  | StepBoundary.Service

type Requirements = PublicRequirements | EngineJj.EngineJj

const isBoundaryMetadata = Schema.is(FileBoundary)

/**
 * Constructs the production encoded composition.
 *
 * Registrations and active fibers are scoped in memory. Run identity, encoded
 * payload, results, deferred completions, clocks, actions, and ownership
 * are persisted by the supplied layers. Supply the same DurableWriter used
 * by the journal and run store so cancellation can retain complete failures.
 *
 * @since 0.1.0
 * @category constructors
 */
const makeWithEngineJj = (
  options: Options
): Effect.Effect<FlowRuntime.FlowRuntime["Service"], never, Requirements> =>
  Effect.gen(function*() {
    const ownerIdentity = yield* OwnerIdentity.OwnerIdentity
    const owner = yield* ownerIdentity.ownerId(options.owner.hostId)
    // One admission mutex per incarnation, shared by every dispatch this
    // store drives: `ActionPersistence.make` runs per dispatch below, so a
    // per-make default would never contend and the same-key exclusion the
    // adoption evidence rests on (issues #102, #103) would silently vanish.
    const admission = AttemptAdmission.makeUnsafe()
    // Run instances own the projection's lifetime, including nested actions.
    // A resumed instance rebuilds it without retaining completed runs here.
    const ageVerdicts = new WeakMap<FlowRuntime.FlowInstance["Service"], ReturnType<typeof CacheAgeVerdicts.make>>()
    const attemptStore = yield* AttemptStore.AttemptStore
    const cacheStore = yield* CacheStore.CacheStore
    const journal = yield* Journal.Journal
    const declarationRoot = NodeJournal.hostRoot(options.declarationRoot)
    /*
     * Stated by the host or not at all; nothing here derives a revision. A
     * reader is asked where the record is written rather than here, because a
     * host that learns its revision after this layer builds would otherwise
     * be captured before it knows the answer.
     */
    const declaredRevision = options.sourceRevision
    const sourceRevision = (): string | undefined => {
      const answer = typeof declaredRevision === "function" ? declaredRevision() : declaredRevision
      return typeof answer === "string" && answer.length > 0 ? answer : undefined
    }
    const actionJj = yield* Jj.Jj
    const engineJj = yield* EngineJj.EngineJj
    const runStore = yield* RunStore.RunStore
    const forkOrigins = new WeakMap<FlowRuntime.FlowInstance["Service"], ReadonlyArray<string>>()
    const keyOrigins = Effect.fnUntraced(function*(instance: FlowRuntime.FlowInstance["Service"]) {
      const cached = forkOrigins.get(instance)
      if (cached !== undefined) return cached
      const row = yield* runStore.get(instance.executionId).pipe(Effect.orDie)
      const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunState))(row.stateJson).pipe(Effect.orDie)
      const origins = state.forkKeyRunIds ?? []
      forkOrigins.set(instance, origins)
      return origins
    })
    const stepBoundary = yield* StepBoundary.StepBoundary
    /**
     * Both halves of the isolated-execution lane are OPTIONAL and resolved
     * here, at composition time, for the same reason every service above is:
     * `actionExecute` runs on the engine's fiber, which does not carry the
     * store's layer context, so anything the dispatch needs has to be captured
     * now and re-provided below. A composition without a sandbox keeps the
     * pre-existing behaviour — the body runs against the host directly — and
     * one without a dispatcher journals what a transaction queued without
     * sending it.
     */
    const workspaceSandbox = yield* Effect.serviceOption(WorkspaceSandbox.WorkspaceSandbox)
    const stepSandbox = yield* Effect.serviceOption(StepSandbox.StepSandbox)
    const effectDispatcher = yield* Effect.serviceOption(WorkspaceSandbox.EffectDispatcher)
    const engineState = yield* DurableEngineState.DurableEngineState
    const attemptSurvivors = engineState.attemptSurvivors
    /**
     * Resolved like the sandbox lane above: OPTIONAL, at composition time. A
     * host that provides `WakeBus.layer` shares one bus between this engine
     * and its own wake sources; a composition given none builds a private
     * bus, which is complete for the in-process seam because every wake
     * source below (driver, deferred persistence) publishes through it.
     */
    const providedWakeBus = yield* Effect.serviceOption(WakeBus.WakeBus)
    const wakeBus = Option.getOrElse(providedWakeBus, WakeBus.makeUnsafe)

    const engine = yield* Deferred.make<FlowRuntime.FlowRuntime["Service"]>()
    const driver = yield* RunDriver.make({
      owner,
      journalSource: options.journalSource,
      isAlive: options.isAlive,
      canExecute: options.canExecute,
      requestResume: options.requestResume,
      engine: Deferred.await(engine),
      wakeBus
    })
    const deferred = yield* DeferredPersistence.make({
      owner,
      journalSource: options.journalSource,
      scheduleResume: (flowName, executionId, reason, sourceId) =>
        driver.scheduleResume(flowName, executionId, reason, sourceId),
      fireRetryPolicy: options.clockFireRetryPolicy
    })

    const actionExecute = Effect.fn("FlowEngine.actionExecute")(function*(input: FlowEngine.ActionExecuteOptions) {
      const parent = yield* FlowRuntime.FlowInstance
      let cacheAgeVerdict = ageVerdicts.get(parent)
      if (cacheAgeVerdict === undefined) {
        cacheAgeVerdict = CacheAgeVerdicts.make(parent.executionId)
        ageVerdicts.set(parent, cacheAgeVerdict)
      }
      yield* Effect.annotateCurrentSpan({
        runId: parent.executionId,
        action: input.action.name,
        // `stepKey`, never `key`. `@smthrs/journal`'s redaction replaces the
        // value of any field whose name is a standalone trailing `key` word,
        // and `RedactedLogger` applies that rule to every log line this
        // package emits under a real host. A field named `key` reached the
        // operator as `[REDACTED]`, destroying the one field that says which
        // dispatch the line describes. The span carries the same name so the
        // trace and the log agree.
        stepKey: input.key,
        attempt: input.attempt,
        tier: input.tier
      })
      const instance = FlowEngine.makeInstance(
        parent.flow,
        parent.executionId
      )
      ageVerdicts.set(instance, cacheAgeVerdict)
      const flowEngine = yield* Deferred.await(engine)
      instance.interrupted = parent.interrupted
      // DECIDED (2026-08-11, pending review): the waiting classification is
      // threaded through the dispatch's instance and back, because the dispatch
      // runs under an instance of its own while `annotateWaiting` is documented
      // to reach the parked row. An implementation that declares one — `Sleep`
      // under `timer`, `WaitFor` under `event` with its wake token — writes it
      // here, so without the thread-back `RunDriver` would park on the derived
      // default and an action's declaration would be inert. It is seeded as
      // well as copied back so a body that annotated before dispatching keeps
      // its own declaration, and so the consumption `deferredResult` performs
      // on a settled wait travels out the same way (issue #42).
      const waitingBefore = parent.waiting
      instance.waiting = waitingBefore
      const logContext = {
        runId: parent.executionId,
        action: input.action.name,
        stepKey: input.key,
        attempt: input.attempt,
        tier: input.tier
      }
      yield* Effect.logTrace("action dispatch started", logContext)
      const result = yield* ActionPersistence.make({
        runId: parent.executionId,
        owner,
        sourceId: options.journalSource,
        engineJj,
        execute: (actionInput) => (actionInput.action as Action.Any).executeEncoded as Effect.Effect<unknown, unknown>,
        idempotencyKey: input.action.idempotencyKey === undefined
          ? undefined
          : input.key,
        admission,
        cacheAgeVerdict
      })({
        action: input.action,
        attempt: input.attempt,
        key: input.key,
        tier: input.tier,
        ...(input.nondeterministic === undefined ? {} : { nondeterministic: input.nondeterministic }),
        ...(isBoundaryMetadata(input.metadata)
          ? { metadata: input.metadata }
          : {})
      }).pipe(
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provideService(
          FlowRuntime.FlowRuntime,
          flowEngine
        ),
        Effect.provideService(AttemptStore.AttemptStore, attemptStore),
        Effect.provideService(CacheStore.CacheStore, cacheStore),
        Effect.provideService(Journal.Journal, journal),
        Effect.provideService(Jj.Jj, actionJj),
        Effect.provideService(RunStore.RunStore, runStore),
        Effect.provideService(StepBoundary.StepBoundary, stepBoundary),
        (dispatch) =>
          Option.isNone(stepSandbox)
            ? dispatch
            : Effect.provideService(dispatch, StepSandbox.StepSandbox, stepSandbox.value),
        (dispatch) =>
          Option.isNone(workspaceSandbox)
            ? dispatch
            : Effect.provideService(dispatch, WorkspaceSandbox.WorkspaceSandbox, workspaceSandbox.value),
        (dispatch) =>
          Option.isNone(effectDispatcher)
            ? dispatch
            : Effect.provideService(dispatch, WorkspaceSandbox.EffectDispatcher, effectDispatcher.value),
        Effect.ensuring(Effect.sync(() => {
          if (parent.waiting === waitingBefore) parent.waiting = instance.waiting
        }))
      )
      const outcome = result._tag === "Complete"
        ? result.exit._tag === "Success" ? "success" : "failure"
        : result._tag.toLowerCase()
      yield* Effect.annotateCurrentSpan({ outcome })
      yield* Effect.logTrace("action dispatch settled", { ...logContext, outcome })
      return result
    })

    const encoded: FlowEngine.Encoded = {
      // Unspanned here: `driver.register` already opens the
      // `FlowEngine.register` span, and a second identical wrapper would nest
      // two same-name spans around one operation.
      register: (flow, execute) =>
        driver.register(flow, execute).pipe(
          Effect.tap(() => deferred.sweepDue(flow._tag))
        ),
      execute: driver.execute,
      poll: driver.poll,
      interrupt: driver.interrupt,
      // The driver's refusal, forwarded rather than re-implemented: the
      // durable engine has one cancellation path, so `interruptUnsafe` fails
      // with `unsafe_interrupt_unsupported` here too (the release policy).
      interruptUnsafe: driver.interruptUnsafe,
      resume: driver.resume,
      actionExecute,
      /**
       * The graph a walk drove, and how each of its nodes settled.
       *
       * Addressed by the record's own `sourceId` rather than a minted one, so
       * a resumed walk writes the identities the first walk used and the
       * journal's `(run, source, sequence)` uniqueness holds one row per node
       * instead of one per observation. A `Duplicate` receipt is that
       * collapse happening, and it is the expected answer on a resume.
       *
       * On the durable, owner-fenced channel, like every other engine record:
       * a writer that lost the run self-interrupts rather than narrating a
       * walk it no longer owns.
       */
      nodeRecordBytes: (record) =>
        Effect.map(FlowRuntime.FlowInstance, (parent) =>
          NodeJournal.encodedBytes({
            runId: parent.executionId,
            sourceId: options.journalSource,
            lineageId: FlowEngine.Lineage.root(parent.executionId),
            root: declarationRoot,
            sourceRevision: sourceRevision()
          }, record)),
      recordNode: (record) =>
        Effect.flatMap(FlowRuntime.FlowInstance, (parent) =>
          journal.emitDurable(
            NodeJournal.entry({
              runId: parent.executionId,
              sourceId: options.journalSource,
              lineageId: FlowEngine.Lineage.root(parent.executionId),
              root: declarationRoot,
              sourceRevision: sourceRevision()
            }, record),
            owner
          ).pipe(
            Effect.catch((error) => error.code === "fence_lost" ? Effect.interrupt : Effect.die(error)),
            Effect.asVoid
          )),
      actionReplayKey: Effect.fnUntraced(function*(derive) {
        const instance = yield* FlowRuntime.FlowInstance
        const origins = yield* keyOrigins(instance)
        if (origins.length === 0) return yield* derive(instance.executionId, false)
        // Prefer this child's own work on resume, then only ancestor keys
        // backed by attempts copied into this child. Never read parent rows.
        const probed = new Set<string>()
        for (const runId of [instance.executionId, ...origins]) {
          for (const runScoped of [true, false]) {
            const key = yield* derive(runId, runScoped)
            if (probed.has(key)) continue
            probed.add(key)
            const digest = yield* Schema.decodeUnknownEffect(Sha256)(key).pipe(Effect.orDie)
            const found = yield* AttemptProbe.probeAttempts(
              attemptStore,
              attemptSurvivors,
              instance.executionId,
              digest
            )
            if (Option.isSome(found)) return key
          }
        }
        return yield* derive(instance.executionId, true)
      }),
      // The durable schedule-to-close origin (issue #45): the first
      // attempt's persisted `startedAtMs` for the action key. It lives in
      // the same `flows_attempts` rows that already restore the attempt
      // sequence across park/resume and process death, so the engine's
      // `expirationMs` budget is measured from the true first attempt
      // instead of restarting on every process.
      actionRetryOrigin: Effect.fnUntraced(function*(input: {
        readonly key: string
      }) {
        const parent = yield* FlowRuntime.FlowInstance
        const survivors = yield* AttemptProbe.probeAttempts(
          attemptStore,
          attemptSurvivors,
          parent.executionId,
          yield* Schema.decodeUnknownEffect(Sha256)(input.key).pipe(Effect.orDie)
        )
        return Option.map(survivors, ({ earliestStartedAtMs }) => earliestStartedAtMs)
      }),
      // The durable attempt counter (issue #59): the highest contiguous
      // persisted attempt for the key, so a resumed run replays failed
      // attempts under their original numbers instead of restarting at 1 —
      // the persisted failure is rethrown by `ActionPersistence`, the
      // retry decision sees the true attempt count, and the backoff ladder
      // is not re-slept.
      actionLatestAttempt: Effect.fnUntraced(function*(input: {
        readonly key: string
      }) {
        const parent = yield* FlowRuntime.FlowInstance
        const survivors = yield* AttemptProbe.probeAttempts(
          attemptStore,
          attemptSurvivors,
          parent.executionId,
          yield* Schema.decodeUnknownEffect(Sha256)(input.key).pipe(Effect.orDie)
        )
        return Option.map(survivors, ({ latest }) => latest)
      }),
      deferredResult: deferred.deferredResult,
      deferredDone: deferred.deferredDone,
      deferredDoneIfWaiting: deferred.deferredDoneIfWaiting,
      scheduleClock: deferred.scheduleClock,
      // The engine races this against its suspension backoff sleep, so an
      // IN-PROCESS wake — deferred completed, clock fired, operator resume,
      // run settled — resumes the waiting caller immediately, with the
      // polling schedule as the bounded fallback. The bus is edge-triggered
      // and miss-tolerant (`WakeBus.ts`); a wake published before the caller
      // re-subscribes only costs one poll interval. Cross-process wakes ride
      // the polling schedule and the heartbeat sweeps: the bus is in-process,
      // and the journal offers no committed cross-process subscription.
      resumeSignal: (_flow, executionId) => wakeBus.awaitWake(executionId)
    }
    const service = { ...FlowEngine.makeUnsafe(encoded), durability: "durable" as const }
    yield* Deferred.succeed(engine, service)
    return service
  })

/**
 * Constructs the production encoded composition using the ambient `Jj` for
 * both public action access and private engine bookkeeping.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  options: Options
): Effect.Effect<FlowRuntime.FlowRuntime["Service"], never, PublicRequirements> =>
  Effect.gen(function*() {
    const jj = yield* Jj.Jj
    return yield* makeWithEngineJj(options).pipe(
      Effect.provideService(EngineJj.EngineJj, jj)
    )
  })

/**
 * Provides the durable flow engine.
 *
 * @since 0.1.0
 * @category layers
 */
const layerBase = (
  options: Options
): Layer.Layer<
  FlowEngine.SnapshotBoundary | FlowRuntime.FlowRuntime,
  never,
  Requirements
> => {
  const snapshotBoundary = Layer.effect(
    FlowEngine.SnapshotBoundary,
    Effect.map(EngineJj.EngineJj, (jj) =>
      FlowEngine.SnapshotBoundary.of({
        snapshot: Effect.fn("SnapshotBoundary.snapshot")(({ key, attempt }) =>
          Effect.annotateCurrentSpan({ stepKey: key, attempt }).pipe(
            Effect.andThen(jj.snapshot(`smithers action ${key} attempt ${attempt}`)),
            Effect.orDie,
            // The commit id, never the change id: an agent's `jj squash` in the
            // step rewrites the change, and a change id would then name the
            // step's edits instead of the pre-image.
            Effect.map((snapshot) => snapshot.commitId)
          )
        ),
        restore: Effect.fn("SnapshotBoundary.restore")((snapshot) =>
          Effect.annotateCurrentSpan({ snapshot: String(snapshot) }).pipe(
            Effect.andThen(jj.restore(snapshot as never)),
            Effect.orDie
          )
        ),
        diff: Effect.fn("SnapshotBoundary.diff")((snapshot, { key, attempt }) =>
          Effect.annotateCurrentSpan({ stepKey: key, attempt }).pipe(
            Effect.andThen(jj.snapshot(`smithers action ${key} attempt ${attempt} settled`)),
            Effect.orDie,
            Effect.flatMap((current) => jj.diff(snapshot as never, current.commitId).pipe(Effect.orDie))
          )
        )
      }))
  )
  return Layer.merge(
    Layer.effect(FlowRuntime.FlowRuntime, makeWithEngineJj(options)),
    snapshotBoundary
  )
}

/**
 * Provides the durable engine using the ambient `Jj` for both action and
 * engine contexts. Host compositions that guard action access should use
 * {@link layerWithPrivilegedJj} instead.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  options: Options
): Layer.Layer<FlowEngine.SnapshotBoundary | FlowRuntime.FlowRuntime, never, PublicRequirements> =>
  layerBase(options).pipe(Layer.provide(EngineJj.layerFromJj))

/**
 * Provides the durable engine with a private repository implementation for
 * engine bookkeeping while retaining ambient `Jj` for action bodies.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerWithPrivilegedJj = <E, R>(
  options: Options,
  privilegedJj: Layer.Layer<Jj.Jj, E, R>
): Layer.Layer<
  FlowEngine.SnapshotBoundary | FlowRuntime.FlowRuntime,
  E,
  PublicRequirements | R
> =>
  layerBase(options).pipe(
    Layer.provide(EngineJj.layerFromJj.pipe(Layer.provide(privilegedJj)))
  )
