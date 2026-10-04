/**
 * Behavioral projection contract checks for Run (monitor and Inspect).
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { MonitorCardSchema } from "../../src/MonitorCard.ts"
import { cardContract } from "../cardContract.ts"
import { ben, person } from "../fixtures/_shared.ts"
import { fixtures } from "../fixtures/Monitor.ts"

cardContract("Run", MonitorCardSchema, fixtures)

// Literal oracles from ui-components.md v0.4 T-UI-12 and spec §14.3 Run; never read from the schema.
const RUN_STATES = ["running", "waiting", "held", "failed", "done", "interrupted"] as const
const GRAPH_STATES = ["done", "current", "waiting", "failed", "next", "held"] as const
const CELL_KINDS = ["context", "read", "edit", "run", "think", "ask", "answer", "steer", "reviewer", "rebase"] as const
const WAIT_KINDS = ["question", "approval", "pause", "sleep", "signal", "external_job"] as const
const model = (name: keyof typeof fixtures) => MonitorCardSchema.parse(fixtures[name].model)
const running = () => structuredClone(fixtures.running.model)

describe("Run vocabularies", () => {
  test.each(RUN_STATES)("accepts run and attempt state %s", (state) => {
    const changed = running()
    changed.attempts[0]!.state = state
    expect(MonitorCardSchema.safeParse({ ...changed, state }).success).toBe(true)
  })
  test.each(["", "queued", "cancelled", "paused", "Running"])("rejects run state %j", (state) => {
    expect(MonitorCardSchema.safeParse({ ...running(), state }).success).toBe(false)
    const changed = running()
    Object.assign(changed.attempts[0]!, { state })
    expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
  })
  test.each(GRAPH_STATES)("accepts graph state %s", (state) => {
    const changed = running()
    changed.attempts[0]!.graph[0]!.state = state
    expect(MonitorCardSchema.safeParse(changed).success).toBe(true)
  })
  test.each(["", "todo", "active", "skipped"])("rejects graph state %j", (state) => {
    const changed = running()
    Object.assign(changed.attempts[0]!.graph[0]!, { state })
    expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
  })
  test.each(CELL_KINDS)("accepts cell kind %s", (kind) => {
    const changed = running()
    changed.attempts[0]!.phases[0]!.cells[0]!.kind = kind
    expect(MonitorCardSchema.safeParse(changed).success).toBe(true)
  })
  test.each(["write", "tool", ""])("rejects cell kind %j", (kind) => {
    const changed = running()
    Object.assign(changed.attempts[0]!.phases[0]!.cells[0]!, { kind })
    expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
  })
  test.each(WAIT_KINDS)("accepts wait kind %s", (kind) => {
    const wait = { id: "w", kind, label: "Waiting", since: "2026-10-02T17:42:00.000Z" }
    expect(MonitorCardSchema.safeParse({ ...running(), waits: [wait] }).success).toBe(true)
  })
  test.each(["conflict", "timer", "job", ""])("rejects wait kind %j", (kind) => {
    const wait = { id: "w", kind, label: "Waiting", since: "2026-10-02T17:42:00.000Z" }
    expect(MonitorCardSchema.safeParse({ ...running(), waits: [wait] }).success).toBe(false)
  })
  test("stories cover every run state and every wait kind", () => {
    const models = Object.values(fixtures).map((story) => story.model)
    expect([...new Set(models.map((run) => run.state))].sort()).toEqual([...RUN_STATES].sort())
    expect([...new Set(models.flatMap((run) => run.waits.map((wait) => wait.kind)))].sort()).toEqual(
      [...WAIT_KINDS].sort()
    )
  })
})

describe("Run step instances and waits", () => {
  test("a retried step keeps both instances, keyed by step id and execution count", () => {
    const run = model("two_attempts")
    expect(run.attempts.map((attempt) => attempt.run_id)).toEqual(["run-41", "run-42"])
    expect(run.attempts[1]!.steps.map((step) => [step.key, step.id, step.k, step.state])).toEqual([
      ["check#1", "check", 1, "failed"],
      ["implement#1", "implement", 1, "done"],
      ["check#2", "check", 2, "current"]
    ])
    for (const attempt of run.attempts) {
      const keys = attempt.steps.map((step) => step.key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const phase of attempt.phases) expect(keys).toContain(phase.step)
    }
  })
  test("a step key must be its id and execution count", () => {
    const changed = running()
    changed.attempts[0]!.steps[1]!.key = "check#2"
    expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
    changed.attempts[0]!.steps[1]!.key = "check"
    expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
  })
  test.each([0, -1, 1.5])("k %j is not an execution count", (k) => {
    const changed = running()
    changed.attempts[0]!.steps[1] = { ...changed.attempts[0]!.steps[1]!, k, key: `check#${k}` }
    expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
  })
  test("a model step keeps its usage, duration, agent actor and arbitrary I/O", () => {
    const step = model("running").attempts[0]!.steps[0]!
    expect(step.usage).toEqual({ tokens: 18_400, cost_usd: 0.42 })
    expect(step.took_s).toBe(412)
    expect(step.agent).toMatchObject({ kind: "agent", agent: "coding", for_member: ben })
    expect(step.input).toEqual({ prompt: "Publish card projections" })
    expect(step.output).toEqual({ files: ["packages/rpc/src/MonitorCard.ts"] })
    expect(model("running").attempts[0]!.steps[1]).not.toHaveProperty("usage")
  })
  test("a step's agent is an actor, never the old {name, model} pair", () => {
    const changed = running()
    Object.assign(changed.attempts[0]!.steps[0]!, { agent: { name: "reviewer", model: "gpt-6.1-sol" } })
    expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
  })
  test("step usage tokens and cost reject negative or fractional tokens", () => {
    for (const usage of [{ tokens: -1, cost_usd: 0 }, { tokens: 0.5, cost_usd: 0 }, { tokens: 1, cost_usd: -0.01 }]) {
      const changed = running()
      changed.attempts[0]!.steps[0]!.usage = usage
      expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
    }
  })
  test("a settled wait keeps who settled it and when; an open wait has no receipt", () => {
    const [settled, open] = model("two_attempts").waits
    expect(settled!.settled).toEqual({ by: person, at: "2026-10-02T17:42:00.000Z" })
    expect(open).not.toHaveProperty("settled")
    const { at: _at, ...noAt } = settled!.settled!
    expect(MonitorCardSchema.safeParse({ ...running(), waits: [{ ...settled, settled: noAt }] }).success).toBe(false)
  })
})

describe("Run replay, journal and engine", () => {
  test("replay scrubs at or before the last journal seq", () => {
    expect(model("replay").replay).toEqual({ at: 3, last: 9 })
    for (const [at, last, valid] of [[9, 9, true], [0, 9, true], [10, 9, false], [-1, 9, false], [1.5, 9, false]]) {
      expect(MonitorCardSchema.safeParse({ ...running(), replay: { at, last } }).success, `${at}/${last}`).toBe(valid)
    }
  })
  test("the journal story opens the journal tab and lists entries in seq order", () => {
    expect(fixtures.journal.view.tab).toBe("journal")
    expect(model("journal").journal!.map((entry) => entry.seq)).toEqual([1, 2, 3])
  })
  test("engine labels are required, even when empty", () => {
    const { engine: _engine, ...noEngine } = running()
    expect(MonitorCardSchema.safeParse(noEngine).success).toBe(false)
    expect(model("queued").engine).toEqual([])
  })
})

describe("Run summaries and boundaries", () => {
  test("phases and cells keep stable ids and deterministic titles before summaries arrive", () => {
    const phase = model("running").attempts[0]!.phases[0]!
    expect(phase).toMatchObject({ id: "attempt-1-check", title: "Ran checks · 2 failed" })
    expect(phase.cells[0]).toMatchObject({ id: "attempt-1-check-run", label: "Ran pnpm test · 2 failed" })
    expect(phase).not.toHaveProperty("summary")
    expect(phase.cells[0]).not.toHaveProperty("explain")
  })
  test("phase and cell ids are required independently of model summaries", () => {
    for (const location of ["phase", "cell"] as const) {
      const changed = structuredClone(fixtures.summarized.model)
      const phase = changed.attempts[0]!.phases[0]!
      Reflect.deleteProperty(location === "phase" ? phase : phase.cells[0]!, "id")
      expect(MonitorCardSchema.safeParse(changed).success).toBe(false)
    }
  })
  test("token counts accept zero and reject negative or fractional tokens", () => {
    for (const value of [0, 1, -1, 0.5]) {
      expect(MonitorCardSchema.safeParse({ ...running(), tokens: value }).success).toBe(value === 0 || value === 1)
      const changed = running()
      changed.attempts[0]!.phases[0]!.cells[0]!.tokens = value
      expect(MonitorCardSchema.safeParse(changed).success).toBe(value === 0 || value === 1)
    }
  })
  test.each(["time_s", "cost_usd"] as const)("%s accepts zero/fractions and rejects negative/nonfinite", (field) => {
    for (const value of [0, 0.01, -1, NaN, Infinity]) {
      expect(MonitorCardSchema.safeParse({ ...running(), [field]: value }).success).toBe(value === 0 || value === 0.01)
    }
  })
  test("phase, cell and step durations accept zero/fractions and reject negative values", () => {
    for (const value of [0, 0.25, -1]) {
      const phase = running()
      phase.attempts[0]!.phases[0]!.took_s = value
      expect(MonitorCardSchema.safeParse(phase).success).toBe(value >= 0)
      const cell = running()
      cell.attempts[0]!.phases[0]!.cells[0]!.took_s = value
      expect(MonitorCardSchema.safeParse(cell).success).toBe(value >= 0)
      const step = running()
      step.attempts[0]!.steps[0]!.took_s = value
      expect(MonitorCardSchema.safeParse(step).success).toBe(value >= 0)
    }
  })
})
