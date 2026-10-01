import { TURN_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { CloudKeychain } from "../CloudAuth"

/*
 * Test-only: the shared backend's turn contract (`POST /api/agent/turn`, the
 * journal delivery stream) in front of a test's model double. The double
 * answers the legacy frame stream (one NDJSON AgentTurnFrame per line, no
 * runId); each frame line is delivered as its own committed batch on the
 * leg the host admitted, exactly as the backend streams them. Every other
 * path (the sign-in scope probe, `/api/agent/turn/cancel`) answers 200 and
 * never reaches the double.
 */

const HASH = "0".repeat(64)

const deliveries = (runId: string, legId: string, frames: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const reader = frames.getReader()
  const decoder = new TextDecoder(), encoder = new TextEncoder()
  let pending = "", batch = 0, position = 0
  const cursor = () => ({ version: 1, runId, legId, batch, position, hash: HASH })
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`)
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(line({ type: "accepted", cursor: cursor() })) },
    async pull(controller) {
      const next = await reader.read()
      pending += decoder.decode(next.value, { stream: !next.done })
      const lines = pending.split("\n")
      pending = next.done ? "" : lines.pop() ?? ""
      for (const text of lines) {
        if (text.trim() === "") continue
        const frame = { ...JSON.parse(text) as Record<string, unknown>, runId }
        const from = position + 1
        batch += 1; position = from
        controller.enqueue(line({ type: "batch", batch: { version: 1, runId, legId, batch, from, previousHash: HASH, frames: [frame], hash: HASH }, cursor: cursor() }))
      }
      if (next.done) controller.close()
    },
    cancel: reason => reader.cancel(reason)
  })
}

/** A Bun.serve fetch handler: the backend's turn route over `model`, which answers one legacy frame stream per turn. */
export const fakeBackend = (model: (request: Request) => Response | Promise<Response>) => async (request: Request): Promise<Response> => {
  if (new URL(request.url).pathname !== TURN_PATH) return Response.json({ status: "ok" })
  const body = await request.clone().json() as { readonly runId: string; readonly journal: { readonly legId: string } }
  const answer = await model(request)
  if (!answer.ok || answer.body === null) return answer
  if (body.journal === undefined) return answer
  return new Response(deliveries(body.runId, body.journal.legId, answer.body), {
    headers: { "content-type": "application/x-ndjson", "x-smithers-turn-journal": "1" }
  })
}

/** A keychain already holding a signed-in Cloud login, so a hybrid host's agent sends turns as that user. */
export const signedInKeychain = (): CloudKeychain => {
  let value: string | null = JSON.stringify({ token: "backend-test-token", username: "test", email: null, expiresAt: "2099-01-01T00:00:00Z" })
  return { read: async () => value, write: async (_service, _account, next) => { value = next }, remove: async () => { value = null } }
}
