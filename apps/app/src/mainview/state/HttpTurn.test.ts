import { appProjectionHash } from "./AppEventStream"
import { digest } from "@smthrs/core/Digest"
import type { AgentTurnBatch, AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { expect, test } from "bun:test"
import { emptyAppProjection, projectAppEvent, seedAppProjection } from "./AppProjection"
import type { AppTransition } from "./AppState"
import { httpToolItems } from "./HttpTurn"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

const token = "a".repeat(64)
const initialCursor = (runId = "turn", legId = "leg"): AgentTurnCursor => ({ version: 1, runId, legId, batch: 0, position: 0, hash: "0".repeat(64) })
const batchOf = (cursor: AgentTurnCursor, frames: AgentTurnFrame[]): AgentTurnBatch => {
  const body = { version: 1 as const, runId: cursor.runId, legId: cursor.legId, batch: cursor.batch + 1, from: cursor.position + 1, previousHash: cursor.hash, frames }
  return { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
}
const cursorOf = (batch: AgentTurnBatch): AgentTurnCursor => ({ version: 1, runId: batch.runId, legId: batch.legId, batch: batch.batch, position: batch.from + batch.frames.length - 1, hash: batch.hash })
const boot = () => seedAppProjection(emptyAppProjection(), { createdAt: 1, theme: "light" })
const step = (snapshot: ReturnType<typeof boot>, transition: AppTransition) => projectAppEvent(snapshot, { transition, revision: snapshot.sessions[0]!.revision + 1, createdAt: 2, persistenceMode: "localStorage" })
const started = (text = "Hello") => step(boot(), { type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text, retry: false, journal: { version: 1, legId: "leg", token } })
const accepted = (text = "Hello") => step(started(text), { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() })

test("a complete HTTP batch projects once with its cursor, shared message semantics and stable per-frame identities", () => {
  const before = accepted()
  const batch = batchOf(initialCursor(), [
    { type: "delta", runId: "turn", kind: "text", text: "Hello " }, { type: "delta", runId: "turn", kind: "text", text: "again" },
    { type: "gate.rejected", runId: "turn", link: 1, kind: "shape" },
    { type: "steering.drained", runId: "turn", link: 1, count: 1 }
  ])
  const event: AppTransition = { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch }
  const next = step(before, event)
  expect(next.messages.find(row => row.id === "message-turn-smithers")?.text).toBe("Hello again")
  expect(next.messages.filter(row => row.act !== undefined)).toHaveLength(2)
  expect(new Set(next.messages.map(row => row.id)).size).toBe(next.messages.length)
  expect(next.httpTurnLegs[0]?.cursor).toEqual(cursorOf(batch))
  expect(step(next, event)).toBe(next)
  expect(appProjectionHash(step(before, event))).toBe(appProjectionHash(next))
  expect(before.messages.some(row => row.role === "smithers")).toBe(false)
  const changed = { ...batch, frames: [{ type: "delta" as const, runId: "turn", kind: "text" as const, text: "forged" }] }
  expect(() => step(before, { ...event, batch: changed })).toThrow("integrity")
  const gap = batchOf({ ...initialCursor(), position: 10 }, [{ type: "delta", runId: "turn", kind: "text", text: "bad" }])
  expect(() => step(before, { ...event, batch: gap })).toThrow("cursor")
})

test("withheld claims, pending calls, settled results and continuation input all survive pure event replay", () => {
  let state = accepted("Send an email to Pat")
  const batch = batchOf(initialCursor(), [
    { type: "delta", runId: "turn", kind: "text", text: "I can send an email." },
    { type: "tool_call", runId: "turn", call_id: "call", name: "commands", arguments: '{"action":"list"}' },
    { type: "done", runId: "turn", reason: "tool_call" }
  ])
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch })
  expect(state.messages.find(row => row.id === "message-turn-smithers")).toBeUndefined()
  expect(state.httpTurns[0]?.claimBuffer).toBe("I can send an email.")
  expect(state.httpTurnLegs[0]).toMatchObject({ status: "tool-ready", call: { callId: "call" } })
  state = step(state, { type: "http.tool.started", actor: "smithers", attemptId: "attempt", legId: "leg" })
  state = step(state, { type: "http.tool.settled", actor: "smithers", attemptId: "attempt", legId: "leg", result: "Available commands" })
  expect(httpToolItems(state.httpTurnLegs, "attempt")).toEqual([
    { type: "function_call", call_id: "call", name: "commands", arguments: '{"action":"list"}' },
    { type: "function_call_output", call_id: "call", output: "Available commands" }
  ])
  state = step(state, { type: "http.leg.prepared", actor: "system", attemptId: "attempt", journal: { version: 1, legId: "leg2", token } })
  state = step(state, { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg2", cursor: initialCursor("turn", "leg2") })
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg2",
    batch: batchOf(initialCursor("turn", "leg2"), [{ type: "done", runId: "turn", reason: "stop" }]) })
  expect(state.messages.find(row => row.id === "message-turn-smithers")?.text).toContain("I can't send or draft email yet")
  expect(state.sessions[0]?.phase).toBe("idle")
  expect(state.httpTurns[0]).toMatchObject({ status: "complete", claimBuffer: "" })
  expect(JSON.stringify(state.transitions)).not.toContain(token)
})

/*
 * The server front door is gone (#3313), and with it the minted
 * `frontdoor-` call id that once made a tool leg's act the turn's answer.
 * Every tool leg now needs text from its continuation, whatever the call id.
 */
test.each(["call_1", "frontdoor-b0a1"])("a tool leg (call id %s) whose continuation carries no text fails as an empty response, and its act stays", (callId) => {
  let state = accepted("list my commands")
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
    batch: batchOf(initialCursor(), [
      { type: "tool_call", runId: "turn", call_id: callId, name: "commands", arguments: '{"action":"list"}' },
      { type: "done", runId: "turn", reason: "tool_call" }
    ]) })
  state = step(state, { type: "http.tool.started", actor: "smithers", attemptId: "attempt", legId: "leg" })
  state = step(state, { type: "http.tool.settled", actor: "smithers", attemptId: "attempt", legId: "leg", result: "Available commands" })
  state = step(state, { type: "http.leg.prepared", actor: "system", attemptId: "attempt", journal: { version: 1, legId: "leg2", token } })
  state = step(state, { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg2", cursor: initialCursor("turn", "leg2") })
  state = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg2",
    batch: batchOf(initialCursor("turn", "leg2"), [{ type: "done", runId: "turn", reason: "stop" }]) })

  expect(state.messages.find(row => row.id === "message-turn-smithers")?.text).toContain("empty response")
  expect(state.messages.filter(row => row.act !== undefined)).toHaveLength(1)
  expect(state.messages.some(row => "answersTurn" in row)).toBe(false)
  expect(state.httpTurns[0]?.status).toBe("failed")
})

/* A self-hosted install runs the turn: its failures name Smithers, never a hosting. */
test("a turn the host ends at its tool limit, or that answers nothing, fails in words that name no hosting", () => {
  for (const [frames, said] of [
    [[{ type: "done", runId: "turn", reason: "tool_limit" }], "Smithers stopped at its tool-call limit."],
    [[{ type: "done", runId: "turn", reason: "stop" }], "Smithers returned an empty response."]
  ] as const) {
    const state = step(accepted("What does the test in this repository check?"), {
      type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
      batch: batchOf(initialCursor(), [...frames])
    })
    const answer = state.messages.find(row => row.id === "message-turn-smithers")
    expect(answer?.statusDetail ?? answer?.text).toContain(said)
    expect(answer?.statusDetail ?? answer?.text).not.toContain("Cloud")
    expect(state.httpTurns[0]?.status).toBe("failed")
  }
})

test("card updates within one batch read preceding card facts and use the shared validated patch contract", () => {
  const before = accepted()
  const card = { id: "file", kind: "file" as const, title: "File", status: "active" as const, ordinal: 1, createdAt: 1,
    payload: { repo: "org/repo", path: "hello.txt", content: "before", truncated: false } }
  const batch = batchOf(initialCursor(), [{ type: "card", runId: "turn", card },
    { type: "card.update", runId: "turn", id: "file", patch: { kind: "file", title: "Updated", payload: { content: "after" } } }])
  const next = step(before, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch })
  expect(next.cards.find(row => row.id === "file")).toMatchObject({ title: "Updated", payload: { content: "after", path: "hello.txt" } })
  expect(before.cards).toEqual([])
  expect(next.httpTurnLegs[0]?.cursor).toEqual(cursorOf(batch))
  const cancelled = step(next, { type: "conversation.reset", actor: "user" })
  expect(cancelled.httpTurns[0]?.status).toBe("cancelled")
  expect(cancelled.httpTurnLegs[0]?.status).toBe("cancelled")
  expect(step(cancelled, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch })).toBe(cancelled)
})

test("an agent turn's TODO card replaces only the model of the card the TODO seam holds; its pending requests and place stay", () => {
  const commit = { key: "commit-1", owner: "ben", operation: "create" as const, body: { title: "Snapshot title", prompt: "Snapshot prompt" }, state: "accepted" as const }
  const held = { id: "todo:12", kind: "todo" as const, title: "T12", status: "active" as const, ordinal: 4, createdAt: 1,
    payload: { n: 12, requests: [commit], answerDraft: "Yes" } }
  let state = step(boot(), { type: "card.upsert", actor: "system", card: held })
  state = step(state, { type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "What is on the stack?", retry: false, journal: { version: 1, legId: "leg", token } })
  state = step(state, { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() })
  // The install's host answers /stack with each open TODO's card, built blank of requests.
  const model = fixtures.queued.model
  const hosted = (n: number) => ({ id: `todo:${n}`, kind: "todo" as const, title: model.title, status: "active" as const, ordinal: 0, createdAt: 2,
    payload: { n, model: { ...model, n }, requests: [] } })
  const batch = batchOf(initialCursor(), [{ type: "card", runId: "turn", card: hosted(12) }, { type: "card", runId: "turn", card: hosted(15) }])
  const next = step(state, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg", batch })
  expect(next.cards.find(row => row.id === "todo:12")).toMatchObject({ ordinal: 4, createdAt: 1, title: model.title,
    payload: { n: 12, model, requests: [commit], answerDraft: "Yes" } })
  // A TODO the seam does not hold yet shows as the host sent it.
  expect(next.cards.find(row => row.id === "todo:15")).toMatchObject(hosted(15))
})
