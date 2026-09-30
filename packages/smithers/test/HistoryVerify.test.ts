/**
 * `runs verify` resumes a copy of a parked run under a replay-only engine and
 * reports which recorded steps the current code replays and which it would
 * execute again, without touching the project's own stores.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlRuntime } from "@smthrs/control"
import type { RunId } from "@smthrs/control/ControlSchema"
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
import { Cli } from "incur"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import * as CoreFlow from "../flows/core/src/Flow.ts"
import { appendHistoryCommands } from "../src/cli/HistoryCommands.ts"
import * as Verify from "../src/history/Verify.ts"
import * as NodeControl from "../src/NodeControl.ts"

const moduleSource = `import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default Flow.make({name:"steps",description:"Steps",input:Schema.Unknown,output:Schema.Json,capabilities:[],flows:["test/Steps"]})
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
        default: CoreFlow.make({
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

/** A project whose `steps` run recorded both steps and parked on its task. */
const parkedProject = async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-verify-"))
  roots.push(root)
  mkdirSync(join(root, "flows", "steps"), { recursive: true })
  writeFileSync(join(root, "flows", "steps", "flow.ts"), moduleSource)
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const runId = await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* control.plan({ flowId: "steps", input: {} })
      yield* control.approve(card.approval)
      const launched = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "start"
      })
      if (launched._tag !== "Accepted" || launched.runId === undefined) return yield* Effect.die("not accepted")
      const runtime = yield* ControlRuntime.ControlRuntime
      for (let attempt = 0; attempt < 1_000; attempt++) {
        const run = yield* runtime.getRun(launched.runId)
        if (run.status === "parked") return launched.runId
        yield* Effect.sleep("10 millis")
      }
      return yield* Effect.die("the run never parked")
    }).pipe(
      Effect.provide(Layer.merge(
        NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, engine, modulesFor(Second)),
        Layer.merge(engine.runtime, registry)
      )),
      Effect.scoped,
      Effect.timeout("60 seconds")
    )
  )
  return { root, runId: runId as RunId }
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

it("refuses a PostgreSQL-backed project before copying anything", async () => {
  vi.stubEnv("SMITHERS_POSTGRES_URL", "postgres://localhost/unused")
  vi.stubEnv("SMITHERS_BACKEND", undefined)
  try {
    await expect(Verify.verify(tmpdir(), "run-1")).rejects.toMatchObject({ code: "verify_unsupported_backend" })
  } finally {
    vi.unstubAllEnvs()
  }
})

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
