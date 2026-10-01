import { createHash } from "node:crypto"
import { TURN_RETIRE_PATH, TURN_ERASE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnBatch, AgentTurnCursor } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"

/** Deterministic test transport only; production recovery belongs to the Go backend. */
export const createChatJournalFixture = () => {
  const turns = new Map<string, { token: string; batches: AgentTurnBatch[]; cursor: AgentTurnCursor; terminal: boolean }>()
  const retired = new Set<string>()
  const key = (runId: string, legId: string) => JSON.stringify([runId, legId])
  return {
    async start(request: StartAgentTurnRequest, start: () => Response): Promise<Response> {
      const journal = request.journal!
      const id = key(request.runId, journal.legId)
      if (retired.has(id)) return Response.json({ status: "retired" }, { status: 410 })
      const previous = turns.get(id)
      if (previous !== undefined) {
        if (previous.token !== journal.token) return Response.json({ status: "error", code: "forbidden" }, { status: 403 })
        return Response.json({ status: "existing", cursor: previous.cursor, terminal: previous.terminal })
      }
      const response = start()
      if (!response.ok || response.body === null) return response
      const turn = { token: journal.token, batches: [] as AgentTurnBatch[], cursor: { version: 1 as const, runId: request.runId, legId: journal.legId, batch: 0, position: 0, hash: "0".repeat(64) }, terminal: false }
      turns.set(id, turn)
      const reader = response.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder()
      let pending = ""
      const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`)
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(line({ type: "accepted", cursor: turn.cursor })) },
        async pull(controller) {
          const next = await reader.read()
          pending += decoder.decode(next.value, { stream: !next.done })
          const lines = pending.split("\n")
          pending = next.done ? "" : lines.pop() ?? ""
          for (const text of lines) {
            if (!text.trim()) continue
            const frame = JSON.parse(text) as AgentTurnFrame
            const unsealed = { version: 1 as const, runId: request.runId, legId: journal.legId, batch: turn.cursor.batch + 1, from: turn.cursor.position + 1, previousHash: turn.cursor.hash, frames: [frame] }
            const batch = { ...unsealed, hash: createHash("sha256").update(agentTurnJournalDigestInput("batch", unsealed)).digest("hex") }
            turn.batches.push(batch)
            turn.cursor = { ...turn.cursor, batch: batch.batch, position: batch.from, hash: batch.hash }
            turn.terminal ||= frame.type === "done"
            controller.enqueue(line({ type: "batch", batch, cursor: turn.cursor }))
          }
          if (next.done) controller.close()
        },
        cancel: reason => reader.cancel(reason)
      }), { headers: { "content-type": "application/x-ndjson", "x-smithers-turn-journal": "1" } })
    },
    async access(request: Request): Promise<Response> {
      const body = await request.json() as { runId: string; legId?: string; journal?: { legId: string; token: string }; after?: AgentTurnCursor; retirementProof?: string }
      const id = key(body.runId, body.journal?.legId ?? body.legId!)
      const turn = turns.get(id)
      const path = new URL(request.url).pathname
      if (retired.has(id)) return Response.json({ status: "retired" }, { status: path === TURN_ERASE_PATH ? 200 : 410 })
      if (path !== TURN_ERASE_PATH && turn?.token !== body.journal?.token) return Response.json({ status: "forbidden" }, { status: 403 })
      if (path === TURN_ERASE_PATH && turn !== undefined && body.retirementProof !== createHash("sha256").update(agentTurnJournalDigestInput("access", turn.token)).digest("hex")) {
        return Response.json({ status: "error", code: "forbidden" }, { status: 403 })
      }
      if (path === TURN_RETIRE_PATH || path === TURN_ERASE_PATH) {
        turns.delete(id); retired.add(id)
        return Response.json({ status: "retired" })
      }
      if (turn === undefined) return Response.json({ status: "missing" }, { status: 404 })
      const batches = turn.batches.filter(batch => batch.batch > (body.after?.batch ?? 0))
      return Response.json({ status: "ok", after: body.after ?? { ...turn.cursor, batch: 0, position: 0, hash: "0".repeat(64) }, next: turn.cursor, head: turn.cursor, batches, terminal: turn.terminal, more: false })
    }
  }
}
