/**
 * `smthrs runs fork` of a module run: the fork is a run of its own, so its
 * payload names it and its module execution is its own child, which carries
 * the steps the parent's child recorded. An edited step inside that child and
 * an edited root input both land on the fork alone.
 */
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlRuntime } from "@smthrs/control"
import type { RunId } from "@smthrs/control/ControlSchema"
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"

import * as History from "../src/history/History.ts"
import * as Workspace from "../src/history/Workspace.ts"
import * as NodeControl from "../src/NodeControl.ts"

const moduleSource = `import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default ({ effects: undefined, name:"steps",description:"Steps",input:Schema.Unknown,output:Schema.Json,capabilities:[],flows:["test/Steps"] })
`
const step = (name: string) =>
  Action.make(name, { payload: {}, success: Schema.String, tier: "irreversible", idempotencyKey: name })
const First = step("fork-child/first")
const Second = step("fork-child/second")

/** The `test/Steps` delegate: two steps, then a park on a human task. */
const modules = () => {
  const Steps = Flow.make("test/Steps", {
    payload: Executable.Invocation,
    success: Schema.Json,
    error: HumanTask.HumanTaskFailed,
    body: () =>
      First.call({}).pipe(
        Node.bindPlanned(() => Second.call({})),
        Node.bindPlanned(() => HumanTask.action.call({ name: "probe", kind: "ask", prompt: "Go?", maxAttempts: 3 }))
      )
  })
  const implement = (action: typeof First) => action.toLayer(() => Effect.succeed(action.name))
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
      Layer.mergeAll(Interpreter.layer(Steps), HumanTask.layer, implement(First), implement(Second))
        .pipe(Layer.provideMerge(Action.layerImplementations))
    ),
    Layer.orDie
  )
}

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A jj project whose `steps` run recorded both steps and parked on its task. */
const parkedProject = async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-fork-child-")))
  roots.push(root)
  execFileSync("jj", ["git", "init", root], { stdio: "ignore" })
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
        if ((yield* runtime.getRun(launched.runId)).status === "parked") return launched.runId
        yield* Effect.sleep("10 millis")
      }
      return yield* Effect.die("the run never parked")
    }).pipe(
      Effect.provide(Layer.merge(
        NodeControl.layerControl({ root, evaluator: ScriptedJudge.layer }, registry, engine, modules()),
        Layer.merge(engine.runtime, registry)
      )),
      Effect.scoped,
      Effect.timeout("60 seconds")
    )
  )
  return { root, runId: runId as RunId }
}

const read = <A>(root: string, name: "engine" | "control", body: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(join(root, ".flows", `${name}.db`), { readOnly: true })
  try {
    return body(db)
  } finally {
    db.close()
  }
}

const stateOf = (root: string, runId: string) =>
  read(
    root,
    "engine",
    (db) => JSON.parse(String(db.prepare("SELECT state_json FROM flows_runs WHERE run_id=?").get(runId)!.state_json))
  )

const attemptsOf = (root: string, runId: string) =>
  read(
    root,
    "engine",
    (db) =>
      db.prepare("SELECT step_key_digest,state,outcome_json FROM flows_attempts WHERE run_id=? ORDER BY finished_at_ms")
        .all(runId).map((row) => ({
          digest: String(row.step_key_digest),
          state: String(row.state),
          outcome: row.outcome_json === null ? null : JSON.parse(String(row.outcome_json))
        }))
  )

/** The module child the run executes in, found by the digest its plan was approved with. */
const moduleChildOf = (root: string, runId: string) => {
  const executionDigest = read(
    root,
    "control",
    (db) =>
      JSON.parse(String(db.prepare("SELECT card_json FROM control_plans").get()!.card_json)).executionDigest as string
  )
  return { executionDigest, runId: AgentSession.moduleExecutionId(runId, executionDigest) }
}

const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0

it.skipIf(!hasJj)("forks a module run into its own module child, carrying and editing its steps", async () => {
  const { root, runId } = await parkedProject()
  const parentChild = moduleChildOf(root, runId)
  const recorded = attemptsOf(root, parentChild.runId)
  expect(recorded.filter((attempt) => attempt.state === "succeeded").map((attempt) => attempt.outcome)).toEqual([
    "fork-child/first",
    "fork-child/second"
  ])
  const second = recorded.find((attempt) => attempt.outcome === "fork-child/second")!.digest
  const fork = await History.mutate(root, runId, { override: { stepKeyDigest: second, result: "edited" } }, "fork")

  // The fork's execution names itself, so its module child is its own.
  expect(stateOf(root, fork.runId).payload).toEqual({ runId: fork.runId, planId: expect.any(String) })
  const carried = AgentSession.moduleExecutionId(fork.runId, parentChild.executionDigest)
  expect(stateOf(root, carried)).toMatchObject({
    parentExecutionId: fork.runId,
    forkKeyRunIds: [parentChild.runId]
  })
  expect(stateOf(root, carried).result).toBeUndefined()
  // It routes to the fork's worktree, where the fork's host runs it.
  expect(
    read(
      root,
      "engine",
      (db) => db.prepare("SELECT parent_run_id FROM flows_runs WHERE run_id=?").get(carried)!.parent_run_id
    )
  ).toBe(fork.runId)
  if (!("workspace" in fork)) throw new Error("Fork must return its execution workspace")
  expect(await Workspace.canExecute(root, fork.workspace, carried)).toBe(true)
  expect(await Workspace.canExecute(root, root, carried)).toBe(false)
  // Both finished steps crossed, the second one edited; the unfinished task did not.
  expect(attemptsOf(root, carried).map((attempt) => attempt.outcome)).toEqual(["fork-child/first", "edited"])
  expect(attemptsOf(root, parentChild.runId).map((attempt) => attempt.outcome)).toEqual(recorded.map((a) => a.outcome))
}, 120_000)

it.skipIf(!hasJj)("binds a fork with an edited input to its own approved plan", async () => {
  const { root, runId } = await parkedProject()
  const parentPlan = stateOf(root, runId).payload.planId as string
  const parentChild = moduleChildOf(root, runId)
  const fork = await History.mutate(root, runId, { input: { topic: "edited" }, modules: modules() }, "fork")

  const payload = stateOf(root, fork.runId).payload as { runId: string; planId: string }
  expect(payload.runId).toBe(fork.runId)
  expect(payload.planId).not.toBe(parentPlan)
  const plan = read(
    root,
    "control",
    (db) =>
      db.prepare("SELECT decision,decoded_input_json,card_json FROM control_plans WHERE plan_id=?").get(payload.planId)!
  )
  expect(plan.decision).toBe("approved")
  expect(JSON.parse(String(plan.decoded_input_json))).toEqual({ topic: "edited" })
  // The fork's control identity is bound to the plan its input was approved as.
  const summary = read(
    root,
    "control",
    (db) =>
      JSON.parse(String(db.prepare("SELECT state_json FROM flows_runs WHERE run_id=?").get(fork.runId)!.state_json))
  )
  expect(summary).toMatchObject({
    runId: fork.runId,
    planId: payload.planId,
    planDigest: JSON.parse(String(plan.card_json)).digest,
    executionDigest: JSON.parse(String(plan.card_json)).executionDigest
  })
  // The module child still carries the recorded steps, under the edited invocation.
  const carried = AgentSession.moduleExecutionId(fork.runId, parentChild.executionDigest)
  expect(stateOf(root, carried).payload).toEqual({ input: { topic: "edited" } })
  expect(attemptsOf(root, carried).map((attempt) => attempt.outcome)).toEqual(["fork-child/first", "fork-child/second"])
}, 120_000)
