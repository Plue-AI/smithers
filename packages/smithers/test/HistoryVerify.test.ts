/**
 * `runs verify` resumes a copy of a parked run under a replay-only engine and
 * reports which recorded steps the current code replays and which it would
 * execute again, without touching the project's own stores.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlRuntime } from "@smthrs/control"
import type { RunId } from "@smthrs/control/ControlSchema"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Cli } from "incur"
import { randomUUID } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"

import { appendHistoryCommands } from "../src/cli/HistoryCommands.ts"
import * as Verify from "../src/history/Verify.ts"
import * as NodeControl from "../src/NodeControl.ts"

const moduleSource = `import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default ({ effects: undefined, name:"steps",description:"Steps",input:Schema.Unknown,output:Schema.Json,capabilities:[],flows:["test/Steps"] })
`

const ran: Array<string> = []
const step = (name: string) =>
  Action.make(name, {
    payload: {},
    success: Schema.String,
    tier: "irreversible",
    idempotencyKey: name
  })
const First = step("verify/first")
const Second = step("verify/second")
const Renamed = step("verify/second-renamed")

/** The `test/Steps` delegate: two steps, then a park on a human task. */
const modulesFor = (second: typeof Second) => {
  const Steps = Flow.make("test/Steps", {
    payload: Executable.Invocation,
    success: Schema.Json,
    error: HumanTask.HumanTaskFailed,
    body: () =>
      First.call({}).pipe(
        Node.bindPlanned(() => second.call({})),
        Node.bindPlanned(() => HumanTask.action.call({ name: "probe", kind: "ask", prompt: "Go?", maxAttempts: 3 }))
      )
  })
  const implement = (action: typeof Second) =>
    action.toLayer(() =>
      Effect.sync(() => {
        ran.push(action.name)
        return action.name
      })
    )
  return Executable.layer({
    delegates: [Steps],
    load: () =>
      Effect.succeed({
        default: ({
          name: "steps",
          description: "Steps",
          input: Schema.Unknown,
          output: Schema.Json,
          capabilities: [],
          flows: ["test/Steps"]
        })
      })
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(Interpreter.layer(Steps), HumanTask.layer, implement(First), implement(Second), implement(Renamed))
        .pipe(Layer.provideMerge(Action.layerImplementations))
    ),
    Layer.orDie
  )
}

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  ran.length = 0
})

/** A project whose `steps` runs recorded both steps and parked on their task; `cancelled` more are then cancelled. */
const parkedProject = async (runs = 1, cancelled = 0) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-verify-"))
  roots.push(root)
  mkdirSync(join(root, "flows", "steps"), { recursive: true })
  writeFileSync(join(root, "flows", "steps", "flow.ts"), moduleSource)
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const runIds = await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const runtime = yield* ControlRuntime.ControlRuntime
      const launch = (key: string) =>
        Effect.gen(function*() {
          const card = yield* control.plan({ flowId: "steps", input: { key } })
          yield* control.approve(card.approval)
          const launched = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: key
          })
          if (launched._tag !== "Accepted" || launched.runId === undefined) return yield* Effect.die("not accepted")
          for (let attempt = 0; attempt < 1_000; attempt++) {
            const run = yield* runtime.getRun(launched.runId)
            if (run.status === "parked") return launched.runId
            yield* Effect.sleep("10 millis")
          }
          return yield* Effect.die("the run never parked")
        })
      const ids: Array<RunId> = []
      for (let index = 0; index < runs + cancelled; index++) ids.push(yield* launch(`start-${index}`))
      for (const runId of ids.slice(runs)) {
        yield* control.cancel({ runId, idempotencyKey: `cancel-${runId}`, reason: "fixture" })
        for (let attempt = 0; attempt < 1_000; attempt++) {
          if ((yield* runtime.getRun(runId)).status === "cancelled") break
          yield* Effect.sleep("10 millis")
        }
      }
      return ids
    }).pipe(
      Effect.provide(Layer.merge(
        NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, engine, modulesFor(Second)),
        Layer.merge(engine.runtime, registry)
      )),
      Effect.scoped,
      Effect.timeout("60 seconds")
    )
  )
  return { root, runId: runIds[0]!, runIds }
}

const storeBytes = (root: string) =>
  readdirSync(join(root, ".flows")).filter((name) => name.endsWith(".db")).sort().map((name) =>
    readFileSync(join(root, ".flows", name))
  )

it("replays every recorded step of an unchanged flow and changes nothing", async () => {
  const { root, runId } = await parkedProject()
  expect(ran).toEqual(["verify/first", "verify/second"])
  const before = storeBytes(root)
  const report = await Verify.verify(root, runId, { modules: modulesFor(Second) })
  expect(report.verdict).toBe("consistent")
  expect(report.replayed.map((step) => step.action)).toEqual(["verify/first", "verify/second"])
  // The human task the run parked inside is re-entered, not executed afresh.
  expect(report.resumes?.action).toBe("system/human-task")
  expect(report.notReplayed).toEqual([])
  expect(report.executes).toBeUndefined()
  expect(ran).toEqual(["verify/first", "verify/second"])
  expect(storeBytes(root)).toEqual(before)
}, 120_000)

it("reports a re-keyed step as dropped and the step that would execute", async () => {
  const { root, runId } = await parkedProject()
  const report = await Verify.verify(root, runId, { modules: modulesFor(Renamed) })
  expect(report.verdict).toBe("divergent")
  expect(report.replayed.map((step) => step.action)).toEqual(["verify/first"])
  expect(report.executes?.action).toBe("verify/second-renamed")
  expect(report.notReplayed).toHaveLength(1)
  expect(report.notReplayed[0]?.stepKeyDigest).not.toBe(report.executes?.stepKeyDigest)
  // Nothing ran: the renamed step stopped at the gate.
  expect(ran).toEqual(["verify/first", "verify/second"])
}, 120_000)

it("refuses a copy that does not stop in time", async () => {
  const { root, runId } = await parkedProject()
  await expect(Verify.verify(root, runId, { modules: modulesFor(Second), settleWithin: "1 millis" })).rejects
    .toMatchObject({ code: "verify_timeout" })
}, 120_000)

it("refuses a project with no history", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-verify-empty-"))
  roots.push(root)
  await expect(Verify.verify(root, "missing")).rejects.toMatchObject({ code: "history_missing" })
})

it("refuses through the CLI with the refusal's own code", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-verify-cli-"))
  roots.push(root)
  let output = ""
  let exitCode = 0
  await appendHistoryCommands(Cli.create("runs"), { environment: {} }).serve(
    ["verify", "missing", "--root", root, "--json"],
    { stdout: (text) => void (output += text), exit: (code) => void (exitCode = code) }
  )
  expect(exitCode).not.toBe(0)
  expect(output).toContain("history_missing")
})

it("names the step that would execute and the steps that would not replay", () => {
  const refusal = Verify.divergence({
    runId: "run-1",
    verdict: "divergent",
    replayed: [],
    executes: { stepKeyDigest: "d2", action: "verify/second-renamed" },
    notReplayed: [{ stepKeyDigest: "d1", node: "node-1" }, { stepKeyDigest: "d0" }]
  })
  expect(refusal.code).toBe("run_divergent")
  expect(refusal.message).toBe(
    "Resuming run-1 would execute verify/second-renamed again; 2 recorded step(s) would not replay: node-1, d0"
  )
  expect(Verify.divergence({ runId: "r", verdict: "divergent", replayed: [], notReplayed: [] }).message)
    .toBe("Resuming r would execute new work again; 0 recorded step(s) would not replay: ")
})

it("verifies every run a store holds and lists the settled ones apart", async () => {
  const { root, runIds } = await parkedProject(2, 1)
  const before = storeBytes(root)
  const summary = await Verify.verifyAll(root, { modules: modulesFor(Second) })
  expect(summary.verdict).toBe("consistent")
  expect(summary.reports.map((report) => [report.runId, report.verdict])).toEqual([
    [runIds[0], "consistent"],
    [runIds[1], "consistent"]
  ])
  // Each report holds its own run tree's dispatches, never a sibling's.
  for (const report of summary.reports) {
    expect(report.replayed.map((step) => step.action)).toEqual(["verify/first", "verify/second"])
  }
  expect(summary.settled).toEqual([{ runId: runIds[2], status: "cancelled" }])
  expect(summary.unverified).toEqual([])
  expect(storeBytes(root)).toEqual(before)

  const divergent = await Verify.verifyAll(root, { modules: modulesFor(Renamed) })
  expect(divergent.verdict).toBe("divergent")
  expect(divergent.reports.map((report) => report.executes?.action)).toEqual([
    "verify/second-renamed",
    "verify/second-renamed"
  ])
  expect(Verify.storeDivergence(divergent).message).toBe(
    divergent.reports.map((report) => Verify.divergence(report).message).join("\n")
  )
  expect(ran).toEqual(Array(3).fill(["verify/first", "verify/second"]).flat())
}, 240_000)

it("lists a run whose copy does not stop in time instead of ending the whole verification", async () => {
  const { root, runId } = await parkedProject()
  const summary = await Verify.verifyAll(root, { modules: modulesFor(Second), settleWithin: "1 millis" })
  expect(summary.reports).toEqual([])
  expect(summary.unverified).toEqual([
    { runId, code: "verify_timeout", message: `The copy of ${runId} did not stop replaying in time` }
  ])
  expect(summary.verdict).toBe("consistent")
}, 240_000)

it("verifies a store elsewhere against the project's flows", async () => {
  const { root, runId } = await parkedProject()
  const elsewhere = mkdtempSync(join(tmpdir(), "smithers-verify-against-"))
  roots.push(elsewhere)
  cpSync(join(root, ".flows"), elsewhere, { recursive: true })
  rmSync(join(root, ".flows"), { recursive: true, force: true })
  const summary = await Verify.verifyAll(root, { modules: modulesFor(Second), against: join(elsewhere, "engine.db") })
  expect(summary.reports.map((report) => [report.runId, report.verdict])).toEqual([[runId, "consistent"]])
  const one = await Verify.verify(root, runId, { modules: modulesFor(Second), against: join(elsewhere, "engine.db") })
  expect(one.replayed.map((step) => step.action)).toEqual(["verify/first", "verify/second"])
  // No store under the project itself was created or read.
  expect(existsSync(join(root, ".flows", "engine.db"))).toBe(false)
  await expect(Verify.verifyAll(root, { against: join(root, "missing", "engine.db") })).rejects.toMatchObject({
    code: "history_missing"
  })
}, 240_000)

it("verifies a PostgreSQL-backed project on a schema copy it drops afterwards", async () => {
  // The prefix names every store's schema by its file's basename, so a
  // scratch `engine.db` would alias the original: the copy is named apart.
  const prefix = `test_verify_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  vi.stubEnv("SMITHERS_POSTGRES_URL", process.env.SMITHERS_HISTORY_TEST_PG_URL!)
  vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", prefix)
  vi.stubEnv("SMITHERS_BACKEND", "postgres")
  const admin = <A, E>(body: Effect.Effect<A, E, SqlClient>) =>
    Effect.runPromise(
      body.pipe(
        Effect.provide(NodeDatabase.layer({ filename: `${process.env.SMITHERS_HISTORY_TEST_PG_URL!}?schema=public` }))
      )
    )
  const schemas = () =>
    admin(
      Effect.flatMap(SqlClient, (sql) =>
        sql<
          { name: string }
        >`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE ${`${prefix}%`} ORDER BY nspname`)
    ).then((rows) => rows.map((row) => row.name))
  const rows = () =>
    admin(Effect.flatMap(SqlClient, (sql) =>
      sql<{ count: number }>`SELECT
        (SELECT count(*) FROM ${sql(`${prefix}_engine_db`)}.flows_journal_events)
        + (SELECT count(*) FROM ${sql(`${prefix}_engine_db`)}.flows_attempts)
        + (SELECT count(*) FROM ${sql(`${prefix}_control_db`)}.flows_journal_events) AS count`)).then(([row]) =>
        Number(row!.count)
      )
  try {
    const { root, runId } = await parkedProject()
    expect(existsSync(join(root, ".flows", "engine.db"))).toBe(false)
    expect(await schemas()).toEqual([`${prefix}_control_db`, `${prefix}_engine_db`])
    const before = await rows()
    const consistent = await Verify.verify(root, runId, { modules: modulesFor(Second) })
    expect(consistent.verdict).toBe("consistent")
    expect(consistent.replayed.map((step) => step.action)).toEqual(["verify/first", "verify/second"])
    expect(consistent.resumes?.action).toBe("system/human-task")
    const divergent = await Verify.verify(root, runId, { modules: modulesFor(Renamed) })
    expect(divergent.verdict).toBe("divergent")
    expect(divergent.executes?.action).toBe("verify/second-renamed")
    // A prefix that leaves no room for a scratch name is refused before any copy.
    vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", `${prefix}_${"x".repeat(63 - prefix.length - 12)}`)
    await expect(Verify.verify(root, runId, { modules: modulesFor(Second) })).rejects.toMatchObject({
      code: "verify_schema_too_long"
    })
    vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", prefix)
    // The originals are untouched and every scratch schema is gone.
    expect(await rows()).toBe(before)
    expect(await schemas()).toEqual([`${prefix}_control_db`, `${prefix}_engine_db`])
    expect(ran).toEqual(["verify/first", "verify/second"])
  } finally {
    await admin(Effect.gen(function*() {
      const sql = yield* SqlClient
      for (
        const name of yield* sql<
          { name: string }
        >`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE ${`${prefix}%`}`
      ) yield* sql`DROP SCHEMA ${sql(name.name)} CASCADE`
    })).catch(() => undefined)
    vi.unstubAllEnvs()
  }
}, 240_000)

it("collects recorded steps across spawned runs and names them from node records", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-verify-recorded-"))
  roots.push(root)
  const file = join(root, "engine.db")
  const database = new DatabaseSync(file)
  database.exec(`
    CREATE TABLE flows_migrations(id TEXT);
    CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY, parent_run_id TEXT);
    CREATE TABLE flows_attempts(run_id TEXT, step_key_digest TEXT, attempt INTEGER, state TEXT);
    CREATE TABLE flows_journal_events(run_id TEXT, seq INTEGER, event_type TEXT, payload_json TEXT);
    INSERT INTO flows_runs VALUES ('root', NULL), ('child', 'root'), ('grandchild', 'child'), ('other', NULL);
    INSERT INTO flows_attempts VALUES
      ('root', 'd-root', 1, 'succeeded'), ('root', 'd-failed', 1, 'failed'),
      ('child', 'd-child', 1, 'succeeded'), ('child', 'd-child', 2, 'succeeded'),
      ('grandchild', 'd-grand', 1, 'succeeded'), ('other', 'd-other', 1, 'succeeded');
    INSERT INTO flows_journal_events VALUES
      ('child', 1, 'flows.engine.node-settled', '{"nodeId":"n1","action":"a1","stepKeyDigests":["d-child",7]}'),
      ('child', 2, 'flows.engine.node-settled', '{"nodeId":3,"stepKeyDigests":"d-child"}'),
      ('grandchild', 1, 'flows.engine.node-settled', '{"action":7,"nodeId":"n2","stepKeyDigests":["d-grand"]}'),
      ('root', 1, 'flows.engine.node-settled', '{"action":"a0","nodeId":4,"stepKeyDigests":["d-root"]}');
  `)
  database.close()
  // Without `flows_run_parents` the walk follows `parent_run_id` alone.
  expect(await Effect.runPromise(Verify.recordedSteps(file, "root"))).toEqual([
    { stepKeyDigest: "d-root", action: "a0" },
    { stepKeyDigest: "d-child", action: "a1", node: "n1" },
    { stepKeyDigest: "d-grand", node: "n2" }
  ])
  const spawned = new DatabaseSync(file)
  spawned.exec(`CREATE TABLE flows_run_parents(child_id TEXT, parent_id TEXT);
    INSERT INTO flows_run_parents VALUES ('other', 'root'), ('child', 'root');`)
  spawned.close()
  expect((await Effect.runPromise(Verify.recordedSteps(file, "root"))).map((step) => step.stepKeyDigest)).toEqual([
    "d-root",
    "d-child",
    "d-other",
    "d-grand"
  ])
})
