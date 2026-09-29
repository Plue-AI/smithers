import { describe, expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { harnessSessionOf, takeoverAct } from "./RunTakeover"

type RunCard = Extract<Card, { kind: "run-trace" }>

const row = (sequence: number, kind: string, payload: Record<string, unknown>) => ({ sequence, kind, occurredAt: sequence, payload })
const opened = (sequence: number, seat: string) => row(sequence, "control.agent.turn-opened", { seat, contextDigest: "d" })
const settled = (sequence: number, sessionId?: string) =>
  row(sequence, "control.agent.model-settled", { text: "", usage: {}, durationMillis: 1, ...(sessionId === undefined ? {} : { sessionId }) })

const run = (payload: Partial<RunCard["payload"]>): RunCard => ({
  id: "flow-run-run-1", kind: "run-trace", title: "implement", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "smithersai/smithers", runId: "run-1", workflow: "implement", phase: "running", steps: [], result: null, lastSeq: 1, ...payload }
})

describe("the harness session a take-over resumes", () => {
  test("a wrapped Claude Code seat's newest session, as the vendor's own resume and exit lines", () => {
    expect(harnessSessionOf([opened(1, "claude-code:opus"), settled(2, "sess-a"), settled(3, "sess-b")])).toEqual({
      vendor: "claude", sessionId: "sess-b", resume: "claude --resume sess-b", exit: "/exit"
    })
  })

  test("no session for our own seats, for a row without one, or for an id that is not one shell word", () => {
    expect(harnessSessionOf([opened(1, "anthropic:claude-opus-4-1"), settled(2, "sess-a")])).toBeUndefined()
    expect(harnessSessionOf([opened(1, "claude-code:opus"), settled(2)])).toBeUndefined()
    expect(harnessSessionOf([opened(1, "claude-code:opus"), settled(2, "x; rm -rf /")])).toBeUndefined()
    /* Never an option: a leading dash would reach claude as a flag. */
    expect(harnessSessionOf([opened(1, "claude-code:opus"), settled(2, "--dangerously-skip-permissions")])).toBeUndefined()
    expect(harnessSessionOf([])).toBeUndefined()
  })

  test("Take over while a run with a box is live, Release while it is taken over, nothing otherwise", () => {
    const box = "3f2b8c1e-8a7d-4b2a-9c3e-1d2f3a4b5c6d"
    expect(takeoverAct(run({ workspaceId: box }))).toBe("take over")
    expect(takeoverAct(run({ workspaceId: box, takeover: { terminalSessionId: "t-1" } }))).toBe("release")
    expect(takeoverAct(run({}))).toBeUndefined()
    expect(takeoverAct(run({ workspaceId: box, phase: "completed" }))).toBeUndefined()
    /* A run that settled while taken over offers nothing, not a Release for a finished run. */
    expect(takeoverAct(run({ workspaceId: box, phase: "completed", takeover: { terminalSessionId: "t-1" } }))).toBeUndefined()
  })
})
