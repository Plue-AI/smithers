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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CliError from "../CliError.ts"
import { databasePath } from "../internal/ControlDatabasePath.ts"
import * as DatabaseLocation from "../internal/DatabaseLocation.ts"
import { executionDatabasePath } from "../internal/ExecutionDatabasePath.ts"
import type * as NativeControl from "../internal/NativeControl.ts"
import * as NodeControl from "../NodeControl.ts"
import * as Project from "../Project.ts"

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
 * The seams a verification runs over; tests supply the flow modules a host
 * would load.
 *
 * @since 1.0.0
 * @category models
 */
export interface Options {
  readonly modules?: NativeControl.ModuleRegistration | undefined
  /** How long the resumed copy may take to stop; defaults to ten minutes. */
  readonly settleWithin?: Duration.Input | undefined
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

/** A consistent copy of one SQLite store, read in a single read transaction. */
const snapshot = (from: string, to: string) => reading(from, Effect.flatMap(SqlClient, (sql) => sql`VACUUM INTO ${to}`))

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
  const engineFile = executionDatabasePath(root)
  const controlFile = databasePath(root)
  if (DatabaseLocation.postgres(engineFile)) {
    throw refused("user", "verify_unsupported_backend", "runs verify reads a local SQLite store")
  }
  if (!DatabaseLocation.exists(engineFile) || !DatabaseLocation.exists(controlFile)) {
    throw refused("user", "history_missing", `No execution history at ${Project.stateDirectory(root)}`)
  }
  const scratch = mkdtempSync(join(tmpdir(), "smthrs-verify-"))
  try {
    const copies = Project.stateDirectory(scratch)
    mkdirSync(copies, { recursive: true })
    const observed: Array<ReplayOnly.Dispatch> = []
    const program = Effect.gen(function*() {
      const steps = yield* recordedSteps(engineFile, runId)
      yield* snapshot(engineFile, executionDatabasePath(scratch))
      yield* snapshot(controlFile, databasePath(scratch))
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry, { stateRoot: scratch })
      const control = NodeControl.layerControl(
        {
          root,
          stateRoot: scratch,
          replayOnly: ReplayOnly.layer((dispatch) => Effect.sync(() => observed.push(dispatch))),
          // A replay-only run never reaches a completion to judge, so it needs no model seat.
          evaluator: Evaluator.layerUnavailable()
        },
        registry,
        engine,
        options.modules
      )
      yield* Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const before = yield* runtime.getRun(runId)
        yield* (yield* Control.Control).resume({
          runId: runId,
          idempotencyKey: `verify:${runId}`,
          allowCodeDrift: true
        })
        yield* settled(runId, before.updatedAt).pipe(
          Effect.timeoutOrElse({
            duration: options.settleWithin ?? "10 minutes",
            orElse: () =>
              Effect.fail(refused("wait", "verify_timeout", `The copy of ${runId} did not stop replaying in time`))
          })
        )
      }).pipe(Effect.provide(Layer.merge(control, engine.runtime)), Effect.scoped)
      // The drive may have spawned runs the original never recorded.
      const runs = new Set(yield* reading(executionDatabasePath(scratch), tree(runId)))
      return { steps, runs }
    })
    const { steps, runs } = await Effect.runPromise(program, { signal })
    const own = observed.filter((dispatch) => runs.has(dispatch.runId))
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
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
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
