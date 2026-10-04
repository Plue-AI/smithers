import { describe, expect, test } from "bun:test"
import type { Card } from "./AppState"
import { childRuns, runStatus } from "./WorkerRuns"

type RunCard = Extract<Card, { kind: "run-trace" }>
const run = (payload: Partial<RunCard["payload"]>, id = "flow-run-run-1"): RunCard => ({
  id, kind: "run-trace", title: "review — owner/repo", status: "active", createdAt: 2_000, ordinal: 2,
  payload: { repo: "owner/repo", runId: "run-1", workflow: "review", phase: "running", steps: [], result: null, lastSeq: 0, ...payload }
})
const spawn = (child: string, flow: string, at: number) => [
  { sequence: at, kind: "control.agent.cell-call-started", occurredAt: at, payload: { flowName: "agent/spawn", input: { flow }, at } },
  { sequence: at + 1, kind: "control.agent.cell-call-settled", occurredAt: at + 1, payload: { flowName: "agent/spawn", outcome: "success", value: { child }, at: at + 1 } }
]

describe("worker runs", () => {
  for (const [phase, expected] of [["completed", "done"], ["failed", "failed"], ["cancelled", "cancelled"]] as const) {
    for (const waiting of [undefined, "approval", "timer"] as const) {
      test(`${phase} remains ${expected} with stale waiting=${waiting ?? "none"}`, () => {
        expect(runStatus(run({ phase, ...(waiting === undefined ? {} : { waiting }) }))).toBe(expected)
      })
    }
  }

  test("a run's status distinguishes launch, waiting, parked and capacity failure", () => {
    expect(runStatus(run({ phase: "launching" }))).toBe("requested")
    expect(runStatus(run({ phase: "running", waiting: "approval" }))).toBe("waiting")
    expect(runStatus(run({ phase: "running", waiting: "timer" }))).toBe("parked")
    expect(runStatus(run({ phase: "no-capacity" }))).toBe("failed")
  })

  test("spawned runs preserve spawn order and scrub boundaries", () => {
    const parent = run({ events: [...spawn("run-2", "lint", 1), ...spawn("run-3", "docs", 3)] })
    const children = childRuns(parent)
    expect(children.map(child => [child.runId, child.title])).toEqual([["run-2", "lint"], ["run-3", "docs"]])
    expect(childRuns(run({ ...parent.payload, cursorSeq: 2 })).map(child => child.runId)).toEqual(["run-2"])
  })

})
