/**
 * Persistent history reads and mutation/control reconciliation.
 * @since 1.0.0
 */

import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as AgentSession from "@smthrs/agent/AgentSession"
import { Control, ControlRuntime } from "@smthrs/control"
import * as Dialect from "@smthrs/database/Dialect"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import { Journal, SqlJournal } from "@smthrs/journal"
import type { Entry, RunId, Seq } from "@smthrs/journal/JournalEvent"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { EffectBoundary, ReadOnlyTimeTravel, SqlTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
import { forkWorkspaceName, type Position } from "@smthrs/time-travel/TimeTravel"
import type { CarriedChild, StepOverride } from "@smthrs/time-travel/TimeTravelStore"
import { TimeTravelStore } from "@smthrs/time-travel/TimeTravelStore"
import { Cause, Context, Effect, Exit, Layer, type Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import * as CliError from "../CliError.ts"
import * as ControlDatabaseMigrations from "../internal/ControlDatabaseMigrations.ts"
import * as DatabaseLocation from "../internal/DatabaseLocation.ts"
import type * as NativeControl from "../internal/NativeControl.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"
import * as Projection from "./Projection.ts"
import * as Workspace from "./Workspace.ts"

/**
 * Local history address and resource limits.
 * @since 1.0.0
 * @category models
 */
export interface Options {
  readonly root?: string | undefined
  readonly remote?: string | undefined
  readonly sequence?: number | undefined
  readonly lineage?: string | undefined
  readonly limit?: number | undefined
  /** Rewind only: restore the frame's jj operation instead of only its tree. */
  readonly wholeRepo?: boolean | undefined
  /** Fork only: the step result the child replays in place of the parent's. */
  readonly override?: StepOverride | undefined
  /**
   * Fork only: the root input the child runs with in place of the parent's.
   * It is planned and approved as a plan of its own, which the child is bound
   * to; every recorded step whose key it leaves unchanged still replays.
   */
  readonly input?: Schema.Json | undefined
  /** The flow modules a host would load, for planning an edited input; tests supply them. */
  readonly modules?: NativeControl.ModuleRegistration | undefined
}

/**
 * Resolve local history using the CLI's project and environment rules.
 * @since 1.0.0
 * @category constructors
 */
export { localRoot } from "../Project.ts"

/** A history request this CLI refuses: whose problem it is, a stable code, and the sentence. */
const refused = (fault: CliError.Fault, code: string, message: string): CliError.Refused =>
  new CliError.Refused({ fault, code, message })

/** The journal answered the same page twice, so reading on would never end. */
const stalledPagination = (): CliError.Refused =>
  refused(
    "bug",
    "history_pagination_stalled",
    "The run history stopped advancing while it was being read. Not your fault."
  )

const requireDatabase = (root: string): string => {
  const file = NodeControl.executionDatabasePath(root)
  if (!DatabaseLocation.exists(file)) throw refused("user", "history_missing", `No execution history at ${file}`)
  return file
}

const readStorage = (root: string) =>
  Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer, CacheStore.layer).pipe(
    Layer.provideMerge(
      DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({
        filename: requireDatabase(root),
        readOnly: true
      })))
    )
  )

const readerLayer = (root: string) => TimeTravel.readOnly.pipe(Layer.provideMerge(readStorage(root)))
const writerLayer = (root: string, workspace: string) => {
  const persistent = SqlTimeTravelStore.layer.pipe(
    Layer.provideMerge(NodeRuntime.storage(requireDatabase(root), workspace))
  )
  // Startup recovery may restore a worktree. Only recover audits belonging
  // to the worktree bound to this service; other hosts will recover theirs.
  const stores = Layer.effect(TimeTravelStore)(Effect.gen(function*() {
    const store = yield* TimeTravelStore
    return {
      ...store,
      pendingAudits: () =>
        store.pendingAudits().pipe(
          Effect.flatMap((audits) =>
            Effect.filter(audits, (audit) =>
              Effect.promise(async () => await Workspace.workspaceFor(root, audit.runId) === workspace))
          )
        )
    }
  })).pipe(Layer.provideMerge(persistent))
  return TimeTravel.layerWith({ isAlive: Ownership.sameHostPidProbe }).pipe(
    Layer.provideMerge(stores),
    Layer.provide(NodeJj.layerAt(workspace)),
    Layer.provide(NodeServices.layer),
    Layer.provide(NodeCrypto.layer)
  )
}

const runEffect = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, { signal })
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
  return exit.value
}

const lineageOf = (entry: Entry): string | undefined => {
  const meta = entry.meta as { readonly lineageId?: unknown } | null
  return typeof meta?.lineageId === "string" ? meta.lineageId : undefined
}

/** Resolves an exact stored frame; a supplied sequence must exist in this run. */
const resolvePosition = (runId: string, options: Options) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    const journal = yield* Journal.Journal
    let after: Seq | undefined
    let target: Entry | undefined
    let first: Entry | undefined
    let count = 0
    const limit = options.limit ?? 10_000
    while (true) {
      const page = yield* journal.entries({
        runId: runId as RunId,
        limit: 250,
        ...(after === undefined ? {} : { after })
      })
      for (const entry of page.entries) {
        first ??= entry
        if (options.sequence !== undefined && entry.seq > options.sequence) break
        if (++count > limit) {
          throw new CliError.UsageError({ message: `History exceeds --limit ${limit}; increase it explicitly` })
        }
        if (options.lineage === undefined || lineageOf(entry) === options.lineage) target = entry
      }
      const tail = page.entries.at(-1)?.seq
      if (!page.hasMore || tail === undefined || (options.sequence !== undefined && tail >= options.sequence)) break
      if (after !== undefined && tail <= after) throw stalledPagination()
      after = tail
    }
    const sequence = options.sequence ?? target?.seq
    const lineage = options.lineage ?? (target === undefined ? undefined : lineageOf(target)) ??
      (first === undefined ? undefined : lineageOf(first))
    if (sequence === undefined || lineage === undefined) {
      throw refused("user", "history_frame_missing", `Run ${runId} has no addressable execution history`)
    }
    if (sequence !== 0 && target?.seq !== sequence) {
      throw refused(
        "user",
        "history_frame_missing",
        `Run ${runId} has no frame at sequence ${sequence} in this lineage`
      )
    }
    return { row, position: { runId, frame: { lineageId: lineage, seq: sequence } } satisfies Position }
  })

/**
 * Reads the stored prefix without executing effects or startup recovery.
 * @since 1.0.0
 * @category constructors
 */
export const read = async (root: string, runId: string, options: Options, replay: boolean, signal?: AbortSignal) =>
  runEffect(
    Effect.gen(function*() {
      const { row, position } = yield* resolvePosition(runId, options)
      const reader = yield* ReadOnlyTimeTravel
      const fold = Projection.make(replay)
      const result = fold.finish(
        position.frame.seq === 0
          ? fold.initial
          : yield* reader.replay(position, fold, { maxHistoryEntries: options.limit ?? 10_000 })
      )
      return {
        position,
        executionFlow: (JSON.parse(row.stateJson) as { flowName?: string } | null)?.flowName,
        status: row.status,
        parentRunId: row.parentRunId,
        ...result,
        ...(replay ? {} : { events: undefined })
      }
    }).pipe(Effect.provide(readerLayer(root)), Effect.scoped),
    signal
  )

/**
 * Lists exactly the suffix/effects a rewind would cross; never mutates it.
 * @since 1.0.0
 * @category constructors
 */
export const preview = async (root: string, runId: string, options: Options, signal?: AbortSignal) =>
  runEffect(
    Effect.gen(function*() {
      const { row, position } = yield* resolvePosition(runId, options)
      const journal = yield* Journal.Journal
      const entries: Array<Entry> = []
      let after = position.frame.seq as Seq
      while (true) {
        const page = yield* journal.entries({ runId: runId as RunId, after, limit: 250 })
        entries.push(...page.entries)
        if (entries.length > (options.limit ?? 10_000)) {
          throw new CliError.UsageError({ message: "Rewind suffix exceeds --limit" })
        }
        const tail = page.entries.at(-1)?.seq
        if (!page.hasMore || tail === undefined) break
        if (tail <= after) throw stalledPagination()
        after = tail
      }
      const effects = yield* EffectBoundary.fromEntries(entries)
      return {
        preview: true,
        position,
        status: row.status,
        entriesToArchive: entries.length,
        effects,
        blockedEffects: effects.filter((effect) => effect.tier !== "sealed"),
        active: row.owner !== null || row.claim !== null,
        requiresConfirmation: true
      }
    }).pipe(Effect.provide(readStorage(root)), Effect.scoped),
    signal
  )

const clients = (root: string) =>
  Effect.gen(function*() {
    const file = NodeControl.databasePath(root)
    if (!DatabaseLocation.exists(file)) {
      throw refused(
        "user",
        "history_unsupported_run",
        "This operation requires a public CLI run with an approved control plan"
      )
    }
    const control = Context.get(
      yield* Layer.build(
        ControlDatabaseMigrations.layer.pipe(Layer.provideMerge(NodeDatabase.layer({ filename: file })))
      ),
      SqlClient
    )
    const engine = Context.get(yield* Layer.build(NodeDatabase.layer({ filename: requireDatabase(root) })), SqlClient)
    return { engine, control }
  })

const hasTable = (sql: SqlClient, name: string) =>
  Dialect.tables(sql).pipe(Effect.map((rows) => rows.some((row) => row.name === name)))
const controlSummary = (sql: SqlClient, runId: string, allowActive = false) =>
  Effect.gen(function*() {
    const [row] = yield* sql<
      { state_json: string; status: string; owner_nonce: string | null; claim_nonce: string | null }
    >`SELECT state_json,status,owner_nonce,claim_nonce FROM flows_runs WHERE run_id=${runId}`
    if (row === undefined) {
      throw refused(
        "user",
        "history_unsupported_run",
        `No control-plane run ${runId}; use the TimeTravel API for standalone engine executions`
      )
    }
    if (!allowActive && (row.status === "running" || row.owner_nonce !== null || row.claim_nonce !== null)) {
      throw refused("wait", "run_active", `Run ${runId} is active or claimed; park it before changing history`)
    }
    const summary = JSON.parse(row.state_json) as Record<string, unknown>
    if (typeof summary.planId !== "string" || typeof summary.flowId !== "string") {
      throw refused("policy", "plan_not_approved", `Run ${runId} has no approved public CLI plan`)
    }
    const [plan] = yield* sql<{ decision: string }>`SELECT decision FROM control_plans WHERE plan_id=${summary.planId}`
    if (plan?.decision !== "approved") {
      throw refused("policy", "plan_not_approved", `Run ${runId}'s plan is not approved`)
    }
    return summary
  })

const parkedSummary = (summary: Record<string, unknown>, runId: string, parentRunId?: string) => ({
  ...summary,
  runId,
  status: "parked",
  updatedAt: Date.now(),
  ...(parentRunId === undefined ? {} : { parentRunId, createdAt: Date.now() }),
  ownerId: undefined,
  parkedBy: undefined,
  waitingReason: undefined
})

const parkControl = (sql: SqlClient, runId: string, summary: Record<string, unknown>) =>
  Effect.gen(function*() {
    const changed = yield* sql`UPDATE flows_runs SET status='suspended', state_json=${
      JSON.stringify(parkedSummary(summary, runId))
    }, finished_at_ms=NULL, cancel_requested_at_ms=NULL, waiting_reason='history', waiting_wake_at_ms=NULL, waiting_token=NULL WHERE run_id=${runId} AND status <> 'running' AND owner_nonce IS NULL AND claim_nonce IS NULL RETURNING run_id`
    if (changed.length !== 1) {
      throw refused("wait", "run_active", `Run ${runId} acquired an owner during history reconciliation`)
    }
    if (yield* hasTable(sql, "control_run_resumes")) yield* sql`DELETE FROM control_run_resumes WHERE run_id=${runId}`
  })

/** The identity a run bound to an approved plan records: its card's digest and execution digest. */
const approvedBinding = (control: SqlClient, planId: string) =>
  Effect.gen(function*() {
    const [plan] = yield* control<
      { card_json: string; decision: string }
    >`SELECT card_json,decision FROM control_plans WHERE plan_id=${planId}`
    if (plan?.decision !== "approved") {
      throw refused("policy", "plan_not_approved", `Plan ${planId} is not approved`)
    }
    const card = JSON.parse(plan.card_json) as { digest: string; executionDigest?: string }
    return {
      planId,
      planDigest: card.digest,
      ...(card.executionDigest === undefined ? {} : { executionDigest: card.executionDigest })
    }
  })

/**
 * The engine child a module run executes its flow in, and the execution digest
 * its id was derived from, when the run spawned one (`AgentSession.moduleExecutionId`).
 */
const moduleChild = (engine: SqlClient, control: SqlClient, runId: string, summary: Record<string, unknown>) =>
  Effect.gen(function*() {
    const [plan] = yield* control<{ card_json: string }>`SELECT card_json FROM control_plans WHERE plan_id=${summary
      .planId as string}`
    const digests = [
      plan === undefined ? undefined : (JSON.parse(plan.card_json) as { executionDigest?: unknown }).executionDigest,
      summary.executionDigest
    ].filter((digest): digest is string => typeof digest === "string")
    for (const executionDigest of digests) {
      const runIdOfChild = AgentSession.moduleExecutionId(runId, executionDigest)
      if ((yield* engine`SELECT 1 FROM flows_runs WHERE run_id=${runIdOfChild}`).length > 0) {
        return { runId: runIdOfChild, executionDigest }
      }
    }
    return undefined
  })

/**
 * Plans and approves `input` as a new plan of the run's flow, the way `flow
 * start` does, under the budget the run was approved with.
 */
const planInput = (root: string, runId: string, input: Schema.Json, modules: Options["modules"]) =>
  Effect.gen(function*() {
    const { control } = yield* readClients(root)
    const summary = yield* controlSummary(control, runId)
    const [plan] = yield* control<{ card_json: string }>`SELECT card_json FROM control_plans WHERE plan_id=${summary
      .planId as string}`
    const budget = (JSON.parse(plan!.card_json) as { envelope: { budget: Control.PlanInput["budget"] } })
      .envelope.budget
    // The project root is also the persisted history's state location. Give
    // planning and the native engine the same database authority, while keeping
    // execution-only settings on the application composition.
    const config = {
      root,
      stateRoot: root,
      startsRuns: false,
      plansFlows: true,
      evaluator: Evaluator.layerUnavailable()
    }
    const registry = NodeControl.layerRegistry(root)
    const engine = NodeControl.engineDurable(root, registry, config)
    return yield* Effect.gen(function*() {
      const service = yield* Control.Control
      const card = yield* service.plan({ flowId: summary.flowId as string, input, budget })
      if (card.envelope.capabilities.includes("*")) {
        throw refused(
          "policy",
          "plan_not_approved",
          `The edited input's plan grants every capability ("*"); review it with \`smthrs flow plan\` and approve it`
        )
      }
      yield* service.approve({ ...card.approval, scope: "run" })
      // The input as the plan stores it, after its schema's defaults: what
      // the run reads back and what its module child is invoked with.
      const stored = yield* (yield* ControlRuntime.ControlRuntime).getPlan(card.planId)
      return {
        planId: card.planId,
        executionDigest: card.executionDigest,
        input: stored.decodedInput as Schema.Json
      }
    }).pipe(
      Effect.provide(Layer.merge(NodeControl.layerControl(config, registry, engine, modules), engine.runtime))
    )
  }).pipe(Effect.scoped)

const linkFork = (engine: SqlClient, control: SqlClient, root: string, childId: string, parentId: string) =>
  Effect.gen(function*() {
    const summary = yield* controlSummary(control, parentId, true)
    const workspace = join(Project.stateDirectory(root), "forks", forkWorkspaceName(childId))
    if (!existsSync(join(workspace, ".jj"))) {
      throw refused("user", "fork_unavailable", `Fork ${childId} has no retained workspace at ${workspace}`)
    }
    const existing = yield* control`SELECT 1 FROM flows_runs WHERE run_id=${childId}`
    if (existing.length === 0) {
      const [row] = yield* engine<
        { state_json: string; status: string }
      >`SELECT state_json,status FROM flows_runs WHERE run_id=${childId}`
      if (row === undefined || row.status === "running") {
        throw refused("user", "fork_unavailable", `Fork ${childId} is absent or already active`)
      }
      const state = JSON.parse(row.state_json) as { flowName?: unknown; payload?: { planId?: unknown } } | null
      if (state?.flowName !== "agent/run") {
        throw refused(
          "user",
          "history_unsupported_run",
          `Fork ${childId} is not a public agent flow and cannot be resumed by this CLI`
        )
      }
      // A fork with an edited input runs under the plan that input was
      // approved as, and its own engine payload names it. Reading it from
      // there rather than from the caller keeps a crash between the engine
      // commit and this link on the same plan.
      const planId = state.payload?.planId
      const bound = typeof planId === "string" && planId !== summary.planId
        ? { ...summary, ...(yield* approvedBinding(control, planId)) }
        : summary
      yield* control`INSERT INTO flows_runs(run_id,status,created_at_ms,parent_run_id,state_json) VALUES(${childId},'suspended',${Date.now()},${parentId},${
        JSON.stringify(parkedSummary(bound, childId, parentId))
      })`
    }
    yield* engine.withTransaction(Effect.gen(function*() {
      yield* engine`CREATE TABLE IF NOT EXISTS smthrs_history_workspaces(run_id TEXT PRIMARY KEY, workspace TEXT NOT NULL)`
      yield* engine`INSERT INTO smthrs_history_workspaces(run_id,workspace) VALUES(${childId},${workspace}) ON CONFLICT(run_id) DO NOTHING`
    }))
    return workspace
  })

/** The payload the run's engine execution was started with. */
const enginePayload = (engine: SqlClient, runId: string) =>
  Effect.gen(function*() {
    const [row] = yield* engine<{ state_json: string }>`SELECT state_json FROM flows_runs WHERE run_id=${runId}`
    const payload = (JSON.parse(row!.state_json) as { payload?: unknown }).payload
    return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {}
  })

const readOnly = (filename: string) => NodeDatabase.layer({ filename, readOnly: true })

/** Both stores opened read-only, for a scan that must not write. */
const readClients = (root: string) =>
  Effect.gen(function*() {
    const control = Context.get(yield* Layer.build(readOnly(NodeControl.databasePath(root))), SqlClient)
    const engine = Context.get(yield* Layer.build(readOnly(requireDatabase(root))), SqlClient)
    return { engine, control }
  })

/** Committed engine history the control projection has not caught up with. */
const gaps = (engine: SqlClient, control: SqlClient) =>
  Effect.gen(function*() {
    // An unmigrated control.db projects nothing yet: every fork edge and
    // completed audit is pending, so the writable pass migrates and rescans.
    const projected = yield* hasTable(control, "flows_runs")
    const forks: Array<{ child_run_id: string; parent_run_id: string }> = []
    if (yield* hasTable(engine, "flows_time_travel_edges")) {
      for (
        const fork of yield* engine<
          { child_run_id: string; parent_run_id: string }
        >`SELECT child_run_id,parent_run_id FROM flows_time_travel_edges WHERE kind='fork' ORDER BY rowid`
      ) {
        if (!projected) {
          forks.push(fork)
          continue
        }
        if ((yield* control`SELECT 1 FROM flows_runs WHERE run_id=${fork.child_run_id}`).length > 0) continue
        if ((yield* control`SELECT 1 FROM flows_runs WHERE run_id=${fork.parent_run_id}`).length === 0) continue
        forks.push(fork)
      }
    }
    const audits: Array<{ id: string; run_id: string }> = []
    if (yield* hasTable(engine, "flows_time_travel_audits")) {
      // A control.db from before the history rung has no ledger: every audit is pending.
      const ledger = projected && (yield* hasTable(control, "smthrs_history_applied"))
      for (
        const audit of yield* engine<
          { id: string; run_id: string }
        >`SELECT id,run_id FROM flows_time_travel_audits WHERE status='completed' ORDER BY rowid`
      ) {
        if (ledger && (yield* control`SELECT 1 FROM smthrs_history_applied WHERE audit_id=${audit.id}`).length > 0) {
          continue
        }
        audits.push(audit)
      }
    }
    return { forks, audits }
  })

/** Repairs committed engine history and its durable control projection.
 *
 * The stores are scanned read-only first; a writable connection, and the
 * control migrations it runs, are opened only when a gap is pending.
 * @category constructors
 * @since 1.0.0
 */
export const reconcile = async (root: string): Promise<void> => {
  if (
    !DatabaseLocation.exists(NodeControl.executionDatabasePath(root)) ||
    !DatabaseLocation.exists(NodeControl.databasePath(root))
  ) return
  await runEffect(Effect.gen(function*() {
    const pending = yield* Effect.scoped(
      Effect.flatMap(readClients(root), ({ control, engine }) => gaps(engine, control))
    )
    if (pending.forks.length === 0 && pending.audits.length === 0) return
    yield* Effect.scoped(Effect.gen(function*() {
      const { engine, control } = yield* clients(root)
      yield* control.withTransaction(Effect.gen(function*() {
        const { forks, audits } = yield* gaps(engine, control)
        for (const fork of forks) yield* linkFork(engine, control, root, fork.child_run_id, fork.parent_run_id)
        for (const audit of audits) {
          const [row] = yield* engine<{ status: string }>`SELECT status FROM flows_runs WHERE run_id=${audit.run_id}`
          if (row?.status === "suspended") {
            yield* parkControl(control, audit.run_id, yield* controlSummary(control, audit.run_id))
          }
          yield* control`INSERT INTO smthrs_history_applied(audit_id) VALUES(${audit.id})`
        }
      }))
    }))
  }))
}

/** Fork or rewind a run and reconcile its durable control identity.
 * @category constructors
 * @since 1.0.0
 */
export const mutate = async (
  root: string,
  runId: string,
  options: Options,
  operation: "fork" | "rewind",
  signal?: AbortSignal
) => {
  const observed = await read(root, runId, options, false, signal)
  if (operation === "fork" && observed.executionFlow !== "agent/run") {
    throw refused(
      "user",
      "history_unsupported_run",
      `Run ${runId} is not a public agent flow; use the TimeTravel API for standalone engine forks`
    )
  }
  const workspace = await Workspace.workspaceFor(root, runId)
  if (workspace === undefined) {
    throw refused("user", "fork_unavailable", `Fork ${runId} needs history reconciliation before it can be used`)
  }
  const edited = operation === "fork" && options.input !== undefined
    ? await runEffect(planInput(root, runId, options.input, options.modules), signal)
    : undefined
  return runEffect(
    Effect.scoped(Effect.gen(function*() {
      const { engine, control } = yield* clients(root)
      return yield* control.withTransaction(Effect.gen(function*() {
        const summary = yield* controlSummary(control, runId)
        if (operation === "fork") mkdirSync(join(Project.stateDirectory(root), "forks"), { recursive: true })
        const payload = operation === "fork" ? yield* enginePayload(engine, runId) : undefined
        const child = operation === "fork" ? yield* moduleChild(engine, control, runId, summary) : undefined
        const result = yield* Effect.gen(function*() {
          const service = yield* TimeTravel
          return operation === "fork" ?
            {
              kind: "fork" as const,
              result: yield* service.fork(observed.position, {
                workspaceRoot: join(Project.stateDirectory(root), "forks"),
                retainWorkspace: true,
                maxHistoryEntries: options.limit ?? 10_000,
                ...(options.override === undefined ? {} : { override: options.override }),
                // The child is a run of its own: its payload names it, so its
                // module execution is its own child rather than the parent's,
                // and carries the steps the parent's recorded.
                rebind: (childRunId) =>
                  Effect.succeed({
                    payload: {
                      ...payload,
                      runId: childRunId,
                      ...(edited === undefined ? {} : { planId: edited.planId })
                    },
                    children: child === undefined ? [] : [
                      {
                        from: child.runId,
                        to: AgentSession.moduleExecutionId(
                          childRunId,
                          edited?.executionDigest ?? child.executionDigest
                        ),
                        ...(edited === undefined ? {} : { payload: { input: edited.input } })
                      } satisfies CarriedChild
                    ]
                  })
              })
            } :
            {
              kind: "rewind" as const,
              result: yield* service.rewind(observed.position, {
                maxHistoryEntries: options.limit ?? 10_000,
                ...(options.wholeRepo === true ? { wholeRepo: true } : {})
              })
            }
        }).pipe(Effect.provide(writerLayer(root, workspace)), Effect.scoped)
        if (result.kind === "fork") {
          const childWorkspace = yield* linkFork(engine, control, root, result.result.runId, runId)
          return {
            ...result.result,
            workspace: childWorkspace,
            status: "parked",
            next: `smthrs runs resume ${result.result.runId}`
          }
        }
        yield* parkControl(control, runId, summary)
        yield* control`INSERT INTO smthrs_history_applied(audit_id) VALUES(${result.result.auditId}) ON CONFLICT DO NOTHING`
        return { ...result.result, runId, status: "parked", next: `smthrs runs resume ${runId}` }
      }))
    })),
    signal
  )
}

/** Resolves a committed workspace before resuming execution.
 * @category constructors
 * @since 1.0.0
 */
export const prepare = async (root: string, runId: string): Promise<{ readonly executionRoot: string }> => {
  await reconcile(root)
  const workspace = await Workspace.workspaceFor(root, runId)
  if (workspace === undefined) {
    throw refused("user", "fork_unavailable", `Fork ${runId} has not been linked to its workspace`)
  }
  if (!existsSync(workspace)) throw refused("user", "fork_unavailable", `Run workspace no longer exists: ${workspace}`)
  return { executionRoot: workspace }
}
