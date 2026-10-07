import { digest } from "@smthrs/core/Digest"
import { expect, test } from "bun:test"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { emptyAppProjection, projectAppEvent, seedAppProjection } from "./AppProjection"
import { appProjectionHash } from "./AppEventStream"
import type { AppTransition } from "./AppState"
import { contextMonitor } from "./ContextMonitor"
import { MonitorCardSchema } from "@smthrs/rpc/MonitorCard"
const initialCursor = () => ({ version: 1 as const, runId: "turn", legId: "leg", batch: 0, position: 0, hash: "0".repeat(64) })
const batchOf = (cursor: ReturnType<typeof initialCursor>, frames: AgentTurnFrame[]) => {
  const body = { version: 1 as const, runId: "turn", legId: "leg", batch: 1, from: 1, previousHash: cursor.hash, frames }
  return { ...body, hash: digest(agentTurnJournalDigestInput("batch", body)) }
}
const boot = () => seedAppProjection(emptyAppProjection(), { createdAt: 1, theme: "light" })
const step = (snapshot: ReturnType<typeof boot>, transition: AppTransition) => projectAppEvent(snapshot, {
  transition, revision: snapshot.sessions[0]!.revision + 1, createdAt: 2, persistenceMode: "localStorage"
})
const accepted = () => step(step(boot(), { type: "http.turn.started", actor: "user", attemptId: "attempt", turnId: "turn", text: "Retry?", retry: false,
  journal: { version: 1, legId: "leg", token: "a".repeat(64) } }), { type: "http.leg.accepted", actor: "system", attemptId: "attempt", legId: "leg", cursor: initialCursor() })

test("durable preflight projects its pinned list on the answer and survives event replay", () => {
  const result = { context: [{ kind: "file" as const, label: "retry.ts", ref: "src/webhooks/retry.ts", revision: "abc123", reason: "Retry code" }],
    candidates: [{ kind: "file" as const, label: "retry.ts", ref: "src/webhooks/retry.ts", revision: "abc123" }], model: "owner-fast", durationMs: 12 }
  const event: AppTransition = { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
    batch: batchOf(initialCursor(), [
      { runId: "turn", type: "context.preflight", result },
      { runId: "turn", type: "delta", kind: "text", text: "Retries three times" },
      { runId: "turn", type: "done", reason: "stop" }
    ]) }
  const after = step(accepted(), event)
  expect(after.messages.find(message => message.role === "smithers")?.context).toEqual(result.context)
  expect(after.httpTurns[0]?.preflight).toEqual(result)
  const monitor = MonitorCardSchema.parse(contextMonitor(after.httpTurns[0]!))
  expect(monitor.attempts[0]?.graph).toEqual([{ id: "preflight", label: "Preflight", state: "done", deps: [] }])
  expect(monitor.attempts[0]?.steps[0]?.output).toEqual({ candidates: result.candidates, choices: result.context, model: "owner-fast" })
  expect(monitor.attempts[0]?.steps[0]?.took_s).toBe(0.012)
  expect(appProjectionHash(step(accepted(), event))).toBe(appProjectionHash(after))
  expect(step(after, event)).toBe(after)
})

test("Inspect never reports a started selection as completed and keeps old entries without preflight dark", () => {
  const before = accepted()
  expect(contextMonitor(before.httpTurns[0]!)).toBeUndefined()
  const after = step(before, { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
    batch: batchOf(initialCursor(), [{ runId: "turn", type: "context.preflight", phase: "started",
      result: { candidates: [{ kind: "todo", label: "T10", ref: "10" }], context: [], model: "owner-fast", durationMs: 0 } }]) })
  expect(after.httpTurns[0]?.preflightPhase).toBe("started")
  const monitor = MonitorCardSchema.parse(contextMonitor(after.httpTurns[0]!))
  expect(monitor.attempts[0]?.graph[0]?.state).toBe("current")
  expect(monitor.attempts[0]?.steps[0]?.output).toBeUndefined()
  for (const status of ["failed", "cancelled", "ambiguous"] as const) {
    const stopped = MonitorCardSchema.parse(contextMonitor({ ...after.httpTurns[0]!, status }))
    expect(stopped.state).toBe(status === "failed" ? "failed" : "interrupted")
    expect(stopped.attempts[0]?.graph[0]?.state).toBe("failed")
  }
})

test("paged choices become visible only after the complete durable phase", () => {
  const candidate = { kind: "todo" as const, label: "T1", ref: "T1" }
  const item = { ...candidate, reason: "Relevant" }
  const page = { runId: "turn", type: "context.preflight" as const, phase: "completed" as const, page: { index: 0, total: 2 },
    result: { candidates: [candidate], context: [item], model: "fast", durationMs: 4 } }
  const partialEvent: AppTransition = { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
    batch: batchOf(initialCursor(), [page, { runId: "turn", type: "delta", kind: "text", text: "Answer" }, { runId: "turn", type: "done", reason: "stop" }]) }
  const partial = step(accepted(), partialEvent)
  expect(partial.messages.find(message => message.role === "smithers")?.context).toBeUndefined()
  expect(partial.httpTurns[0]?.preflightPhase).toBe("started")
  const wholeEvent: AppTransition = { type: "http.turn.batch.received", actor: "system", attemptId: "attempt", legId: "leg",
    batch: batchOf(initialCursor(), [page, { ...page, page: { index: 1, total: 2 }, result: { ...page.result, candidates: [], context: [] } },
      { runId: "turn", type: "delta", kind: "text", text: "Answer" }, { runId: "turn", type: "done", reason: "stop" }]) }
  const whole = step(accepted(), wholeEvent)
  expect(whole.messages.find(message => message.role === "smithers")?.context).toEqual([item])
  expect(whole.httpTurns[0]?.preflightPage).toBeUndefined()
  expect(MonitorCardSchema.parse(contextMonitor(whole.httpTurns[0]!)).attempts[0]?.steps[0]?.output).toEqual({ candidates: [candidate], choices: [item], model: "fast" })
  expect(appProjectionHash(step(accepted(), wholeEvent))).toBe(appProjectionHash(whole))
  expect(() => step(accepted(), { ...wholeEvent, batch: batchOf(initialCursor(), [{ ...page, page: { index: 1, total: 2 } }]) })).toThrow("Invalid preflight page sequence")
})
