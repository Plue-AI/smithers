import { describe, expect, test } from "bun:test"
import type { Card } from "./AppState"
import { childCardOf, childRuns, childSubagent, parentRunOf, runStatus, runSubagent, subagentOf, toastOf } from "./Subagents"

type RunCard = Extract<Card, { kind: "run-trace" }>
const run = (payload: Partial<RunCard["payload"]>, id = "flow-run-run-1"): RunCard => ({
  id, kind: "run-trace", title: "review — owner/repo", status: "active", createdAt: 2_000, ordinal: 2,
  payload: { repo: "owner/repo", runId: "run-1", workflow: "review", phase: "running", steps: [], result: null, lastSeq: 0, ...payload }
})
const spawn = (child: string, flow: string, at: number) => [
  { sequence: at, kind: "control.agent.cell-call-started", occurredAt: at, payload: { flowName: "agent/spawn", input: { flow }, at } },
  { sequence: at + 1, kind: "control.agent.cell-call-settled", occurredAt: at + 1, payload: { flowName: "agent/spawn", outcome: "success", value: { child }, at: at + 1 } }
]

describe("subagents from worker cards", () => {
  for (const [phase, expected] of [["completed", "done"], ["failed", "failed"], ["cancelled", "cancelled"]] as const) {
    for (const waiting of [undefined, "approval", "timer"] as const) {
      test(`${phase} remains ${expected} with stale waiting=${waiting ?? "none"}`, () => {
        expect(runStatus(run({ phase, ...(waiting === undefined ? {} : { waiting }) }))).toBe(expected)
      })
    }
  }

  test("settled runs freeze at their last dated activity while live runs have no invented end", () => {
    const rows = [{ sequence: 2, at: 41_000, kind: "answer", text: "second" }, { sequence: 1, at: 42_000, kind: "answer", text: "first" }]
    const before = structuredClone(rows)
    expect(runSubagent(run({ phase: "completed", transcriptRows: rows }))).toEqual({ title: "review — owner/repo", status: "done", startedAt: 2_000, endedAt: 42_000,
      entries: [{ kind: "text", text: "first" }, { kind: "text", text: "second" }] })
    expect(runSubagent(run({ phase: "running", transcriptRows: rows })).endedAt).toBeUndefined()
    expect(rows).toEqual(before)
    expect(subagentOf(undefined)).toBeUndefined()
    const status: Extract<Card, { kind: "status" }> = { id: "status", kind: "status", status: "active", title: "Status", createdAt: 1, ordinal: 1, payload: {} }
    expect(subagentOf(status)).toBeUndefined()
  })

  test("child and parent lookup keep repository/workspace ownership, independent of scrub cursor", () => {
    const workspace = "83e75ae5-0920-4000-8000-000000000001"
    const parent = run({ workspaceId: workspace, cursorSeq: 0, events: [...spawn("run-child", "lint", 1)] })
    const child = run({ workspaceId: workspace, runId: "run-child", workflow: "lint", phase: "completed" }, "child")
    const wrongRepo = run({ ...child.payload, repo: "other/repo" }, "wrong-repo")
    const wrongWorkspace = run({ ...child.payload, workspaceId: "83e75ae5-0920-4000-8000-000000000002" }, "wrong-workspace")
    expect(childCardOf([wrongRepo, wrongWorkspace], parent, "run-child")).toBeUndefined()
    expect(childCardOf([wrongRepo, wrongWorkspace, child], parent, "run-child")).toBe(child)
    expect(childRuns(parent)).toEqual([])
    expect(childRuns(parent, true).map(each => [each.runId, each.title])).toEqual([["run-child", "lint"]])
    expect(parentRunOf([wrongRepo, wrongWorkspace, parent, child], child)).toMatchObject({ parent: { id: "flow-run-run-1" }, index: 0, child: { runId: "run-child", title: "lint" } })
    expect(parentRunOf([parent], wrongRepo)).toBeUndefined()
    expect(parentRunOf([parent], wrongWorkspace)).toBeUndefined()
  })

  

  

  test("a run's status maps the way its toast does, and its transcript rows are its activity", () => {
    expect(runStatus(run({ phase: "launching" }))).toBe("requested")
    expect(runStatus(run({ phase: "running", waiting: "approval" }))).toBe("waiting")
    expect(runStatus(run({ phase: "running", waiting: "timer" }))).toBe("parked")
    expect(runStatus(run({ phase: "no-capacity" }))).toBe("failed")
    const subagent = runSubagent(run({ transcriptRows: [{ sequence: 2, kind: "answer", text: "b" }, { sequence: 1, kind: "answer", text: "a" }] }), "review")
    expect(subagent).toEqual({ title: "review", status: "running", startedAt: 2_000, entries: [{ kind: "text", text: "a" }, { kind: "text", text: "b" }] })
    expect(toastOf(subagent, 44_000).text).toBe("review · 42s")
  })

  test("a run's spawned children read their own run cards once opened, and know their parent", () => {
    const parent = run({ events: [...spawn("run-2", "lint", 1), ...spawn("run-3", "docs", 3)] })
    const children = childRuns(parent)
    expect(children.map(child => [child.runId, child.title])).toEqual([["run-2", "lint"], ["run-3", "docs"]])
    expect(childRuns(run({ ...parent.payload, cursorSeq: 2 })).map(child => child.runId)).toEqual(["run-2"])
    expect(childSubagent(children[0]!, undefined)).toMatchObject({ title: "lint", status: "requested", entries: [] })
    const opened = run({ runId: "run-3", workflow: "docs", phase: "completed" }, "flow-run-run-3")
    expect(childSubagent(children[1]!, opened)).toMatchObject({ title: "docs", status: "done" })
    expect(parentRunOf([parent, opened], opened)).toMatchObject({ parent: { id: parent.id }, index: 1, child: { title: "docs" } })
    expect(parentRunOf([opened], opened)).toBeUndefined()
  })

  

  

  
})
