/**
 * The fold behind `runs show` and `runs logs`: engine records a run's journal
 * carries in `control.engine.event` envelopes, read as an operator's view.
 */
import type { ControlSchema } from "@smthrs/control"
import { Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as RunActivity from "../src/cli/RunActivity.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"

const runId = "run-7"
const entry = `registry/entry/${"a".repeat(64)}/sweep`
let sequence = 0

const engine = (
  executionId: string,
  eventType: string,
  payload: Record<string, unknown>,
  at = ++sequence,
  generation = 0
): ControlSchema.ControlEvent => ({
  sequence: ++sequence,
  kind: "control.engine.event",
  runId,
  occurredAt: at,
  payload: { version: 1, executionId, generation, sequence: sequence, eventType, payload } as never
})

const fact = (
  executionId: string,
  flowName: string,
  status: string,
  options: { parent?: string; started?: number; finished?: number; round?: number; generation?: number } = {}
) =>
  engine(
    executionId,
    "flows.engine.run-decision",
    {
      decision: "transitioned",
      executionFact: {
        version: 1,
        baseline: "legacy",
        observation: {
          executionId,
          flowName,
          status,
          parentRunId: options.parent ?? null,
          roundOrdinal: options.round ?? 0,
          startedAtMs: options.started ?? 1,
          finishedAtMs: options.finished ?? null
        }
      }
    },
    ++sequence,
    options.generation
  )

const node = (executionId: string, phase: "scheduled" | "settled", nodeId: string, extra: Record<string, unknown>) =>
  engine(executionId, `flows.engine.node-${phase}`, { nodeId, ...extra })

const control = (kind: string, at: number): ControlSchema.ControlEvent => ({
  sequence: ++sequence,
  kind,
  runId,
  occurredAt: at,
  payload: {}
})

const tree = (): ReadonlyArray<ControlSchema.ControlEvent> => [
  control("control.run.running", 1),
  fact(runId, "agent/run", "running"),
  fact("entry", entry, "running", { parent: runId }),
  node("entry", "scheduled", "root", { kind: "FlowCall", action: entry }),
  fact("rounds", "sweep/rounds", "running", { parent: "entry", round: 2 }),
  node("rounds", "scheduled", "list", { kind: "ActionCall", action: "sweep/list" }),
  node("rounds", "settled", "list", { action: "sweep/list", outcome: "built" }),
  node("rounds", "scheduled", "dispatch", { kind: "ActionCall", action: "sweep/dispatch" }),
  fact("work-1", "sweep/work", "running", { parent: "rounds", started: 5 }),
  node("work-1", "scheduled", "fix", { kind: "ActionCall", action: "sweep/fix" }),
  fact("work-2", "sweep/work", "completed", { parent: "rounds", started: 6, finished: 9 })
]

describe("RunActivity.fold", () => {
  it("names the run by its flow, folds the wrappers into its row, and lists what each execution runs", () => {
    const activity = RunActivity.fold(tree(), { runId, flowId: "sweep" })
    expect(activity.omitted).toBe(0)
    expect(activity.executions).toEqual([
      expect.objectContaining({ executionId: runId, flowName: "sweep", parent: null, running: null }),
      expect.objectContaining({
        executionId: "rounds",
        flowName: "sweep/rounds",
        parent: runId,
        round: 2,
        running: "sweep/dispatch"
      }),
      expect.objectContaining({ executionId: "work-1", parent: "rounds", status: "running", running: "sweep/fix" }),
      expect.objectContaining({ executionId: "work-2", status: "completed", finishedAtMs: 9, running: null })
    ])
  })

  it("does not count monitor checks or watch keepalives as progress", () => {
    const events = [
      control("control.run.running", 10),
      control("control.status.observed", 500),
      control("control.gateway.heartbeat", 900)
    ]
    expect(RunActivity.fold(events, { runId, flowId: "sweep" }).lastProgressAt).toBe(10)
    expect(RunActivity.fold([], { runId, flowId: "sweep" })).toEqual({
      lastProgressAt: undefined,
      executions: [],
      omitted: 0
    })
  })

  it("keeps every live execution and the newest settled ones within the row bound", () => {
    const settled = Array.from(
      { length: RunActivity.maximumExecutions + 5 },
      (_, index) => fact(`done-${index}`, "sweep/work", "failed", { parent: runId, finished: 100 + index })
    )
    const live = Array.from({ length: 3 }, (_, index) => fact(`live-${index}`, "sweep/work", "running"))
    const activity = RunActivity.fold([fact(runId, "agent/run", "running"), ...settled, ...live], {
      runId,
      flowId: "sweep"
    })
    expect(activity.executions).toHaveLength(RunActivity.maximumExecutions)
    expect(activity.omitted).toBe(9)
    expect(activity.executions.slice(0, 4).map((row) => row.executionId)).toEqual([runId, "live-0", "live-1", "live-2"])
    expect(activity.executions[4]?.executionId).toBe(`done-${RunActivity.maximumExecutions + 4}`)
  })

  it("prints every live execution even past the bound, and a run with no row of its own", () => {
    const live = Array.from(
      { length: RunActivity.maximumExecutions + 2 },
      (_, index) => fact(`live-${index}`, "sweep/work", "suspended")
    )
    const activity = RunActivity.fold(live, { runId, flowId: "sweep" })
    expect(activity.executions).toHaveLength(RunActivity.maximumExecutions + 2)
    expect(activity.omitted).toBe(0)
  })

  it("keeps an execution's newest generation and sequence, and ignores malformed records", () => {
    const events = [
      fact("work", "sweep/work", "running", { generation: 1 }),
      fact("work", "sweep/work", "completed", { generation: 0, finished: 3 }),
      engine("work", "flows.engine.run-decision", { executionFact: { observation: { executionId: "other" } } }),
      engine("work", "flows.engine.node-scheduled", { kind: "ActionCall" }),
      { ...control("control.engine.event", 4), payload: { eventType: "flows.engine.node-scheduled" } }
    ]
    const [row] = RunActivity.fold(events, { runId, flowId: "sweep" }).executions
    expect(row).toMatchObject({ executionId: "work", status: "running", finishedAtMs: null })
  })

  it("reads a record without ordering fields as the oldest, and a settled run's row as idle", () => {
    const bare = (status: string, finished: number | null): ControlSchema.ControlEvent => ({
      sequence: ++sequence,
      kind: "control.engine.event",
      runId,
      occurredAt: sequence,
      payload: {
        executionId: "work",
        eventType: "flows.engine.run-decision",
        payload: { executionFact: { observation: { executionId: "work", flowName: "sweep/work", status } } }
      } as never
    })
    const stale = { ...fact("work", "sweep/work", "running"), payload: undefined } as never
    const events = [
      fact(runId, "agent/run", "cancelled", { finished: 8 }),
      node(runId, "scheduled", "a", { kind: "ActionCall" }),
      bare("completed", null),
      fact("work", "sweep/work", "failed", { parent: runId }),
      bare("running", null),
      stale,
      fact("other", "sweep/work", "completed", { parent: runId, finished: 7 })
    ]
    const [own, ...rest] = RunActivity.fold(events, { runId, flowId: "sweep" }).executions
    expect(own).toMatchObject({ status: "cancelled", running: null, finishedAtMs: 8 })
    expect(rest.map((row) => [row.executionId, row.status, row.round])).toEqual([
      ["other", "completed", 0],
      ["work", "failed", 0]
    ])
  })

  it("names at most three running actions and counts the rest", () => {
    const events = [
      fact(runId, "agent/run", "running"),
      ...["a", "b", "c", "d", "e"].map((name) => node(runId, "scheduled", name, { kind: "ActionCall" }))
    ]
    expect(RunActivity.fold(events, { runId, flowId: "sweep" }).executions[0]?.running).toBe("c · d · e · 2 more")
  })

  it("presents an execution view under the run's flow and leaves other names alone", () => {
    const view = { root: { flowName: "agent/run" }, current: { flowName: entry } }
    expect(RunActivity.presentView(view, "sweep")).toEqual({
      root: { flowName: "sweep" },
      current: { flowName: "sweep" }
    })
    expect(RunActivity.presentView(undefined, "sweep")).toBeUndefined()
    expect(RunActivity.flowNameOf("sweep/work", "sweep")).toBe("sweep/work")
  })

  it("states what each drift means for a resume", () => {
    expect(RunActivity.driftVerdict({ recorded: "a", current: "b" })).toBe(
      "flow changed since the run started; resume needs --allow-code-drift"
    )
    expect(RunActivity.driftVerdict({ recorded: "a" })).toBe("flow is no longer on disk; the run cannot resume")
    expect(RunActivity.driftVerdict({ recordedEngine: "1", currentEngine: "2" })).toBe(
      "engine changed since the run started; resume needs --allow-code-drift"
    )
  })
})

describe("RunActivity.show", () => {
  const run = (status: ControlSchema.RunSummary["status"]): ControlSchema.RunSummary => ({
    runId,
    flowId: "sweep",
    status,
    createdAt: 0,
    updatedAt: 2,
    codeDrift: { recorded: "a", current: "b" }
  })

  it("advances updatedAt to the last progress and leaves endedAt empty while the run is live", () => {
    const shown = RunActivity.show(run("running"), tree())
    expect(shown.updatedAt).toBeGreaterThan(2)
    expect(shown.diagnosis.endedAt).toBeUndefined()
    expect(shown.codeDrift?.verdict).toContain("--allow-code-drift")
    expect(shown).not.toHaveProperty("executionsOmitted")
    expect(shown).not.toHaveProperty("executionView")
  })

  it("presents the execution view and counts the rows it omits", () => {
    const view = {
      root: { executionId: runId, flowName: "agent/run" },
      current: { executionId: runId, flowName: "agent/run" }
    } as unknown as NonNullable<ControlSchema.RunSummary["executionView"]>
    const events = Array.from(
      { length: RunActivity.maximumExecutions + 1 },
      (_, index) => fact(`done-${index}`, "sweep/work", "completed")
    )
    const shown = RunActivity.show({ ...run("running"), executionView: view }, events)
    expect(shown.executionView?.root.flowName).toBe("sweep")
    expect(shown.executionsOmitted).toBe(1)
  })

  it("keeps the recorded end of a settled run and a row newer than its journal", () => {
    const { codeDrift: _drift, ...settled } = run("completed")
    const shown = RunActivity.show({ ...settled, updatedAt: 1e15 }, [
      control("control.run.running", 1),
      control("control.run.completed", 4)
    ])
    expect(shown.updatedAt).toBe(1e15)
    expect(shown.diagnosis.endedAt).toBe(4)
    expect(shown).not.toHaveProperty("codeDrift")
    expect(RunActivity.show(run("running"), []).updatedAt).toBe(2)
  })
})

describe("RunProgress over engine records", () => {
  const project = (events: ReadonlyArray<ControlSchema.ControlEvent>) => {
    let state = RunProgress.initial()
    const lines: Array<string> = []
    for (const next of events) {
      const projected = RunProgress.project(state, next)
      state = projected.state
      lines.push(...projected.lines.map((line) => `${line.level} ${line.text}`))
    }
    return { state, lines }
  }

  it("prints the actions and spawned executions of a run and none of its wrappers", () => {
    const { lines, state } = project([
      ...tree(),
      node("work-1", "settled", "fix", { action: "sweep/fix", outcome: "failed", message: "tests red" }),
      fact("work-1", "sweep/work", "failed", { parent: "rounds" }),
      fact("work-1", "sweep/work", "failed", { parent: "rounds" }),
      fact("rounds", "sweep/rounds", "cancelled", { parent: "entry" })
    ])
    expect(lines).toEqual([
      "info Started sweep/rounds · rounds",
      "step Running sweep/list",
      "success sweep/list completed",
      "step Running sweep/dispatch",
      "info Started sweep/work · work-1",
      "step Running sweep/fix",
      "success sweep/work · work-2 completed",
      "error sweep/fix failed · tests red",
      "error sweep/work · work-1 failed",
      "warn sweep/rounds · rounds cancelled"
    ])
    expect(state).toMatchObject({ started: 3, completed: 1, failed: 1, active: ["sweep/dispatch"] })
  })

  it("ignores engine records it cannot attribute and reports each spawned execution's start once", () => {
    const anonymous = { ...node("x", "scheduled", "a", { kind: "ActionCall" }), payload: { eventType: "x" } }
    const unnamed = engine("x", "flows.engine.run-decision", { executionFact: { observation: { executionId: "x" } } })
    const actions = Array.from(
      { length: 10 },
      (_, index) => node("x", "scheduled", `n${index}`, { kind: "ActionCall", action: `sweep/${index}` })
    )
    const { lines, state } = project([
      anonymous as ControlSchema.ControlEvent,
      unnamed,
      fact("child", "sweep/work", "running"),
      fact("child", "sweep/work", "running"),
      ...actions,
      node("x", "settled", "n0", { outcome: "built" })
    ])
    expect(lines.filter((line) => line.startsWith("info"))).toEqual(["info Started sweep/work · child"])
    expect(state.completed).toBe(1)
    expect(state.active).toHaveLength(8)
    expect(RunProgress.running(state)).toBe(9)
  })

  it("reports a retried action once and its skipped or cached settlement", () => {
    const { lines, state } = project([
      node("x", "scheduled", "a", { kind: "ActionCall", action: "sweep/a" }),
      node("x", "scheduled", "a", { kind: "ActionCall", action: "sweep/a" }),
      node("x", "settled", "a", { outcome: "skipped" }),
      node("x", "scheduled", "b", { kind: "ActionCall" }),
      node("x", "settled", "b", { outcome: "clean" }),
      node("x", "settled", "never-scheduled", { outcome: "built" })
    ])
    expect(lines).toEqual([
      "step Running sweep/a",
      "step Retrying sweep/a",
      "warn a skipped",
      "step Running b",
      "success b cached"
    ])
    expect(state).toMatchObject({ started: 2, completed: 1, skipped: 1, skippedStarted: 1, active: [] })
  })

  it("ends a read of recorded events by naming the state and how to follow it", () => {
    const chunks: Array<string> = []
    const output = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk))
        done()
      }
    })
    const renderer = RunProgress.make(runId, {
      policy: {
        audience: "human",
        source: "override",
        harnesses: [],
        structured: false,
        progress: "plain",
        interactive: false
      },
      output
    })
    for (const next of tree()) renderer.event(next)
    renderer.close("caught-up")
    const text = chunks.join("")
    expect(text).toContain("End of recorded events · sweep/fix")
    expect(text).toContain(`smthrs runs logs '${runId}' --follow\nsmthrs runs show '${runId}'`)
    expect(text).not.toContain("Stopped watching before settlement")
  })
})
