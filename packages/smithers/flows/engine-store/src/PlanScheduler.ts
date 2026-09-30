/**
 * Drives a persisted plan: the node scheduler.
 *
 * `@smthrs/plan` makes the plan a value; this makes it run. The scheduler
 * walks the persisted graph, dispatches ready nodes through the same
 * `internal/ActionPersistence` seam every action uses — so the shared step
 * cache, the workspace sandbox's execute→materialize transaction, attempt
 * rows, and the fenced journal all apply unchanged — and records an
 * evaluation outcome per node.
 *
 * ## What it is, and what it is not
 *
 * Skyframe's `AbstractParallelEvaluator` is the prior art for the state
 * machine (`CHECK_DEPENDENCIES → VERIFIED_CLEAN | NEEDS_REBUILDING →
 * REBUILDING → DONE`) and `EvaluationProgressReceiver` for the outcome
 * vocabulary. Two deliberate deviations:
 *
 * 1. **No cache-invalidating node visitor.** Content addressing governs
 *    reuse. Private reverse indexes propagate settled outcomes and readiness,
 *    never dirty bits. Dispatch-time content measurement still decides
 *    whether a recorded result can serve the node.
 * 2. **Completion-driven, without Skyframe restarts.** Skyframe atomically
 *    signals reverse dependencies when one node settles. Our dependencies are
 *    declared in the plan before anything runs, so one coordinator can make
 *    the equivalent decision from the plan, settled state, and scheduling
 *    permits: every completion is reconciled and immediately opens another
 *    admission pass. Giving up the wavefront barrier also gives up its
 *    trivially serialized reconciliation; draining and applying the durable
 *    deviation journal after each settlement, before reevaluating downstream
 *    readiness, restores that ordering without holding unrelated ready cones.
 *    The coordinator is the sole writer of scheduling state, which keeps every
 *    admission decision deterministic without the `DeterministicHelper` the
 *    vault rejected.
 *
 * ## The three limits
 *
 * The same number must never
 * stand in for graph width, scheduler admission, and provider capacity. This
 * module owns the middle one only: `concurrency.steps` is the leaf-execution
 * cap, and `concurrency.agents` is the subset cap an agent node consumes in
 * addition. Structural width is whatever the plan says; seats belong to
 * `Agent Adapters` and are not modelled here.
 *
 * Under contention, ready work is ordered by effective priority — declared
 * `priority` plus one point per capacity-constrained admission pass. A ready
 * node gains a point exactly when a pass considers it but cannot give it the
 * required permits. Aging is what lets priority change latency without
 * permitting starvation; equal effective priorities preserve deterministic
 * plan order.
 *
 * ## Observing the world exactly once
 *
 * The torn-run rule: never re-observe the
 * world mid-run. Reads with no preceding writer are **source** inputs; their
 * digests and glob membership are durably recorded before dispatch and restored
 * on reopening. Preceding producers' outputs are measured after settlement —
 * observing our own output, not the world. Later and self-writes are not source
 * producers. New generations retain prior pins and record new observations.
 *
 * @since 0.1.0
 */

import { Sha256 } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Journal, type JournalEvent } from "@smthrs/journal"
import type { Jj } from "@smthrs/kernel"
import { Plan, Scheduling, StepKey } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import * as FileSet from "@smthrs/plan/FileSet"
import { AttemptStore, type Ownership, type RunStore } from "@smthrs/run-store"
import type { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as EngineStoreMetrics from "./EngineStoreMetrics.ts"
import * as ActionPersistence from "./internal/ActionPersistence.ts"
import * as AttemptAdmission from "./internal/AttemptAdmission.ts"
import * as CacheAgeVerdicts from "./internal/CacheAgeVerdicts.ts"
import * as FileEnumeration from "./internal/FileEnumeration.ts"
import * as JournalRecords from "./internal/JournalRecords.ts"
import { compareText } from "./internal/Ordering.ts"
import * as PlanInputs from "./internal/PlanInputs.ts"
import * as PlanMerges from "./internal/PlanMerges.ts"
import * as RuntimeGraph from "./internal/RuntimeGraph.ts"
import * as PlanInputStore from "./PlanInputStore.ts"
import * as PlanMergeStore from "./PlanMergeStore.ts"
import * as Reconciliation from "./Reconciliation.ts"
import * as ReplayOnly from "./ReplayOnly.ts"
import * as Selection from "./Selection.ts"
import * as StepBoundary from "./StepBoundary.ts"
import * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

/**
 * The evaluation outcomes: Skyframe's `EvaluationState` adapted to a
 * content-addressed store, plus the selection debt.
 *
 * - `built` — the node executed (`SUCCESS_VERSION_CHANGED`).
 * - `clean` — a recorded result served it and no executor ran. This includes
 *   same-run durable attempt replay for every tier, and shared-cache hits for
 *   eligible sealed work (`SUCCESS_VERSION_UNCHANGED`). It does not assert
 *   cross-run cache eligibility.
 * - `failed` — the node executed and failed, or reconciliation failed it.
 * - `skipped` — its cone prevented dispatch, or `stop-merge` stopped a
 *   conflicted attempt in favour of a merge node. The latter has nonzero
 *   attempts; skipped does not imply that its executor never ran. Skyframe
 *   splits failure by version instead; a content-addressed store never serves
 *   a failure from cache, so that split has no meaning here and this one does.
 * - `deferred`: a selection guess postponed this sink
 *   (`docs/guides/defer-work-with-selection.md`). It never dispatched,
 *   wrote no cache row, and is journaled as a debt for a later guess-free
 *   pass. Distinct from `skipped` — the work was runnable, a guess postponed
 *   it — and never reported as passed.
 *
 * @since 0.1.0
 * @category models
 */
export type Outcome = "built" | "clean" | "failed" | "skipped" | "deferred"

/**
 * One material `Ref` input, resolved: the settled output of `from` projected
 * along `path` — for sealed work, the value whose digest the dispatch key folds.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResolvedInput {
  readonly from: string
  readonly path: ReadonlyArray<string>
  readonly value: unknown
}

/**
 * What the scheduler hands a node's executor.
 *
 * @since 0.1.0
 * @category models
 */
export interface NodeInput {
  readonly node: Plan.PlanNode
  readonly attempt: number
  /** The measured boundary; folded into sealed keys, diagnostic context for other tiers. */
  readonly boundary: FileBoundary
  /**
   * The node's material `Ref` inputs, resolved through the same projection the
   * dispatch key digests for sealed work. Ordering (`Pending`) dependencies
   * and unprojected sibling fields are deliberately absent. This preserves
   * the consumed-data contract for every tier and prevents a sealed cache hit
   * from serving an execution that consumed different data.
   */
  readonly inputs: ReadonlyArray<ResolvedInput>
}

/**
 * The DI seam that turns a plan node into work.
 *
 * The scheduler owns identity, admission, caching, and journaling; it
 * deliberately owns nothing about what a node *means*. A flow runtime, a test,
 * or a remote host each supply their own executor.
 *
 * @since 0.1.0
 * @category models
 */
export interface Executor {
  readonly execute: (input: NodeInput) => Effect.Effect<unknown, unknown>
}

/**
 * Service tag for the node executor.
 *
 * @since 0.1.0
 * @category services
 */
export class NodeExecutor extends Context.Service<NodeExecutor, Executor>()("@smthrs/engine-store/NodeExecutor") {}

/**
 * Provides a plain {@link Executor} value as the {@link NodeExecutor} service.
 *
 * This is the whole wiring story for the scheduler's one open seam: a flow
 * runtime, a test double, or a remote dispatcher each become a layer by
 * passing themselves here.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerExecutor = (executor: Executor): Layer.Layer<NodeExecutor> => Layer.succeed(NodeExecutor, executor)

/**
 * How one node ended.
 *
 * @since 0.1.0
 * @category models
 */
export interface Settlement {
  readonly nodeId: string
  /** The plan-time key: a pure function of declarations. */
  readonly planKey: string
  /** The execution key: content-derived for sealed work; run/plan/node/declaration-scoped for other tiers. */
  readonly dispatchKey: string
  readonly outcome: Outcome
  readonly attempts: number
  readonly rebases: number
}

/**
 * What a run of a plan produced.
 *
 * @since 0.1.0
 * @category models
 */
export interface Report {
  readonly planId: string
  readonly digest: string
  readonly settlements: ReadonlyArray<Settlement>
  readonly results: Readonly<Record<string, unknown>>
  readonly verdicts: ReadonlyArray<{ readonly nodeId: string; readonly verdict: Reconciliation.Verdict }>
  /** Merge nodes a `stop-merge` conflict appended to the plan. */
  readonly appended: ReadonlyArray<string>
}

/**
 * Scheduler construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly sourceId: string
  /**
   * Engine-resolved identity, copied at scheduler construction and durably
   * bound before dispatch. A changed identity cannot resume the same run.
   * Omitting it preserves existing action keys but is itself a distinct binding.
   */
  readonly environment?: StepKey.EnvironmentIdentity | undefined
  /**
   * The admission caps. Both default to unbounded, because a cap the caller
   * did not declare is not the scheduler's to invent — `aspects.ts` owns the
   * policy and narrows it. Explicit caps must be positive safe integers;
   * zero is refused rather than silently clamped or allowed to deadlock.
   */
  readonly concurrency?: Scheduling.Concurrency | undefined
  /**
   * How many times a `delay-rebase` node may re-measure and re-key against a
   * newly recorded base before reconciliation is asked. Bounded on purpose: an
   * unbounded rebase loop is a livelock with good manners.
   */
  readonly rebaseLimit?: number | undefined
  /**
   * Probabilistic selection input for this run (`Selection`). Every field is
   * optional because every default is inert: no changed paths and no beliefs
   * admit everything, so a caller that never opted in runs exactly as today.
   * `full: true` is the run-level override — every verdict is treated as
   * `Admit` and the override is journaled, the way `--fresh` ignores the
   * cache.
   */
  readonly selection?: {
    /** Changed paths the belief edges are matched against. */
    readonly changed?: ReadonlyArray<string> | undefined
    /** The belief snapshot pinned before planning. */
    readonly beliefs?: Selection.BeliefSnapshot | undefined
    /** Deferral policy; `deferBelow` defaults to zero, which defers nothing. */
    readonly policy?: Selection.Policy | undefined
    /** Force full selection: treat every verdict as `Admit`, journaled. */
    readonly full?: boolean | undefined
  } | undefined
}

/**
 * Everything driving a plan needs from the composition.
 *
 * @since 0.1.0
 * @category models
 */
export type Requirements =
  | PlanMergeStore.PlanMergeStore
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | Crypto.Crypto
  | Jj.Jj
  | Journal.Journal
  | NodeExecutor
  | PlanStore.PlanStore
  | PlanInputStore.PlanInputStore
  | RunStore.RunStore
  | StepBoundary.Service

/**
 * A refusal the scheduler itself raises. A node's own failure is an outcome,
 * not one of these — the run continues and the report says `failed`.
 *
 * @since 0.1.0
 * @category errors
 */
export class SchedulerError extends Schema.TaggedError<SchedulerError>()("@smthrs/engine-store/SchedulerError", {
  code: Schema.Literals([
    "invalid_plan",
    "boundary_unavailable",
    "key_uncomputable",
    "elaboration_failed",
    "store_failed"
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  /** Failures while settling siblings after the primary scheduler failure. */
  cleanupErrors: Schema.optional(Schema.Array(Schema.Unknown))
}) {}

/**
 * Plan-driving operations.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  /** Persists generation 0 and journals `plan-recorded`. */
  readonly record: (
    plan: Plan.Plan
  ) => Effect.Effect<PlanStore.RecordResult, SchedulerError, PlanStore.PlanStore | Journal.Journal | Crypto.Crypto>
  /** Persists the newest generation and journals `subgraph-appended`. */
  readonly append: (
    plan: Plan.Plan
  ) => Effect.Effect<void, SchedulerError, PlanStore.PlanStore | Journal.Journal | Crypto.Crypto>
  /** Drives the plan to completion and reports every node's outcome. */
  readonly run: (plan: Plan.Plan) => Effect.Effect<Report, SchedulerError, Requirements>
}

/**
 * Service tag for the plan scheduler.
 *
 * @since 0.1.0
 * @category services
 */
export class PlanScheduler extends Context.Service<PlanScheduler, Service>()("@smthrs/engine-store/PlanScheduler") {}

/**
 * The declared digest handed to `StepBoundary.prepare` when the scheduler is
 * *asking* what a path holds rather than asserting it. Prepare measures every
 * declared read regardless of what the declaration claims, so any placeholder
 * works; a self-describing one can never be mistaken for a real digest.
 *
 * @private
 */
/**
 * The tag a plan node dispatches, when its material names one.
 *
 * A material body is opaque to the compiler by design, so this reads it
 * defensively and answers nothing rather than guessing: a merge node, a body
 * an elaborator shaped differently, and a node whose tag is not a string all
 * carry no tag at all. @private
 */
const actionOf = (node: Plan.PlanNode): string | undefined => {
  const body = node.material.body
  if (typeof body !== "object" || body === null) return undefined
  const fields = body as Record<string, unknown>
  const named = typeof fields["action"] === "string" ? fields["action"] : fields["flow"]
  return typeof named === "string" && named !== "" ? named : undefined
}

/**
 * One node of a plan, as a journal record carries it.
 *
 * The same shape the interpreter writes, so a reader folds both executors
 * with one decoder. `effects` and `key` are the plan's own; there is no
 * declaration site here, because a plan node is compiled from a draft and the
 * draft's author frame is not something the compiler keeps. @private
 */
const nodeSummary = (node: Plan.PlanNode) => {
  const action = actionOf(node)
  return {
    id: node.id,
    kind: node.kind,
    dependsOn: node.dependsOn,
    tier: node.material.kind,
    key: node.key,
    generation: node.generation,
    ...(action === undefined ? {} : { action })
  }
}

const unmeasured = "unmeasured"

/** @private */
const isConflict = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => Cause.isFailReason(reason) && WorkspaceSandbox.isMaterializationConflict(reason.error))

/** @private */
const DeviationPayload = Schema.Struct({
  stepKeyDigest: Schema.NonEmptyString,
  attempt: Schema.Int,
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.String
})

const decodeDeviation = Schema.decodeUnknownOption(DeviationPayload)

const digestOf = Schema.decodeUnknownEffect(Sha256)

/** @private */
interface DispatchStart {
  readonly dispatchKey: string
  readonly attempts: number
  readonly rebases: number
  readonly waited: number
  readonly results: ReadonlyMap<string, unknown>
  readonly inputs: ReadonlyArray<ResolvedInput>
}

/** @private */
interface ObservedRead {
  readonly entry: FileSet.ReadEntry
  /** Source members observed when this declaration entered the run. */
  readonly sourcePaths: ReadonlyArray<string>
}

/** @private */
interface DispatchProgress {
  readonly dispatchKey: string
  readonly attempts: number
  readonly rebases: number
}

/** @private */
interface CompletedDispatch extends DispatchProgress {
  readonly outcome: "built" | "clean"
  readonly result: unknown
}

/** @private */
interface FailedDispatch extends DispatchProgress {
  readonly outcome: "failed"
}

/** @private */
interface ConflictedDispatch extends DispatchProgress {
  readonly outcome: "conflicted"
  readonly strategy: Plan.RuntimeStrategy
}

/** @private */
type Dispatched = CompletedDispatch | FailedDispatch | ConflictedDispatch

/** @private */
interface DispatchSettlementEvent {
  readonly _tag: "DispatchSettled"
  readonly node: Plan.PlanNode
  readonly exit: Exit.Exit<Dispatched, SchedulerError>
}

/** @private */
type CoordinatorEvent =
  | { readonly _tag: "AttemptKeyed"; readonly nodeId: string; readonly digest: string }
  | DispatchSettlementEvent

const storeFailure = (message: string) => (cause: unknown) =>
  new SchedulerError({ code: "store_failed", message, cause })

const nonNegativeSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

/**
 * Constructs a scheduler bound to one run.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: Options): Service => {
  const admission = AttemptAdmission.makeUnsafe()
  const cacheAgeVerdict = CacheAgeVerdicts.make(options.runId)
  const rebaseLimit = nonNegativeSafeInteger("rebaseLimit", options.rebaseLimit ?? 3)
  const scheduling = Scheduling.make(options.concurrency)
  // Capture before the first async boundary. Callers can retain and mutate
  // their options, but cannot change this scheduler's identity after admission.
  const capturedEnvironment = Result.try(() =>
    Schema.decodeUnknownSync(Schema.UndefinedOr(StepKey.EnvironmentIdentity))(
      options.environment,
      { onExcessProperty: "error" }
    )
  )

  // Every scheduler record addresses the run's root lineage, so a frame can
  // reach it (`apps/site/src/content/docs/docs/concepts/time-travel.mdx`).
  const lineageId = FlowEngine.Lineage.root(options.runId)
  const source = (suffix: string) => ({ runId: options.runId, sourceId: `${options.sourceId}/${suffix}`, lineageId })

  /**
   * Scheduler records take the journal's durable, owner-fenced channel: a plan
   * digest binds an approval, so it may never ride the lossy queue. A zombie
   * that lost the run self-interrupts on `fence_lost`, exactly as
   * `internal/ActionPersistence` does — a scheduler that kept dispatching
   * after losing ownership is the failure mode fencing exists to prevent.
   */
  const emit = (record: JournalEvent.Input) =>
    Effect.flatMap(Journal.Journal, (journal) => journal.emitDurable(record, options.owner)).pipe(
      Effect.catch((error) =>
        error.code === "fence_lost"
          ? Effect.interrupt
          : Effect.fail(storeFailure("the scheduler could not journal a record")(error))
      )
    )

  const atomically = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Journal.Journal, (journal) => journal.transact(effect)).pipe(
      Effect.mapError((error) => error instanceof SchedulerError ? error : storeFailure(message)(error))
    )

  const verifyPlan = (candidate: Plan.Plan) =>
    Plan.verify(candidate).pipe(
      Effect.mapError((cause) =>
        new SchedulerError({ code: "invalid_plan", message: "the scheduler requires a verified plan", cause })
      )
    )

  const record: Service["record"] = Effect.fn("PlanScheduler.record")((candidate) =>
    Effect.gen(function*() {
      const plan = yield* verifyPlan(candidate)
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        planId: plan.planId,
        digest: plan.digest,
        generation: plan.generation
      })
      const store = yield* PlanStore.PlanStore
      const now = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
      const outcome = yield* atomically(
        "could not atomically record the plan",
        Effect.gen(function*() {
          const recorded = yield* store.record(plan, now).pipe(
            Effect.mapError(storeFailure("could not record the plan"))
          )
          yield* emit(JournalRecords.planRecorded(source(`plan/${plan.planId}`), {
            planId: plan.planId,
            flow: plan.flow,
            digest: plan.digest,
            baseDigest: plan.baseDigest,
            generation: plan.generation,
            nodes: plan.nodes.length,
            outcome: recorded._tag,
            // The graph itself, beside the count it has always carried. A
            // reader that only knows how MANY nodes ran cannot show which
            // ones, and the count stays because the CLI's run progress reads
            // it as a number.
            graph: { nodes: plan.nodes.map(nodeSummary) }
          }))
          return recorded
        })
      )
      yield* Effect.annotateCurrentSpan({ outcome: outcome._tag })
      return outcome
    })
  )

  const append: Service["append"] = Effect.fn("PlanScheduler.append")((candidate) =>
    Effect.gen(function*() {
      const plan = yield* verifyPlan(candidate)
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        planId: plan.planId,
        digest: plan.digest,
        generation: plan.generation
      })
      const store = yield* PlanStore.PlanStore
      yield* atomically(
        "could not atomically append the subgraph",
        Effect.gen(function*() {
          yield* store.append(plan).pipe(Effect.mapError(storeFailure("could not append the subgraph")))
          yield* emit(JournalRecords.subgraphAppended(source(`plan/${plan.planId}/${plan.generation}`), {
            planId: plan.planId,
            digest: plan.digest,
            baseDigest: plan.baseDigest,
            generation: plan.generation,
            nodeIds: Plan.generationNodes(plan).map((node) => node.id),
            graph: { nodes: Plan.generationNodes(plan).map(nodeSummary) }
          }))
        })
      )
      yield* Effect.annotateCurrentSpan({ outcome: "appended" })
    })
  )

  const run: Service["run"] = Effect.fn("PlanScheduler.run")((candidate) =>
    Effect.gen(function*() {
      if (Result.isFailure(capturedEnvironment)) {
        return yield* Effect.fail(
          new SchedulerError({
            code: "key_uncomputable",
            message: "the scheduler requires a valid execution environment identity"
          })
        )
      }
      const environment = capturedEnvironment.success
      const environmentDigest = yield* StepKey.environmentIdentity(environment).pipe(Effect.mapError((cause) =>
        new SchedulerError({ code: "key_uncomputable", message: "could not bind the execution environment", cause })
      ))
      const initial = yield* verifyPlan(candidate)
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        planId: initial.planId,
        digest: initial.digest,
        nodes: initial.nodes.length
      })
      const boundaries = yield* StepBoundary.StepBoundary
      const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem)
      const executor = yield* NodeExecutor
      const journal = yield* Journal.Journal
      const inputStore = yield* PlanInputStore.PlanInputStore
      const mergeStore = yield* PlanMergeStore.PlanMergeStore
      const mergeIdentity = {
        runId: options.runId,
        planId: initial.planId,
        baseDigest: initial.baseDigest,
        environmentDigest
      }
      const mergeFailure = (cause: PlanMergeStore.PlanMergeError) =>
        cause.code === "fence_lost"
          ? Effect.interrupt :
          Effect.fail(storeFailure("could not recover or persist the plan's merge decisions")(cause))
      const recoveredMerges = yield* mergeStore.list(mergeIdentity, options.owner).pipe(Effect.catch(mergeFailure))
      const reconciler = Option.getOrElse(
        yield* Effect.serviceOption(Reconciliation.Reconciliation),
        Reconciliation.makeDefault
      )
      const selector = Option.getOrElse(
        yield* Effect.serviceOption(Selection.Selection),
        Selection.makeNoop
      )
      // A verifier composes the scheduler replay-only, as it does the engine:
      // a recorded node replays and a node that would run its body stops.
      const replayOnly = Option.getOrUndefined(yield* Effect.serviceOption(ReplayOnly.ReplayOnly))
      yield* Effect.logDebug("scheduler run started", {
        digest: initial.digest,
        nodes: initial.nodes.length
      })

      // Only a coordinator failure makes interrupted siblings terminal here.
      // Parking, external cancellation and fence loss retain their established
      // recovery semantics. The flag is set before the child scope closes.
      let abortedForFailure = false
      const cleanupErrors: Array<unknown> = []
      let plan = yield* PlanMerges.recover(initial, recoveredMerges).pipe(Effect.catch(mergeFailure))
      const graph = RuntimeGraph.make(plan.nodes)
      const states = graph.states
      const results = new Map<string, unknown>()
      const digestMemo = StepKey.makeDigestMemo()
      const verdicts: Array<{ nodeId: string; verdict: Reconciliation.Verdict }> = []
      const appended: Array<string> = []
      const digestToNode = new Map<string, Array<string>>()
      const deviationSignatures = new Map<string, string>()
      const writers = new Map<string, string>()
      const writerEntries: Array<{ readonly entry: FileSet.Entry; readonly nodeId: string }> = []
      const nodesById = new Map<string, Plan.PlanNode>()
      let cursor: number | undefined = undefined
      const events = yield* Queue.unbounded<CoordinatorEvent>()

      const stateOf = (node: Plan.PlanNode): RuntimeGraph.NodeState =>
        states.get(node.id)!

      /**
       * Reconciliation's first declared owner of each path. Read version
       * selection is different: only a reader's predecessors produce its
       * inputs, never the reader itself or an explicitly later writer.
       */
      const indexWriters = (nodes: ReadonlyArray<Plan.PlanNode>) => {
        for (const node of nodes) {
          nodesById.set(node.id, node)
          for (const entry of [...FileSet.expand(node.effects.writes), ...node.effects.removes ?? []]) {
            writerEntries.push({ entry, nodeId: node.id })
            if (typeof entry === "string" && !writers.has(entry)) {
              writers.set(entry, node.id)
            }
          }
        }
      }
      indexWriters(plan.nodes)

      const writerFor = (path: string): string | undefined =>
        writers.get(path) ?? writerEntries.find(({ entry }) => FileSet.overlaps(entry, path))?.nodeId

      // One bounded traversal per observation/dispatch, not an eager matrix
      // of every node's transitive ancestors. Shared ancestors are visited
      // once, and the temporary set is released after this reader's work.
      const writerScopesBefore = (node: Plan.PlanNode): ReadonlyArray<FileSet.Entry> => {
        const scopes: Array<FileSet.Entry> = []
        graph.visitAncestors(node, (predecessor) => {
          scopes.push(...FileSet.expand(predecessor.effects.writes), ...predecessor.effects.removes ?? [])
        })
        return scopes
      }

      const expandReads = (entries: ReadonlyArray<FileSet.ReadEntry>, what: string) =>
        Effect.gen(function*() {
          const expanded: Array<{ readonly entry: FileSet.ReadEntry; readonly paths: ReadonlyArray<string> }> = []
          for (const entry of entries) {
            if (typeof entry === "string") {
              expanded.push({ entry, paths: [entry] })
              continue
            }
            if (Option.isNone(fileSystem)) {
              return yield* Effect.fail(
                new SchedulerError({
                  code: "boundary_unavailable",
                  message: `the host cannot expand ${what} without a FileSystem`
                })
              )
            }
            // Through `FileEnumeration`, never the host `glob`: host results
            // are absolute under the kernel FileSystem and skip dotfiles, so
            // a workspace-relative pattern silently expanded to nothing.
            const matches = yield* FileEnumeration.expandGlob(fileSystem.value, entry).pipe(
              Effect.mapError((cause) =>
                new SchedulerError({
                  code: "boundary_unavailable",
                  message: `the host could not expand ${what}`,
                  cause
                })
              )
            )
            expanded.push({ entry, paths: matches })
          }
          return expanded
        })

      const prepare = (paths: ReadonlyArray<string>, what: string) =>
        boundaries.prepare({
          readSet: [...new Set(paths)].sort().map((path) => ({ path, digest: unmeasured })),
          writeSet: [],
          boundaryMode: "hard"
        }).pipe(
          Effect.mapError((cause) =>
            new SchedulerError({
              code: "boundary_unavailable",
              message: `the host could not measure ${what}`,
              cause
            })
          )
        )

      const expandProducedMatches = (
        glob: FileSet.Glob,
        writerScopes: ReadonlyArray<FileSet.Entry>,
        what: string
      ) =>
        Effect.gen(function*() {
          const scopes = writerScopes.filter((entry) => FileSet.overlaps(glob, entry))
          if (scopes.length === 0) return []
          if (Option.isNone(fileSystem)) {
            return yield* Effect.fail(
              new SchedulerError({
                code: "boundary_unavailable",
                message: `the host cannot expand ${what} without a FileSystem`
              })
            )
          }
          const paths = new Set<string>()
          for (const entry of scopes) {
            if (typeof entry === "string") {
              // One host call: `stat` reports both whether the producer's
              // output is there yet and what kind of thing it is, so the
              // `exists` probe that used to precede it only doubled the cost.
              // On the confined host each call is one CPython fork
              // (`@smthrs/platform-node/AtomicFileSystem`).
              const info = yield* fileSystem.value.stat(entry).pipe(
                Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
                Effect.mapError((cause) =>
                  new SchedulerError({
                    code: "boundary_unavailable",
                    message: `the host could not expand ${what}`,
                    cause
                  })
                )
              )
              // Exact writer declarations name files; directory outputs use
              // `TreeArtifact`, and only files are members of a read glob. A
              // producer that has not written yet is simply not a candidate.
              if (info?.type === "File") paths.add(entry)
              continue
            }
            const matches = FileSet.isGlob(entry)
              ? yield* FileEnumeration.expandGlob(fileSystem.value, entry).pipe(
                Effect.mapError((cause) =>
                  new SchedulerError({
                    code: "boundary_unavailable",
                    message: `the host could not expand ${what}`,
                    cause
                  })
                )
              )
              : yield* FileEnumeration.filesUnder(fileSystem.value, entry.path).pipe(
                Effect.mapError((cause) =>
                  new SchedulerError({
                    code: "boundary_unavailable",
                    message: `the host could not expand ${what}`,
                    cause
                  })
                )
              )
            for (const path of matches) {
              if (FileSet.matchesGlob(glob, path)) paths.add(path)
            }
          }
          return [...paths].sort()
        })

      // A read declaration is observed only when its node enters this run:
      // generation zero here, or one newly appended generation below. Paths
      // already pinned by an earlier declaration reuse that digest; measuring
      // them again would tear the run. A new source path is measured now,
      // which is its first observation in this run.
      const pinned = new Map<string, string>()
      const observedReads = new Map<string, ReadonlyArray<ObservedRead>>()
      const inputFailure = (cause: PlanInputStore.PlanInputError) =>
        cause.code === "fence_lost"
          ? Effect.interrupt
          : Effect.fail(storeFailure("could not recover or persist the plan's source observations")(cause))
      const observeReads = (
        nodes: ReadonlyArray<Plan.PlanNode>,
        generation: number,
        what: string,
        commit?: (
          snapshot: PlanInputStore.Snapshot
        ) => Effect.Effect<
          PlanInputStore.Snapshot,
          SchedulerError,
          PlanStore.PlanStore | Journal.Journal | Crypto.Crypto
        >
      ) =>
        Effect.gen(function*() {
          const address = {
            runId: options.runId,
            planId: initial.planId,
            baseDigest: initial.baseDigest,
            environmentDigest,
            generation
          }
          const stored = yield* inputStore.get(address, options.owner).pipe(Effect.catch(inputFailure))
          let snapshot: PlanInputStore.Snapshot
          if (Option.isSome(stored)) {
            snapshot = stored.value
          } else {
            const unpinned = new Set<string>()
            const observedNodes: Array<PlanInputStore.Snapshot["nodes"][number]> = []
            for (const node of nodes) {
              const observed: Array<ObservedRead> = []
              const reads = FileSet.expandReads(node.effects.reads)
              const writerScopes = reads.length === 0 ? [] : writerScopesBefore(node)
              for (const { entry, paths } of yield* expandReads(reads, what)) {
                const sourcePaths = paths.filter((path) => !writerScopes.some((scope) => FileSet.overlaps(scope, path)))
                for (const path of sourcePaths) {
                  if (!pinned.has(path)) unpinned.add(path)
                }
                observed.push({ entry, sourcePaths })
              }
              observedNodes.push({ id: node.id, key: node.key, reads: observed })
            }
            const pins = unpinned.size === 0 ? [] : (yield* prepare([...unpinned], what)).readSnapshot
            const measured: PlanInputStore.Snapshot = {
              version: 1,
              generation,
              nodes: observedNodes,
              pins
            }
            yield* PlanInputs.validate(measured, nodes, pinned, writerScopesBefore).pipe(Effect.catch(inputFailure))
            snapshot = commit === undefined
              ? yield* inputStore.record(address, measured, options.owner).pipe(Effect.catch(inputFailure))
              : measured
          }
          if (commit !== undefined) snapshot = yield* commit(snapshot)
          // Do not publish speculative measurements. A competing observation
          // wins durably, and every recovered declaration must still describe
          // this verified plan before it can influence an execution key.
          const nextPins = yield* PlanInputs.validate(snapshot, nodes, pinned, writerScopesBefore).pipe(
            Effect.catch(inputFailure)
          )
          for (const node of snapshot.nodes) observedReads.set(node.id, node.reads)
          for (const [path, digest] of nextPins) pinned.set(path, digest)
        })

      // Recover each generation before any dispatch. Existing observations
      // never enumerate or measure the host again, even after process restart.
      for (let generation = 0; generation <= plan.generation; generation++) {
        yield* observeReads(
          plan.nodes.filter((node) => node.generation === generation),
          generation,
          "the plan's source inputs"
        )
      }
      // A merge intent is authoritative scheduler state, not a failed-action
      // cache entry or a convention inferred from an arbitrary node's body.
      for (const { intent } of recoveredMerges) {
        const state = stateOf(nodesById.get(intent.nodeId)!)
        graph.stage(intent.nodeId, "skipped")
        state.dispatchKey = intent.dispatchKey
        state.attempts = intent.attempts
        state.rebases = intent.rebases
      }
      graph.reconcile()

      const measure = (node: Plan.PlanNode) =>
        Effect.gen(function*() {
          const measured = new Map<string, string>()
          const produced = new Set<string>()
          const observed = observedReads.get(node.id)!
          const writerScopes = observed.length === 0 ? [] : writerScopesBefore(node)
          for (const read of observed) {
            if (typeof read.entry === "string") {
              if (read.sourcePaths.length === 0) produced.add(read.entry)
              else measured.set(read.entry, pinned.get(read.entry)!)
              continue
            }
            for (const path of read.sourcePaths) measured.set(path, pinned.get(path)!)
            // A glob's source membership is frozen above. Dispatch may only
            // add paths derived from preceding writer scopes. Neither an
            // unproduced arrival nor a future writer widens the source world.
            for (const path of yield* expandProducedMatches(read.entry, writerScopes, `the inputs of ${node.id}`)) {
              produced.add(path)
            }
          }
          if (produced.size > 0) {
            // Produced paths are our own outputs, so measuring them once their
            // producer has settled is not re-observing the world.
            const prepared = yield* prepare([...produced], `the inputs of ${node.id}`)
            for (const entry of prepared.readSnapshot) measured.set(entry.path, entry.digest)
          }
          return {
            readSet: [...measured].sort(([left], [right]) => compareText(left, right)).map(([path, digest]) => ({
              path,
              digest
            })),
            writeSet: FileSet.expand(node.effects.writes),
            // Declared removals travel with the boundary: they are what makes
            // an absent declared output legitimate rather than a defect.
            ...(node.effects.removes === undefined ? {} : { removes: node.effects.removes }),
            boundaryMode: node.effects.boundaryMode
          } satisfies FileBoundary
        })

      /**
       * Non-sealed work uses a stable run-local structural scope: it replays
       * durable attempts but never reuses an effect from another invocation.
       * For sealed work:
       *
       * The key a dispatch is recorded under: the node's own declaration
       * folded with the CONTENT of everything it consumes — the digests the
       * host just measured for its files, and the digest of each upstream
       * node's settled output value.
       *
       * Not the plan key. That key folds every upstream key transitively, so
       * an edit anywhere upstream re-ran everything below it even when the
       * edited node's output value was byte-identical. Bazel's
       * `ActionCacheChecker` stops invalidation at unchanged content, and
       * `StepKey.dispatchIdentity` is how this does.
       *
       * The plan key alone could never have been it either: two runs whose
       * input files differ declare the same graph, and serving one the other's
       * result is exactly the staleness the boundary exists to prevent.
       */
      const dispatchKeyFor = (
        node: Plan.PlanNode,
        boundary: FileBoundary,
        settledResults: ReadonlyMap<string, unknown>
      ) =>
        (node.material.kind === "sealed" ?
          StepKey.dispatchIdentity({
            material: node.material,
            results: Object.fromEntries(
              node.material.inputs.flatMap((input) =>
                input._tag === "Ref" ? [[input.from, settledResults.get(input.from)] as const] : []
              )
            ),
            digestMemo,
            environment,
            hermetic: {
              ...boundary,
              readSet: StepBoundary.exactReads(boundary)
            }
          }) :
          StepKey.ordinal({
            runId: options.runId,
            // Stable structural scope, never admission order. The declaration
            // fingerprint prevents a changed plan from reusing an old attempt.
            parentScope: JSON.stringify(["plan-node/v1", initial.planId, node.id, node.key]),
            ordinal: 0,
            tier: node.material.kind
          })).pipe(
            /* v8 ignore next 3 -- verified plans have serializable material, admission resolves every dependency, and successful upstream values already crossed durable serialization; key derivation still exposes its honest failure channel */
            Effect.mapError((cause) =>
              new SchedulerError({ code: "key_uncomputable", message: `could not key ${node.id}`, cause })
            )
          )

      const runtimeStrategyOf = (node: Plan.PlanNode): Plan.RuntimeStrategy =>
        node.conflicts.some((conflict) => conflict.runtime === "stop-merge") ? "stop-merge" : node.runtime

      const markSettled = (node: Plan.PlanNode, outcome: Outcome): void => {
        graph.stage(node.id, outcome)
      }

      const emitSettlement = (node: Plan.PlanNode, sourceSeq?: number) =>
        Effect.gen(function*() {
          const state = stateOf(node)
          const action = actionOf(node)
          yield* emit(JournalRecords.nodeSettled({ ...source(`node/${node.id}/settled`), sourceSeq }, {
            planId: plan.planId,
            nodeId: node.id,
            planKey: node.key,
            dispatchKey: state.dispatchKey,
            outcome: state.outcome,
            attempts: state.attempts,
            rebases: state.rebases,
            ...(action === undefined ? {} : { action })
          }))
          yield* Metric.update(EngineStoreMetrics.node[state.outcome], 1)
        })

      const settle = (node: Plan.PlanNode, outcome: Outcome) => {
        markSettled(node, outcome)
        graph.reconcile()
        return emitSettlement(node)
      }

      const applyVerdict = (nodeId: string, verdict: Reconciliation.Verdict, trigger: string) =>
        Effect.gen(function*() {
          verdicts.push({ nodeId, verdict })
          yield* emit(JournalRecords.nodeReconciled(source(`node/${nodeId}/reconciled/${verdicts.length}`), {
            planId: plan.planId,
            nodeId,
            trigger,
            verdict
          }))
          if (verdict._tag === "Fail") {
            // The scheduler chooses the node it asks about, so a verdict always
            // names one it is tracking.
            graph.stage(nodeId, "failed")
            results.delete(nodeId)
            return
          }
          if (verdict._tag === "Reorder") {
            // Re-plan with the discovered dependency made explicit. It binds
            // work that has not dispatched yet — the deviating node already
            // ran, and rewriting history is what append-only forbids.
            // Persisting the edge is the caller's next elaboration; the
            // verdict is journaled so it can be.
            graph.reorder(nodeId, verdict.dependsOn)
          }
          // `FactorOut` needs no graph surgery: two identical extracted steps
          // collapse to one key by themselves, so the second is a `clean`.
        })

      const dispatch: (
        node: Plan.PlanNode,
        start: DispatchStart
      ) => Effect.Effect<Dispatched, SchedulerError, Requirements> = Effect.fn(
        "PlanScheduler.dispatch"
      )(function*(node: Plan.PlanNode, start: DispatchStart) {
        return yield* Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: options.runId,
            planId: plan.planId,
            nodeId: node.id,
            kind: node.kind,
            planKey: node.key
          })
          // Attempt bookkeeping is local to this fiber. The coordinator owns
          // the durable scheduler state and applies this progress only when it
          // processes the terminal event.
          let dispatchKey = start.dispatchKey
          let attempts = start.attempts
          let rebases = start.rebases
          while (true) {
            const boundary = yield* measure(node)
            const measuredKey = yield* dispatchKeyFor(node, boundary, start.results)
            if (dispatchKey !== "" && dispatchKey !== measuredKey) {
              yield* emit(JournalRecords.nodeInvalidated(source(`node/${node.id}/${attempts}/invalidated`), {
                planId: plan.planId,
                nodeId: node.id,
                planKey: node.key,
                from: dispatchKey,
                to: measuredKey,
                reason: "measured-inputs-changed"
              }))
            }
            dispatchKey = measuredKey
            attempts = attempts + 1
            yield* Effect.annotateCurrentSpan({ dispatchKey, attempt: attempts })
            const action = actionOf(node)
            yield* emit(JournalRecords.nodeScheduled(source(`node/${node.id}/${attempts}`), {
              planId: plan.planId,
              nodeId: node.id,
              kind: node.kind,
              planKey: node.key,
              dispatchKey,
              attempt: attempts,
              priority: node.priority,
              waited: start.waited,
              ...(action === undefined ? {} : { action })
            }))
            const dispatchDigest = yield* Effect.orDie(digestOf(dispatchKey))
            yield* Queue.offer(events, { _tag: "AttemptKeyed", nodeId: node.id, digest: dispatchDigest })
            const ran = yield* Ref.make(false)
            const exit = yield* ActionPersistence.make({
              runId: options.runId,
              owner: options.owner,
              admission,
              cacheAgeVerdict,
              replayOnly,
              sourceId: `${options.sourceId}/node/${node.id}`,
              execute: () =>
                Ref.set(ran, true).pipe(
                  Effect.andThen(executor.execute({ node, attempt: attempts, boundary, inputs: start.inputs }))
                )
            })({
              action: {},
              attempt: attempts,
              key: dispatchKey,
              tier: node.material.kind,
              nondeterministic: node.material.nondeterministic,
              metadata: boundary
            }).pipe(
              Effect.onInterrupt(() =>
                abortedForFailure
                  ? atomically(
                    "could not settle a sibling aborted by scheduler failure",
                    Effect.gen(function*() {
                      const store = yield* AttemptStore.AttemptStore
                      const finishedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
                      const identity = { runId: options.runId, stepKeyDigest: dispatchDigest, attempt: attempts }
                      const finished = yield* store.finish({
                        ...identity,
                        state: "failed",
                        finishedAtMs,
                        error: { code: "scheduler_aborted", message: "A scheduler failure interrupted this attempt" }
                      }, options.owner)
                      // A terminal attempt or a replacement owner already decides
                      // the row. Never overwrite it or emit a contradictory fact.
                      if (finished._tag === "Finished") {
                        yield* emit(JournalRecords.attemptFinished(source(`node/${node.id}/${attempts}/aborted`), {
                          ...identity,
                          state: "failed",
                          reason: "scheduler_aborted"
                        }))
                      }
                    })
                  ).pipe(Effect.catch((cause) =>
                    Effect.sync(() => {
                      cleanupErrors.push(cause)
                    })
                  ))
                  : Effect.void
              ),
              Effect.exit
            )
            if (Exit.isSuccess(exit)) {
              return {
                outcome: (yield* Ref.get(ran)) ? "built" : "clean",
                result: exit.value,
                dispatchKey,
                attempts,
                rebases
              } as const
            }
            // Losing a fence self-interrupts `ActionPersistence`. An
            // interrupted dispatch is the run losing ownership, never a node
            // failure that the scheduler may report and continue past.
            if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt
            // The generic executor supplies no irreversible idempotency or
            // reconciliation contract. A conflict is not proof the effect
            // never happened; neither a retry nor a freshly keyed merge may
            // blindly execute more work after that uncertain result.
            if (!isConflict(exit.cause) || node.material.kind === "irreversible") {
              return { outcome: "failed", dispatchKey, attempts, rebases } as const
            }
            const strategy = runtimeStrategyOf(node)
            if (strategy === "delay-rebase" && rebases < rebaseLimit) {
              // Hold the dependents — they are not ready while this node is in
              // flight — and re-execute against the newly recorded base. The
              // next turn of the loop re-measures, which re-keys, which is a
              // new attempt rather than a retry of the old identity.
              rebases = rebases + 1
              continue
            }
            return { outcome: "conflicted", strategy, dispatchKey, attempts, rebases } as const
          }
        }).pipe(
          Effect.tap((result) => Effect.annotateCurrentSpan({ outcome: result.outcome }))
        )
      })

      /**
       * `stop-merge`: the losing action is stopped and both lanes are routed
       * through an explicit merge node appended to the SAME plan, as an
       * ordinary elaboration. The merge critical section uses this module's
       * restart-or-fail landing contract, so the merge node carries no rebase
       * budget of its own: it lands, or the run has a failed node. There is no
       * worktree-lane surface; that design was removed.
       */
      const appendMerge = (intent: PlanMergeStore.Intent) =>
        Effect.gen(function*() {
          const node = yield* PlanMerges.validateIntent(plan, intent).pipe(Effect.catch(mergeFailure))
          const winners = intent.peers.filter((id) => results.has(id))
          const mergeId = PlanMerges.allocateId(plan, node.id)
          const parentDigest = plan.digest
          const grown = yield* Plan.append(plan, [PlanMerges.draft(node, mergeId, winners)]).pipe(
            Effect.mapError((cause) =>
              new SchedulerError({
                code: "elaboration_failed",
                message: `could not append the merge node for ${node.id}`,
                cause
              })
            )
          )
          // `appendMerge` copies the stopped node's effects byte-for-byte, so
          // re-indexing adds no new writer coverage and cannot turn an
          // already-pinned source path into a producer. The new generation's
          // read declarations have not themselves been observed, however:
          // expand them once now and pin only source paths this run has never
          // measured. Existing pins are always reused.
          yield* observeReads(
            Plan.generationNodes(grown),
            grown.generation,
            `generation ${grown.generation}'s source inputs`,
            (snapshot) =>
              atomically(
                "could not atomically commit the merge extension",
                Effect.gen(function*() {
                  const recorded = yield* inputStore.record(
                    { ...mergeIdentity, generation: grown.generation },
                    snapshot,
                    options.owner
                  )
                    .pipe(Effect.catch(inputFailure))
                  yield* append(grown)
                  yield* mergeStore.complete(mergeIdentity, intent.nodeId, {
                    version: 1,
                    generation: grown.generation,
                    parentDigest,
                    planDigest: grown.digest,
                    mergeId,
                    mergeKey: Plan.generationNodes(grown)[0]!.key,
                    winners
                  }, options.owner).pipe(Effect.catch(mergeFailure))
                  return recorded
                })
              )
          )
          // No asynchronous boundary may expose only part of this admission.
          // Frozen generations preserve the indexed prefix and its state.
          const suffix = Plan.generationNodes(grown)
          graph.append(suffix)
          plan = grown
          indexWriters(suffix)
          appended.push(mergeId)
        })

      const pendingSettlements: Array<DispatchSettlementEvent> = []
      const registerAttempt = (event: Extract<CoordinatorEvent, { readonly _tag: "AttemptKeyed" }>) => {
        const dispatchedUnder = digestToNode.get(event.digest)
        if (dispatchedUnder === undefined) {
          digestToNode.set(event.digest, [event.nodeId])
        } else if (!dispatchedUnder.includes(event.nodeId)) {
          digestToNode.set(event.digest, [...dispatchedUnder, event.nodeId])
        }
      }
      /**
       * Absorbs every report already offered without processing another node's
       * settlement. Attempt-key reports update attribution state immediately;
       * terminal reports stay ordered in `pendingSettlements` for the one-at-a-
       * time coordinator. A deviation can appear in a journal page only after
       * its attempt-key report was offered, so calling this after each page
       * closes the journal/queue observation race without a shared mutable map.
       */
      const drainReportedEvents = Effect.gen(function*() {
        while (true) {
          const next = yield* Queue.poll(events)
          if (Option.isNone(next)) return
          if (next.value._tag === "AttemptKeyed") registerAttempt(next.value)
          else pendingSettlements.push(next.value)
        }
      })

      const nextSettlement = Effect.gen(function*() {
        const pending = pendingSettlements.shift()
        if (pending !== undefined) return pending
        while (true) {
          const event = yield* Queue.take(events)
          if (event._tag === "DispatchSettled") return event
          registerAttempt(event)
        }
      })

      /**
       * The first consumer `flows.engine.expected-set-deviation` has ever had.
       * The events are read from the journal rather than from the attempt row
       * on purpose: a deviation is a durable, replayable fact, and consuming
       * the fact keeps this seam usable by anything else that reads the
       * journal.
       *
       * Two properties the drain owes the reconciler, both of them about not
       * letting arrival order decide a verdict:
       *
       * 1. **Attribute the whole page before judging any of it.** Deviating on
       *    the same paths is a *symmetric* fact — two steps that both ran
       *    `npm install` — so registering each signature as the entry was
       *    judged answered the same situation two different ways: the first
       *    node saw no peer and was failed, and only the second was factored
       *    out. Every deviation on the page is attributed first, so both sides
       *    of a pair see each other.
       * 2. **Drain the journal, not one page of it.** Concurrent dispatches can
       *    journal more records than one page holds, and the final completion
       *    is the one that matters: nothing follows it to pick up what a single
       *    page left behind, so a deviation past the cursor would never reach
       *    the seam.
       */
      const pendingDeviations: Array<{
        readonly nodeId: string
        readonly signature: string
        readonly payload: typeof DeviationPayload.Type
      }> = []
      const drainDeviations = Effect.gen(function*() {
        let hasMore = true
        while (hasMore) {
          const page = yield* journal.entries({
            runId: options.runId as JournalEvent.RunId,
            ...(cursor === undefined ? {} : { after: cursor as JournalEvent.Seq }),
            limit: 512
          }).pipe(Effect.mapError(storeFailure("could not read the run's journal")))
          // Every deviation in this page causally follows its attempt-key
          // report. Absorb those reports now, after the journal read, so even
          // an in-flight sibling can be attributed without dispatch fibers
          // mutating coordinator state.
          yield* drainReportedEvents
          const attributed: Array<{ nodeId: string; signature: string; payload: typeof DeviationPayload.Type }> = []
          for (const entry of page.entries) {
            cursor = entry.seq
            if (entry.eventType !== "flows.engine.expected-set-deviation") continue
            const payload = decodeDeviation(entry.payload)
            if (Option.isNone(payload)) continue
            const nodeIds = digestToNode.get(payload.value.stepKeyDigest)
            if (nodeIds === undefined) continue
            // The attempt belongs to an executing node by construction. If
            // its built settlement is absent from current bookkeeping — the
            // record arrived first, or is being durably replayed into an
            // all-clean invocation — preserve first dispatch order.
            const nodeId = nodeIds.find((candidate) => states.get(candidate)!.outcome === "built") ?? nodeIds[0]!
            const signature = JSON.stringify([
              "expected-set-deviation/v1",
              [...new Set(payload.value.paths)].sort(compareText)
            ])
            deviationSignatures.set(nodeId, signature)
            attributed.push({ nodeId, signature, payload: payload.value })
          }
          pendingDeviations.push(...attributed)
          for (let index = 0; index < pendingDeviations.length;) {
            const { nodeId, payload, signature } = pendingDeviations[index]!
            // A concurrent dispatch can durably journal its deviation before
            // its terminal event reaches the head of the coordinator queue.
            // Its signature participates in symmetric attribution now, but
            // its verdict waits until that node's settlement is processed.
            if (states.get(nodeId)?.status !== "settled") {
              index = index + 1
              continue
            }
            const alsoDeviatedBy = [...deviationSignatures.entries()]
              .filter(([other, otherSignature]) => other !== nodeId && otherSignature === signature)
              .map(([other]) => other)
            // Null prototype: a reconciler's lookup of a path named `toString` must miss.
            const declaredBy: Record<string, string> = Object.assign(
              Object.create(null),
              Object.fromEntries(
                payload.paths.flatMap((path) => {
                  const owner = writerFor(path)
                  return owner === undefined ? [] : [[path, owner] as const]
                })
              )
            )
            const verdict = yield* reconciler.onDeviation({
              nodeId,
              keyDigest: payload.stepKeyDigest,
              attempt: payload.attempt,
              paths: payload.paths,
              diffIdentity: payload.diffIdentity,
              declaredBy,
              alsoDeviatedBy
            })
            yield* applyVerdict(nodeId, verdict, "deviation")
            pendingDeviations.splice(index, 1)
          }
          hasMore = page.hasMore
        }
      })

      /**
       * The selection consult, once per run, against the initial plan and the
       * pinned belief snapshot (`docs/guides/defer-work-with-selection.md`). Only sinks,
       * nodes nothing in the plan depends on,
       * are offered, because deferring a node something consumes would block
       * or corrupt its consumers. A verdict may postpone or propose, never
       * remove: `Admit` is a no-op, a `Defer` marks the sink for the loop
       * below, a `Propose` is journaled and nothing more (v1 never
       * auto-appends), and a Defer naming a non-sink — or a Propose naming
       * anything the plan already accounts for, its flow included — is
       * ignored and journaled as an inconsistency observation, against the
       * same `present` set the layer was shown. The `full` override skips
       * the consult entirely: nothing is deferred and nothing is proposed
       * under it, and the override record is what makes that visible.
       * Elaboration cannot
       * invalidate the marks: an appended merge node depends only on nodes
       * that produced results, and a deferred node never executes, so a
       * deferred sink can never gain a dependent mid-run.
       */
      const deferrals = new Map<string, { edge: Selection.SuspectedEdge; likelihood: number }>()
      if (options.selection?.full === true) {
        yield* emit(JournalRecords.selectionOverridden(source("selection/override"), {
          planId: plan.planId,
          mode: "full"
        }))
      } else {
        const dependedOn = new Set(plan.nodes.flatMap((node) => node.dependsOn))
        const sinks = plan.nodes.filter((node) => !dependedOn.has(node.id))
        const present = new Set([plan.flow, ...plan.nodes.map((node) => node.id)])
        const sinkIds = new Set(sinks.map((node) => node.id))
        const selected = yield* selector.select({
          changed: options.selection?.changed ?? [],
          sinks: sinks.map((node) => ({ nodeId: node.id, planKey: node.key })),
          present: [...present],
          beliefs: options.selection?.beliefs ?? { pinnedAtMs: 0, edges: [] },
          policy: options.selection?.policy ?? { deferBelow: 0 }
        })
        for (let index = 0; index < selected.length; index++) {
          const { nodeId, verdict } = selected[index]!
          if (verdict._tag === "Admit") continue
          if (verdict._tag === "Defer" && sinkIds.has(nodeId)) {
            deferrals.set(nodeId, { edge: verdict.edge, likelihood: verdict.likelihood })
            continue
          }
          if (verdict._tag === "Propose" && !present.has(nodeId)) {
            yield* emit(JournalRecords.selectionProposed(source(`selection/proposed/${index}`), {
              planId: plan.planId,
              flow: verdict.flow,
              edge: verdict.edge,
              confidence: verdict.confidence
            }))
            continue
          }
          yield* emit(JournalRecords.selectionInconsistent(source(`selection/inconsistent/${index}`), {
            planId: plan.planId,
            nodeId,
            verdict: verdict._tag,
            reason: verdict._tag === "Defer" ? "not-a-deferrable-sink" : "proposes-a-present-node"
          }))
        }
      }

      const passiveSettlements = Effect.gen(function*() {
        while (true) {
          const blocked = graph.blocked()
          // Halt, not continue-on-failure: a dependent of failed work never
          // dispatches. Repeating this pass makes the skip cascade settle in
          // dependency order before any newly exposed work is admitted.
          for (const node of blocked) yield* settle(node, "skipped")
          if (blocked.length > 0) continue
          // A deferral is a postponement, never a removal, and it only takes
          // effect on work that was genuinely runnable: a marked sink whose
          // cone failed settled `skipped` above instead, because work that
          // could not have run is not a debt. The debt record precedes the
          // settlement so `Selection.debt` reads them in cause-then-effect
          // order.
          const ready = graph.ready()
          const postponed = ready.filter((node) => deferrals.has(node.id))
          for (const node of postponed) {
            const debt = deferrals.get(node.id)!
            yield* emit(JournalRecords.selectionDeferred(source(`node/${node.id}/selection-deferred`), {
              planId: plan.planId,
              nodeId: node.id,
              planKey: node.key,
              edge: debt.edge,
              likelihood: debt.likelihood
            }))
            yield* settle(node, "deferred")
          }
          if (postponed.length > 0) continue
          return ready
        }
      })

      const dispatchStart = (node: Plan.PlanNode): DispatchStart => {
        const state = stateOf(node)
        const settledResults = new Map<string, unknown>()
        const inputs: Array<ResolvedInput> = []
        for (const input of node.material.inputs) {
          if (input._tag !== "Ref") continue
          const value = results.get(input.from)
          settledResults.set(input.from, value)
          // Admission proved every dependency settled successfully; `settle`
          // records even an `undefined` result in the map, so every material
          // Ref has a value to project here.
          inputs.push({ from: input.from, path: input.path, value: StepKey.project(value, input.path) })
        }
        return {
          dispatchKey: state.dispatchKey,
          attempts: state.attempts,
          rebases: state.rebases,
          waited: state.waited,
          results: settledResults,
          inputs
        }
      }

      let admissions = 0
      yield* Effect.scoped(
        Effect.gen(function*() {
          let inFlightSteps = 0
          let inFlightAgents = 0
          const pendingMerges: Array<PlanMergeStore.Intent> = recoveredMerges
            .filter((decision) => decision.completion === undefined).map((decision) => decision.intent)

          const appendReadyMerges = Effect.gen(function*() {
            for (let index = 0; index < pendingMerges.length;) {
              const pending = pendingMerges[index]!
              if (pending.peers.some((peer) => states.get(peer)?.status !== "settled")) {
                index = index + 1
                continue
              }
              yield* appendMerge(pending)
              pendingMerges.splice(index, 1)
            }
          })

          // Passive failure/selection propagation can settle the last peer of
          // a recovered intent without a dispatch event. Recheck merges until
          // neither propagation nor an append exposes more scheduling work.
          const advance = Effect.gen(function*() {
            while (true) {
              const ready = yield* passiveSettlements
              const before = plan.generation
              yield* appendReadyMerges
              if (plan.generation === before) return ready
            }
          })

          const admit = (ready: ReadonlyArray<Plan.PlanNode>) =>
            Effect.gen(function*() {
              const decision = scheduling.admit(
                graph.candidates(ready),
                { steps: inFlightSteps, agents: inFlightAgents }
              )
              const admitted = decision.admitted.map(({ node }) => node)
              // Event-driven aging: this admission pass considered every ready
              // node, and only capacity can leave one behind.
              for (const { node, waited } of decision.deferred) {
                stateOf(node).waited = waited
              }
              if (admitted.length > 0) {
                admissions = admissions + 1
                yield* Effect.annotateCurrentSpan({ admissions })
                yield* Metric.update(EngineStoreMetrics.schedulerAdmissions, 1)
                yield* Effect.logDebug("scheduler admission launched", {
                  admission: admissions,
                  ready: ready.length,
                  admitted: admitted.length,
                  agents: decision.agents,
                  inFlightSteps,
                  inFlightAgents
                })
              }
              const launches = admitted.map((node) => {
                const start = dispatchStart(node)
                graph.start(node.id)
                inFlightSteps = inFlightSteps + 1
                if (node.kind === "agent") inFlightAgents = inFlightAgents + 1
                return { node, start }
              })
              for (const { node, start } of launches) {
                yield* dispatch(node, start).pipe(
                  Effect.trackDuration(EngineStoreMetrics.schedulerDispatchDuration),
                  Effect.exit,
                  Effect.flatMap((exit) => Queue.offer(events, { _tag: "DispatchSettled", node, exit })),
                  Effect.asVoid,
                  Effect.forkScoped({ startImmediately: true })
                )
              }
            })

          // Repair a settlement missing after a crash without appending the
          // same stopped decision again when its original record survived.
          for (const { intent } of recoveredMerges) yield* emitSettlement(nodesById.get(intent.nodeId)!, 0)
          yield* Effect.flatMap(advance, admit)
          while (graph.remaining > 0) {
            // Compiled plans are acyclic, inferred edges refuse cycle closure,
            // and discovered edges point only from undispatched nodes to the
            // already-settled node whose verdict added them, so pending work
            // with nothing in flight cannot have an empty ready set. If an
            // invariant breaks anyway, fail loudly: returning here would
            // report unsettled nodes with their initial outcome as success.
            /* v8 ignore next 7 -- unreachable while the invariants above hold */
            if (inFlightSteps === 0) {
              return yield* Effect.die(
                new Error(
                  `PlanScheduler invariant broken: ${graph.remaining} nodes are pending and nothing is in flight`
                )
              )
            }
            const event = yield* nextSettlement
            if (Exit.isFailure(event.exit)) return yield* Effect.failCause(event.exit.cause)

            const node = event.node
            const result = event.exit.value
            const state = stateOf(node)
            inFlightSteps = inFlightSteps - 1
            if (node.kind === "agent") inFlightAgents = inFlightAgents - 1
            state.dispatchKey = result.dispatchKey
            state.attempts = result.attempts
            state.rebases = result.rebases

            switch (result.outcome) {
              case "built":
              case "clean":
                results.set(node.id, result.result)
                markSettled(node, result.outcome)
                break
              case "failed":
                markSettled(node, "failed")
                break
              case "conflicted": {
                if (result.strategy === "stop-merge") {
                  const intent = yield* atomically(
                    "could not persist the stopped-attempt decision",
                    Effect.gen(function*() {
                      const intent = yield* mergeStore.intend(mergeIdentity, {
                        version: 1,
                        nodeId: node.id,
                        nodeKey: node.key,
                        dispatchKey: state.dispatchKey,
                        attempts: state.attempts,
                        rebases: state.rebases,
                        peers: node.conflicts.map((conflict) => conflict.with)
                          .filter((peer) => states.get(peer)?.status === "running" || results.has(peer))
                      }, options.owner).pipe(Effect.catch(mergeFailure))
                      yield* PlanMerges.validateIntent(plan, intent).pipe(Effect.catch(mergeFailure))
                      return intent
                    })
                  )
                  markSettled(node, "skipped")
                  // The former dispatch barrier guaranteed that every
                  // conflicting sibling admitted beside this node had reported
                  // its result before `appendMerge` selected winners. Preserve
                  // that semantic boundary only for those already-running
                  // peers; unrelated work never holds the merge cone.
                  state.dispatchKey = intent.dispatchKey
                  state.attempts = intent.attempts
                  state.rebases = intent.rebases
                  pendingMerges.push(intent)
                  break
                }
                const verdict = yield* reconciler.onConflict({
                  nodeId: node.id,
                  keyDigest: state.dispatchKey,
                  attempt: state.attempts,
                  rebases: state.rebases,
                  strategy: result.strategy,
                  conflictsWith: node.conflicts.map((conflict) => conflict.with)
                })
                markSettled(node, "failed")
                yield* applyVerdict(node.id, verdict, "materialization-conflict")
                break
              }
            }

            yield* appendReadyMerges

            // The dispatch durably journalled every deviation before its event.
            // Apply those verdicts before consulting downstream readiness.
            yield* drainDeviations
            // A dispatch outcome is provisional until its deviations have been
            // reconciled. Persist exactly one terminal fact, after a Fail
            // verdict has had the chance to replace built with failed.
            yield* emitSettlement(node)
            graph.reconcile()
            // Process terminal events already observed by the journal drain
            // before opening more permits. This preserves fail-fast behavior for
            // an already-failed sibling while still admitting immediately when
            // unrelated work is genuinely still in flight.
            const ready = yield* advance
            if (pendingSettlements.length === 0) yield* admit(ready)
          }
        }).pipe(Effect.onError((cause) =>
          Effect.sync(() => {
            abortedForFailure = cause.reasons.some((reason) => reason._tag === "Fail")
          })
        ))
      ).pipe(Effect.catch((error) =>
        Effect.fail(
          cleanupErrors.length === 0 ? error : new SchedulerError({
            code: error.code,
            message: error.message,
            cause: error.cause,
            cleanupErrors
          })
        )
      ))

      const settlements = plan.nodes.map((node) => {
        const state = stateOf(node)
        return {
          nodeId: node.id,
          planKey: node.key,
          dispatchKey: state.dispatchKey,
          outcome: state.outcome,
          attempts: state.attempts,
          rebases: state.rebases
        }
      })
      yield* Effect.logDebug("scheduler run completed", {
        admissions,
        built: settlements.filter((settlement) => settlement.outcome === "built").length,
        clean: settlements.filter((settlement) => settlement.outcome === "clean").length,
        failed: settlements.filter((settlement) => settlement.outcome === "failed").length,
        skipped: settlements.filter((settlement) => settlement.outcome === "skipped").length,
        deferred: settlements.filter((settlement) => settlement.outcome === "deferred").length
      })
      return {
        planId: plan.planId,
        digest: plan.digest,
        settlements,
        results: Object.fromEntries(results),
        verdicts,
        appended
      }
    }).pipe(
      Effect.annotateSpans({ runId: options.runId }),
      Effect.annotateLogs({ runId: options.runId }),
      Effect.onExit((exit) => Effect.annotateCurrentSpan({ outcome: EngineStoreMetrics.exitTag(exit).toLowerCase() }))
    )
  )

  return { record, append, run }
}

/**
 * Provides a scheduler bound to one run.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: Options): Layer.Layer<PlanScheduler> => Layer.succeed(PlanScheduler, make(options))

/**
 * What {@link recertify} returns: the repaying run's id, its report, and the
 * deferring run's remaining debt after the repayment is counted.
 *
 * @since 0.1.0
 * @category models
 */
export interface RecertifyResult {
  readonly runId: string
  readonly report: Report
  readonly remaining: ReadonlyArray<Selection.DebtEntry>
}

/**
 * The recertification driver: re-drives a compiled plan under a fresh,
 * caller-supplied run with the `full` selection override — guess-free by
 * construction — then reports the deferring run's remaining debt via
 * `Selection.debt(deferringRunId, { repaidBy: [options.runId] })`.
 *
 * The design draft placed this beside the other Selection helpers; it lives
 * here because it constructs a scheduler, and `Selection` must stay
 * type-only toward this module to keep the dependency graph acyclic. The
 * deferring run's journal is never written — repayment is a read-side join.
 * Scheduling the cadence (nightly, per-merge) stays a product concern; this
 * is only the primitive one pass runs.
 *
 * @since 0.1.0
 * @category combinators
 */
export const recertify = Effect.fn("PlanScheduler.recertify")(
  (input: {
    readonly plan: Plan.Plan
    readonly deferringRunId: string
    readonly options: Options
  }) =>
    Effect.gen(function*() {
      const scheduler = make({
        ...input.options,
        selection: { ...input.options.selection, full: true }
      })
      const report = yield* scheduler.run(input.plan)
      const remaining = yield* Selection.debt(input.deferringRunId, { repaidBy: [input.options.runId] })
      return { runId: input.options.runId, report, remaining } satisfies RecertifyResult
    })
)
