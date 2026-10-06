import { digest } from "@smthrs/core/Digest"
import { expect, test } from "bun:test"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { emptyAppProjection, projectAppEvent, seedAppProjection } from "./AppProjection"
import { appProjectionHash } from "./AppEventStream"
import type { AppTransition } from "./AppState"
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
  expect(appProjectionHash(step(accepted(), event))).toBe(appProjectionHash(after))
  expect(step(after, event)).toBe(after)
})
