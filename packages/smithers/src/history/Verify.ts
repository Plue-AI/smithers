/**
 * `smthrs runs verify`: what a resume under the current code would replay and
 * what it would execute again.
 *
 * A step is recorded under a key the engine derives at dispatch from the
 * flow's own declaration, ordinal and scope, so only the engine can say
 * whether current code still derives a recorded key. The verifier copies the
 * project's stores, resumes the run on the copy under a replay-only engine
 * (`@smthrs/engine-store/ReplayOnly`) and reads back what each dispatch did:
 * a recorded step served from its record replays, and the first step no record
 * serves stops the run before its body. The original stores are only read.
 *
 * `--against <engine.db>` verifies every run stored in that engine store (with
 * the `control.db` beside it) under the project's current flows. A SQLite store
 * is copied with `VACUUM INTO`; a PostgreSQL one schema by schema
 * (`StoreCopy`).
 *
 * @since 1.0.0
 */

import { Control, ControlRuntime } from "@smthrs/control"
import type { RunId } from "@smthrs/control/ControlSchema"
import * as Dialect from "@smthrs/database/Dialect"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as ReplayOnly from "@smthrs/engine-store/ReplayOnly"
import * as Evaluator from "@smthrs/model/Evaluator"
import { type Duration, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import * as CliError from "../CliError.ts"
import { databasePath } from "../internal/ControlDatabasePath.ts"
import type * as Application from "../Application.ts"
import * as DatabaseLocation from "../internal/DatabaseLocation.ts"
import { executionDatabasePath } from "../internal/ExecutionDatabasePath.ts"
import type * as NativeControl from "../internal/NativeControl.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"
import * as StoreCopy from "./StoreCopy.ts"

/**
 * One step of the run, by the key its attempts are recorded under.
 *
 * `action` is the declared action name and `node` the graph node that drove
 * the dispatch, each when the record names it.
 *
 * @since 1.0.0
 * @category models
 */
export interface Step {
  readonly stepKeyDigest: string
  readonly action?: string | undefined
  readonly node?: string | undefined
}

/**
 * What a resume under the current code would do.
 *
 * `replayed` are dispatches served from a durable record. `resumes` is a
 * recorded step that never finished, which the resume would re-enter.
 * `executes` is the first dispatch no record serves, where the resume would
 * run code again.
 * `notReplayed` are recorded successful steps the resume never asked for:
 * dropped or re-keyed by the current code. A run is `divergent` when a
 * recorded step goes unreplayed while the resume executes; one that replays
 * everything it recorded before executing new work is `consistent`.
 *
 * @since 1.0.0
 * @category models
 */
export interface Report {
  readonly runId: string
  readonly verdict: "consistent" | "divergent"
  readonly replayed: ReadonlyArray<Step>
  readonly resumes?: Step | undefined
  readonly executes?: Step | undefined
  readonly notReplayed: ReadonlyArray<Step>
}

/**
 * A run the store holds that no resume can take: it already settled.
 *
 * @since 1.0.0
 * @category models
 */
export interface Settled {
  readonly runId: string
  readonly status: "completed" | "failed" | "cancelled"
}

/**
 * What resuming every run a store holds would do: one {@link Report} per run a
 * resume can take, the settled runs it cannot, and the runs whose resume was
 * refused ({@link Unverified}). The store is `divergent` when any report is.
 *
 * @since 1.0.0
 * @category models
 */
export interface Summary {
  readonly verdict: "consistent" | "divergent"
  readonly reports: ReadonlyArray<Report>
  readonly settled: ReadonlyArray<Settled>
  readonly unverified: ReadonlyArray<Unverified>
}

/**
 * The seams a verification runs over; tests supply the flow modules a host
 * would load.
 *
 * @since 1.0.0
 * @category models
 */
export interface Options {
  readonly modules?: NativeControl.ModuleRegistration | undefined
  /** How long each resumed copy may take to stop; defaults to ten minutes. */
  readonly settleWithin?: Duration.Input | undefined
  /**
   * The engine store to verify, with the `control.db` beside it; the
   * project's own `.flows/engine.db` by default. The flows are always the
   * project's.
   */
  readonly against?: string | undefined
}

const refused = (fault: CliError.Fault, code: string, message: string): CliError.Refused =>
  new CliError.Refused({ fault, code, message })

/**
 * `runId` and every run it spawned: a delegate flow's steps run in a child
 * execution of the run a control plane launched.
 */
const tree = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient
    const spawned = (yield* Dialect.tables(sql)).some((table) => table.name === "flows_run_parents")
    const runs = [runId]
    for (let index = 0; index < runs.length; index++) {
      const parent = runs[index]!
      const children = yield* sql<{ run_id: string }>`SELECT run_id FROM flows_runs WHERE parent_run_id = ${parent}`
      const edges = spawned
        ? yield* sql<{ run_id: string }>`SELECT child_id AS run_id FROM flows_run_parents WHERE parent_id = ${parent}`
        : []
      for (const child of [...children, ...edges]) if (!runs.includes(child.run_id)) runs.push(child.run_id)
    }
    return runs
  })

/** The successful steps the original store recorded, named where a node record names them. */
const recorded = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient
    const steps: Array<Step> = []
    for (const runId of runIds) {
      const attempts = yield* sql<{ step_key_digest: string }>`
        SELECT DISTINCT step_key_digest FROM flows_attempts WHERE run_id = ${runId} AND state = 'succeeded'
        ORDER BY step_key_digest`
      const names = new Map<string, { action?: string; node?: string }>()
      const settled = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM flows_journal_events
        WHERE run_id = ${runId} AND event_type = 'flows.engine.node-settled' ORDER BY seq`
      for (const row of settled) {
        const payload = JSON.parse(row.payload_json) as {
          nodeId?: unknown
          action?: unknown
          stepKeyDigests?: unknown
        }
        if (!Array.isArray(payload.stepKeyDigests)) continue
        for (const digest of payload.stepKeyDigests) {
          if (typeof digest !== "string") continue
          names.set(digest, {
            ...(typeof payload.action === "string" ? { action: payload.action } : {}),
            ...(typeof payload.nodeId === "string" ? { node: payload.nodeId } : {})
          })
        }
      }
      for (const row of attempts) steps.push({ stepKeyDigest: row.step_key_digest, ...names.get(row.step_key_digest) })
    }
    return steps
  })

/** Reads `body` from one store, read-only. */
const reading = <A, E>(filename: string, body: Effect.Effect<A, E, SqlClient>) =>
  body.pipe(Effect.provide(NodeDatabase.layer({ filename, readOnly: true })))

/**
 * The successful steps `runId` and the runs it spawned recorded in the store at
 * `filename`, which is only read.
 *
 * @since 1.0.0
 * @category constructors
 */
export const recordedSteps = (filename: string, runId: string): Effect.Effect<ReadonlyArray<Step>, unknown> =>
  reading(filename, Effect.flatMap(tree(runId), recorded))

/** The run once it has moved past `since` and stopped moving. */
const settled = (runId: RunId, since: number) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    while (true) {
      const run = yield* runtime.getRun(runId)
      if (run.updatedAt > since && run.status !== "running" && run.status !== "accepted") return run
      yield* Effect.sleep("20 millis")
    }
  })

/** The stores a verification reads: the project's, or an engine store and the control store beside it. */
const storesOf = (root: string, against: string | undefined): Application.Databases => {
  if (against === undefined) return { engine: executionDatabasePath(root), control: databasePath(root) }
  const engine = resolve(against)
  return { engine, control: join(dirname(engine), "control.db") }
}

/** The runs the control store launched, oldest first. */
const storedRuns = (control: string) =>
  reading(
    control,
    Effect.flatMap(SqlClient, (sql) => sql<{ run_id: string }>`SELECT run_id FROM control_runs ORDER BY created_seq`)
  ).pipe(Effect.map((rows) => rows.map((row) => row.run_id)))

const terminal = (status: string): status is Settled["status"] =>
  status === "completed" || status === "failed" || status === "cancelled"

/**
 * A run the store holds that verification could not resume, with the refusal's
 * own code: a run another host still owns, or a copy that did not stop in time.
 *
 * @since 1.0.0
 * @category models
 */
export interface Unverified {
  readonly runId: string
  readonly code: string
  readonly message: string
}

/** What one target's verification came to. */
type Outcome =
  | { readonly _tag: "Report"; readonly report: Report }
  | { readonly _tag: "Settled"; readonly settled: Settled }

/** The code and sentence a typed refusal carries, for a run a bulk verification skips. */
const unverified = (runId: string, error: unknown): Unverified => {
  const own = error as { readonly code?: unknown; readonly _tag?: unknown; readonly message?: unknown }
  return {
    runId,
    code: typeof own.code === "string" ? own.code : typeof own._tag === "string" ? own._tag : "verify_failed",
    message: typeof own.message === "string" ? own.message : String(error)
  }
}

/**
 * Removes every copy that exists, each attempt independent of the others, and
 * refuses when one could not be removed: a leaked scratch schema is named, not
 * silently kept.
 */
const discardAll = (copies: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const left: Array<string> = []
    for (const copy of copies) {
      const exit = yield* Effect.exit(StoreCopy.discard(copy))
      if (exit._tag === "Failure") left.push(StoreCopy.postgres(copy)?.schema ?? copy)
    }
    if (left.length > 0) {
      return yield* Effect.die(
        refused("infra", "verify_cleanup_failed", `Verification could not remove its copies: ${left.join(", ")}`)
      )
    }
  })

/**
 * Resumes a fresh copy of one run replay-only under the project's flows. The
 * baseline is read from that same copy, so both sides are one moment of the
 * store, and no other run's resume has touched it. `all` reports a settled
 * run apart instead of resuming it.
 */
const one = (
  root: string,
  stores: Application.Databases,
  runId: string,
  options: Options,
  all: boolean
): Effect.Effect<Outcome, unknown> =>
  Effect.gen(function*() {
    const scratch = mkdtempSync(join(tmpdir(), "smthrs-verify-"))
    // Named apart from the originals, and short: an environment-selected
    // PostgreSQL schema is its prefix plus the file's basename, so `engine.db`
    // again would be the original's schema.
    const id = randomBytes(4).toString("hex")
    const copies: Application.Databases = {
      engine: join(Project.stateDirectory(scratch), `v${id}e.db`),
      control: join(Project.stateDirectory(scratch), `v${id}c.db`)
    }
    const made: Array<string> = []
    const observed: Array<ReplayOnly.Dispatch> = []
    return yield* Effect.gen(function*() {
      mkdirSync(Project.stateDirectory(scratch), { recursive: true })
      for (const copy of [copies.engine, copies.control]) {
        const schema = StoreCopy.postgres(copy)?.schema
        if (schema !== undefined && Buffer.byteLength(schema) > 63) {
          return yield* Effect.fail(refused(
            "user",
            "verify_schema_too_long",
            `The scratch schema ${schema} is longer than PostgreSQL allows; shorten SMITHERS_POSTGRES_SCHEMA`
          ))
        }
      }
      for (const [from, to] of [[stores.engine, copies.engine], [stores.control, copies.control]] as const) {
        yield* StoreCopy.copy(from, to)
        made.push(to)
      }
      const steps = yield* recordedSteps(copies.engine, runId)
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry, { stateRoot: scratch, databases: copies })
      const control = NodeControl.layerControl(
        {
          root,
          stateRoot: scratch,
          databases: copies,
          replayOnly: ReplayOnly.layer((dispatch) => Effect.sync(() => observed.push(dispatch))),
          // A replay-only run never reaches a completion to judge, so it needs no model seat.
          evaluator: Evaluator.layerUnavailable()
        },
        registry,
        engine,
        options.modules
      )
      const drove = yield* Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const before = yield* runtime.getRun(runId as RunId)
        if (all && terminal(before.status)) return { runId, status: before.status } satisfies Settled
        yield* (yield* Control.Control).resume({
          runId: runId as RunId,
          idempotencyKey: `verify:${runId}`,
          allowCodeDrift: true
        })
        yield* settled(runId as RunId, before.updatedAt).pipe(
          Effect.timeoutOrElse({
            duration: options.settleWithin ?? "10 minutes",
            orElse: () =>
              Effect.fail(refused("wait", "verify_timeout", `The copy of ${runId} did not stop replaying in time`))
          })
        )
        return undefined
      }).pipe(Effect.provide(Layer.merge(control, engine.runtime)), Effect.scoped)
      if (drove !== undefined) return { _tag: "Settled", settled: drove } satisfies Outcome
      // The drive may have spawned runs the original never recorded.
      const runs = new Set(yield* reading(copies.engine, tree(runId)))
      return {
        _tag: "Report",
        report: report(runId, steps, observed.filter((dispatch) => runs.has(dispatch.runId)))
      } satisfies Outcome
    }).pipe(
      // Only copies this verification made are removed: a copy that failed
      // rolled its own schema back, and nothing else is ever dropped.
      Effect.ensuring(Effect.suspend(() => discardAll(made))),
      Effect.ensuring(Effect.sync(() => rmSync(scratch, { recursive: true, force: true })))
    )
  })

/** The stores a verification reads, refused when they are not there. */
const existing = (root: string, options: Options): Application.Databases => {
  const stores = storesOf(root, options.against)
  if (!DatabaseLocation.exists(stores.engine) || !DatabaseLocation.exists(stores.control)) {
    throw refused("user", "history_missing", `No execution history at ${dirname(stores.engine)}`)
  }
  return stores
}

/** One run's report from what its original recorded and what its copy dispatched. */
const report = (runId: string, steps: ReadonlyArray<Step>, own: ReadonlyArray<ReplayOnly.Dispatch>): Report => {
  const name = (dispatch: ReplayOnly.Dispatch): Step => ({
    ...steps.find((step) => step.stepKeyDigest === dispatch.stepKeyDigest),
    stepKeyDigest: dispatch.stepKeyDigest,
    action: dispatch.action
  })
  const replayed = own.filter((dispatch) => dispatch.outcome === "replayed").map(name)
  const first = own.find((dispatch) => dispatch.outcome === "would-execute")
  const resumed = own.find((dispatch) => dispatch.outcome === "resumes")
  const served = new Set(replayed.map((step) => step.stepKeyDigest))
  const notReplayed = steps.filter((step) => !served.has(step.stepKeyDigest))
  return {
    runId,
    verdict: first !== undefined && notReplayed.length > 0 ? "divergent" : "consistent",
    replayed,
    ...(resumed === undefined ? {} : { resumes: name(resumed) }),
    ...(first === undefined ? {} : { executes: name(first) }),
    notReplayed
  }
}

/**
 * Resumes a copy of `runId` replay-only under the flows on disk and reports
 * which recorded steps replay and which step would execute.
 *
 * @since 1.0.0
 * @category constructors
 */
export const verify = async (
  root: string,
  runId: string,
  options: Options = {},
  signal?: AbortSignal
): Promise<Report> => {
  const stores = existing(root, options)
  const outcome = await Effect.runPromise(one(root, stores, runId, options, false), { signal })
  // A named run is always resumed, so it always reports.
  return (outcome as Extract<Outcome, { readonly _tag: "Report" }>).report
}

/**
 * Resumes a fresh copy of every run the store holds replay-only under the
 * flows on disk, one after another, and reports each. Settled runs are listed
 * apart, and a run whose resume was refused (another host still owns it, or
 * its copy did not stop in time) is listed with the refusal instead of ending
 * the whole verification.
 *
 * @since 1.0.0
 * @category constructors
 */
export const verifyAll = async (root: string, options: Options = {}, signal?: AbortSignal): Promise<Summary> => {
  const stores = existing(root, options)
  return Effect.runPromise(
    Effect.gen(function*() {
      const reports: Array<Report> = []
      const done: Array<Settled> = []
      const skipped: Array<Unverified> = []
      for (const runId of yield* storedRuns(stores.control)) {
        const outcome = yield* Effect.result(one(root, stores, runId, options, true))
        if (outcome._tag === "Failure") skipped.push(unverified(runId, outcome.failure))
        else if (outcome.success._tag === "Report") reports.push(outcome.success.report)
        else done.push(outcome.success.settled)
      }
      return {
        verdict: reports.some((each) => each.verdict === "divergent") ? "divergent" : "consistent",
        reports,
        settled: done,
        unverified: skipped
      } satisfies Summary
    }),
    { signal }
  )
}

/**
 * The refusal a divergent report exits with: the step that would run again
 * and the recorded steps that would not replay.
 *
 * @since 1.0.0
 * @category constructors
 */
export const divergence = (report: Report): CliError.Refused => {
  const label = (step: Step) => step.action ?? step.node ?? step.stepKeyDigest
  const dropped = report.notReplayed.map(label).join(", ")
  return refused(
    "user",
    "run_divergent",
    `Resuming ${report.runId} would execute ${report.executes === undefined ? "new work" : label(report.executes)} ` +
      `again; ${report.notReplayed.length} recorded step(s) would not replay: ${dropped}`
  )
}

/**
 * The refusal a divergent store exits with: every divergent run's sentence.
 *
 * @since 1.0.0
 * @category constructors
 */
export const storeDivergence = (summary: Summary): CliError.Refused =>
  refused(
    "user",
    "run_divergent",
    summary.reports.filter((each) => each.verdict === "divergent").map((each) => divergence(each).message).join("\n")
  )
