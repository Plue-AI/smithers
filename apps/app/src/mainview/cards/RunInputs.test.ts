import { describe, expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { memoryWords, runInputsOf } from "./RunInputs"

type RunCard = Extract<Card, { kind: "run-trace" }>

const reading = (sequence: number, kept: ReadonlyArray<[string, number]>, withheld: ReadonlyArray<[string, number]>) => ({
  sequence, kind: "control.agent.relevance-settled", occurredAt: sequence,
  payload: { scope: "s", frame: sequence, source: "supervisor", withholdAt: 0.9, latencyMs: 3,
    kept: kept.map(([id, p]) => ({ kind: "memory", id, digest: `d-${id}`, p })),
    withheld: withheld.map(([id, p]) => ({ kind: "memory", id, digest: `d-${id}`, p })) }
})

const run = (payload: Partial<RunCard["payload"]>): RunCard => ({
  id: "flow-run-run-1", kind: "run-trace", title: "implement", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "smithersai/smithers", runId: "run-1", workflow: "implement", phase: "running", steps: [], result: null, lastSeq: 1, ...payload }
})

describe("run inputs", () => {
  test("a run Jev never read has no memory row at all", () => {
    expect(runInputsOf(run({}), [])).toEqual({ secrets: [] })
  })

  test("an item any reading kept is in; one only ever withheld is withheld; both by relevance", () => {
    const memory = runInputsOf(run({ events: [
      reading(1, [["wiki/auth/sessions", 0.18], ["rpc/Session.ts", 0.23]], [["wiki/billing", 0.95], ["wiki/auth/legacy", 0.97]]),
      reading(2, [["wiki/billing", 0.4]], [["app/Login.tsx", 0.92]])
    ] } as Partial<RunCard["payload"]>), []).memory!
    expect(memory.kept.map((item) => [item.id, Number(item.relevance.toFixed(2))]))
      .toEqual([["wiki/auth/sessions", 0.82], ["rpc/Session.ts", 0.77], ["wiki/billing", 0.6]])
    expect(memory.withheld.map((item) => item.id)).toEqual(["app/Login.tsx", "wiki/auth/legacy"])
    expect(memoryWords(memory)).toBe("memory · 3 in · 2 withheld")
    expect(memoryWords({ kept: memory.kept, withheld: [] })).toBe("memory · 3 in")
  })

  test("the box by name when its card is open, the secret names its repository can reach, never a refused one", () => {
    const box = { id: "w", kind: "workspace", title: "", status: "active", createdAt: 0, ordinal: 0,
      payload: { workspaceId: "ws-1", repo: "smithersai/smithers", name: "box-2", targetBookmark: null, status: "running", provisioningStage: null } } as unknown as Card
    const secrets = { id: "s", kind: "secrets", title: "", status: "active", createdAt: 0, ordinal: 0,
      payload: { repo: "smithersai/smithers", scope: "repository", secrets: [
        { name: "DEPLOY_TOKEN", hosts: ["api.vercel.com"], matchHeaders: [], updatedAt: null },
        { name: "OLD_CLAUDE", hosts: [], matchHeaders: [], updatedAt: null, reconnect: true }
      ] } } as unknown as Card
    const other = { ...secrets, id: "s2", payload: { ...(secrets as { payload: object }).payload, repo: "else/where" } } as unknown as Card
    expect(runInputsOf(run({ workspaceId: "ws-1" } as Partial<RunCard["payload"]>), [other, box, secrets])).toEqual({
      runsOn: "box-2", secrets: [{ name: "DEPLOY_TOKEN", hosts: ["api.vercel.com"] }]
    })
    expect(runInputsOf(run({ workspaceId: "ws-9" } as Partial<RunCard["payload"]>), []).runsOn).toBe("ws-9")
  })
})
