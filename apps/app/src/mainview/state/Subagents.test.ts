import { describe, expect, test } from "bun:test"
import type { Card } from "./AppState"
import { agentSubagent, childRuns, childSubagent, footerOf, parentRunOf, runStatus, runSubagent, toastOf } from "./Subagents"

type AgentCard = Extract<Card, { kind: "agent" }>
type RunCard = Extract<Card, { kind: "run-trace" }>

const local = (phase: "running" | "exited", exitCode: number | null, extra: Partial<AgentCard["payload"]> = {}): AgentCard => ({
  id: "agent-a", kind: "agent", title: "Engineer", status: "active", createdAt: 1_000, ordinal: 1,
  payload: { harnessId: "claude", displayName: "Engineer", tabId: "tab-a", sessionId: "tab-a", cwd: "/repo", phase, exitCode, ...extra } as AgentCard["payload"]
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
})
