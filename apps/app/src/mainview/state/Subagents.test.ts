import { describe, expect, test } from "bun:test"
import type { Card } from "./AppState"
import { agentSubagent, childCardOf, childRuns, childSubagent, footerOf, overview, parentRunOf, runStatus, runSubagent, subagentOf, toastOf } from "./Subagents"

type AgentCard = Extract<Card, { kind: "agent" }>
type RunCard = Extract<Card, { kind: "run-trace" }>
type LocalPayload = Extract<AgentCard["payload"], { harnessId: string }>

const local = (phase: "running" | "exited", exitCode: number | null, extra: Partial<LocalPayload> = {}): AgentCard => ({
  id: "agent-a", kind: "agent", title: "Engineer", status: "active", createdAt: 1_000, ordinal: 1,
  payload: { harnessId: "claude", displayName: "Engineer", tabId: "tab-a", sessionId: "tab-a", cwd: "/repo", phase, exitCode, ...extra }
})
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
    const unnamed = local("running", null, { displayName: "", task: "Review code" })
    expect(subagentOf(unnamed)?.title).toBe("Review code")
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

  test("a local agent follows its process; an unknown exit is Stopped with no clock", () => {
    expect(agentSubagent(local("running", null))).toEqual({ title: "Engineer", status: "running", startedAt: 1_000, entries: [] })
    expect(agentSubagent(local("exited", 0)).status).toBe("done")
    expect(agentSubagent(local("exited", 2)).status).toBe("failed")
    const closed = agentSubagent(local("exited", null))
    expect(closed.status).toBe("cancelled")
    expect(footerOf(closed, 99_000).clock).toBe("Stopped")
    const exited = agentSubagent(local("exited", 0, { statusRollup: {
      subjectId: "session:tab-a", state: "exited", activity: "unknown", health: "healthy", attention: "none", freshness: "stale", updatedAt: 65_000
    } }))
    expect(exited.endedAt).toBe(65_000)
    expect(footerOf(exited, 999_999).clock).toBe("Done 1m 04s")
  })

  test("a cloud session's text and tool parts are its activity; the request is not", () => {
    const card: AgentCard = {
      id: "agent-session-s", kind: "agent", title: "Fix", status: "active", createdAt: Date.parse("2026-09-14T09:00:00Z"), ordinal: 1,
      payload: { cloud: true, displayName: "Fix the retry loop", sessionId: "s", repo: "owner/repo", provider: "codex", workspaceId: null, state: "completed", transcript: [
        { id: 2, role: "assistant", sequence: 2, createdAt: "2026-09-14T09:00:42Z", parts: [
          { type: "tool_call", text: `{"name":"Bash","arguments":"{\\"command\\":\\"bun test\\"}"}` },
          { type: "tool_call", text: `{"name":"Read","arguments":{"path":"src/index.ts"}}` },
          { type: "tool_result", text: "ok" }
        ] },
        { id: 1, role: "user", sequence: 1, createdAt: "2026-09-14T09:00:01Z", parts: [{ type: "text", text: "Fix the retry loop" }] }
      ] }
    }
    const subagent = agentSubagent(card)
    expect(subagent.entries).toEqual([
      { kind: "tool", tool: "bash", state: "pending", target: "bun test" },
      { kind: "tool", tool: "read", state: "done", target: "src/index.ts" }
    ])
    expect(subagent).toMatchObject({ title: "Fix the retry loop", status: "done", endedAt: Date.parse("2026-09-14T09:00:42Z") })
    expect(toastOf(subagent, 0).line).toBe("● Fix the retry loop · Done 42s")
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

  test("the ctrl+s overview nests child runs under their run, depth first, oldest root first", () => {
    const parent = run({ events: [...spawn("run-2", "lint", 1), ...spawn("run-3", "docs", 3)] })
    const lint = run({ runId: "run-2", workflow: "lint", phase: "running", events: spawn("run-4", "format", 5) }, "flow-run-run-2")
    const later = { ...local("running", null), id: "agent-b", createdAt: 3_000 }
    const nodes = overview([later, lint, parent, local("exited", 0)], 6)
    expect(nodes.map(node => [node.id, node.level, node.color, node.subagent.title, node.subagent.status])).toEqual([
      ["agent-a", 0, 0, "Engineer", "done"],
      ["flow-run-run-1", 0, 1, "review — owner/repo", "running"],
      ["flow-run-run-1/run-2", 1, 0, "lint", "running"],
      ["flow-run-run-2/run-4", 2, 0, "format", "requested"],
      ["flow-run-run-1/run-3", 1, 1, "docs", "requested"],
      ["agent-b", 0, 1, "Engineer", "running"]
    ])
    // An agent opens as its card; a run and each child open as their run in the parent's repository.
    expect(nodes[0]!.open).toEqual({ agent: expect.objectContaining({ id: "agent-a" }) })
    expect(nodes[1]!.open).toEqual({ runId: "run-1", repo: "owner/repo" })
    expect(nodes[2]!.open).toEqual({ runId: "run-2", repo: "owner/repo" })
    expect(nodes[2]!.card?.id).toBe("flow-run-run-2")
    expect(nodes[4]!.card).toBeUndefined()
  })

  test("the overview is empty without workers and wraps lane colors", () => {
    expect(overview([], 6)).toEqual([])
    const agents = [0, 1, 2].map(index => ({ ...local("running", null), id: `agent-${index}`, createdAt: index }))
    expect(overview(agents, 2).map(node => node.color)).toEqual([0, 1, 0])
  })

  test("a run that lists itself as its own child is walked once", () => {
    const self = run({ events: spawn("run-1", "review", 1) })
    // parentRunOf ignores the card itself, so the run stays a root; its self-child does not recurse.
    expect(overview([self], 6).map(node => [node.id, node.level])).toEqual([
      ["flow-run-run-1", 0],
      ["flow-run-run-1/run-1", 1]
    ])
  })
})
