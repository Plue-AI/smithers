import { describe, expect, test } from "bun:test"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import type { ControllerContext } from "./context"
import { createTakeoverController } from "./takeover"

const BOX = "3f2b8c1e-8a7d-4b2a-9c3e-1d2f3a4b5c6d"
const runCard = (events: ReadonlyArray<Record<string, unknown>>): Card => ({
  id: "flow-run-run-1", kind: "run-trace", title: "implement", status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "smithersai/smithers", runId: "run-1", workflow: "implement", phase: "running", steps: [], result: null, lastSeq: 1,
    workspaceId: BOX, events: [...events] }
} as Card)
const CLAUDE = [
  { sequence: 1, kind: "control.agent.turn-opened", occurredAt: 1, payload: { seat: "claude-code:opus", contextDigest: "d" } },
  { sequence: 2, kind: "control.agent.model-settled", occurredAt: 2, payload: { text: "", usage: {}, durationMillis: 1, sessionId: "sess-7" } }
]

const setup = async (events: ReadonlyArray<Record<string, unknown>>, opens: string | { readonly value: string } = { value: "opened" }) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "card.upsert", actor: "system", card: runCard(events) }).isPersisted.promise
  const typed: Array<[string, string]> = []
  const openedOn: Array<string | undefined> = []
  const controller = createTakeoverController({ store, commandActor: "user" } as unknown as ControllerContext, {
    openTerminal: async (workspaceId) => {
      openedOn.push(workspaceId)
      if (typeof opens === "string") return opens
      await store.dispatch({ type: "card.upsert", actor: "system", card: {
        id: `workspace-${BOX}`, kind: "workspace", title: "box-2", status: "active", createdAt: 1, ordinal: 1,
        payload: { workspaceId: BOX, repo: "smithersai/smithers", name: "box-2", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, bookmarkHead: { changeId: "qupxosqw", commitId: "c0ffee1" }, sessions: [], terminalSessionId: "term-1" }
      } as unknown as Card }).isPersisted.promise
      return opens
    },
    input: (sessionId, data) => typed.push([sessionId, data])
  })
  const run = () => store.collections.cards.get("flow-run-run-1") as Extract<Card, { kind: "run-trace" }>
  return { controller, typed, openedOn, run, store }
}

describe("runs.takeover and runs.release", () => {
  test("a wrapped Claude Code run opens its box terminal on the vendor session; Release exits it and clears the card", async () => {
    const { controller, typed, openedOn, run } = await setup(CLAUDE)
    expect(await controller.takeOver("run-1", "flow-run-run-1")).toEqual({ value: "take-over run=run-1 terminal=term-1 session=sess-7" })
    expect(openedOn).toEqual([BOX])
    expect(typed).toEqual([["term-1", "claude --resume sess-7\r"]])
    expect(run().payload.takeover).toEqual({ terminalSessionId: "term-1" })
    expect(await controller.release("run-1", "flow-run-run-1")).toEqual({ value: "release run=run-1" })
    expect(typed.at(-1)).toEqual(["term-1", "/exit\r"])
    expect(run().payload).not.toHaveProperty("takeover")
    expect(await controller.release("run-1", "flow-run-run-1")).toBe("Run run-1 is not taken over.")
  })

  test("a run with no vendor session gets the box's shell and nothing typed", async () => {
    const { controller, typed } = await setup([])
    expect(await controller.takeOver("run-1", "flow-run-run-1")).toEqual({ value: "take-over run=run-1 terminal=term-1" })
    expect(typed).toEqual([])
  })

  test("the terminal's refusal is the answer, and nothing is recorded", async () => {
    const { controller, run } = await setup(CLAUDE, "The box is suspended.")
    expect(await controller.takeOver("run-1", "flow-run-run-1")).toBe("The box is suspended.")
    expect(run().payload).not.toHaveProperty("takeover")
  })

  test("one driver per box: a second take-over on the same box is refused and types nothing", async () => {
    const { controller, typed } = await setup(CLAUDE)
    await controller.takeOver("run-1", "flow-run-run-1")
    typed.length = 0
    expect(await controller.takeOver("run-1", "flow-run-run-1")).toBe("Run run-1 is already taken over on this box; release it first.")
    expect(typed).toEqual([])
  })

  test("a run that settled while taken over does not hold the box", async () => {
    const { controller, run, store } = await setup(CLAUDE)
    await controller.takeOver("run-1", "flow-run-run-1")
    await store.dispatch({ type: "card.upsert", actor: "system", card: { ...run(), payload: { ...run().payload, phase: "completed" } } }).isPersisted.promise
    const next = runCard(CLAUDE) as Extract<Card, { kind: "run-trace" }>
    await store.dispatch({ type: "card.upsert", actor: "system",
      card: { ...next, id: "flow-run-run-2", payload: { ...next.payload, runId: "run-2" } } }).isPersisted.promise
    expect(await controller.takeOver("run-2", "flow-run-run-2")).toEqual({ value: "take-over run=run-2 terminal=term-1 session=sess-7" })
  })
})
