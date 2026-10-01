import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createChatJournalFixture } from "../../e2e/support/ChatJournalFixture"
import { AgentTurnJournalDeliverySchema, AgentTurnJournalReplySchema, agentTurnJournalDigestInput } from "@smthrs/rpc/AgentTurnJournal"
import { TURN_REPLAY_PATH, TURN_RETIRE_PATH, TURN_ERASE_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"

const request: StartAgentTurnRequest = { runId: "stub-run", messages: [], instructions: "", journal: { version: 1, legId: "stub-leg", token: "stub_private_capability_1234567890123456" } }
const access = { runId: request.runId, journal: request.journal }
const post = (path: string, body: unknown) => new Request(`http://fixture.test${path}`, { method: "POST", body: JSON.stringify(body) })

test("the deterministic fixture seals output, replays only unapplied batches and never repeats a duplicate producer", async () => {
  const fixture = createChatJournalFixture()
  let calls = 0
  const start = () => { calls++; return new Response(`${JSON.stringify({ runId: request.runId, type: "delta", kind: "text", text: "stub" })}\n${JSON.stringify({ runId: request.runId, type: "done" })}\n`) }
  const response = await fixture.start(request, start)
  expect(response.headers.get("x-smithers-turn-journal")).toBe("1")
  const deliveries = (await response.text()).trim().split("\n").map(line => AgentTurnJournalDeliverySchema.parse(JSON.parse(line)))
  expect(deliveries[0]!.type).toBe("accepted")
  const batches = deliveries.filter(delivery => delivery.type === "batch")
  expect(batches).toHaveLength(2)
  for (const delivery of batches) {
    const { hash, ...unsealed } = delivery.batch
    expect(hash).toBe(createHash("sha256").update(agentTurnJournalDigestInput("batch", unsealed)).digest("hex"))
  }
  expect(batches[1]!.batch.previousHash).toBe(batches[0]!.batch.hash)
  expect(AgentTurnJournalReplySchema.parse(await (await fixture.start(request, start)).json())).toMatchObject({ status: "existing", terminal: true })
  expect(calls).toBe(1)
  const replay = AgentTurnJournalReplySchema.parse(await (await fixture.access(post(TURN_REPLAY_PATH, { ...access, after: batches[0]!.cursor }))).json())
  expect(replay).toMatchObject({ status: "ok", terminal: true, more: false, batches: [batches[1]!.batch] })
  expect((await fixture.access(post(TURN_REPLAY_PATH, { ...access, journal: { ...request.journal, token: "wrong" } }))).status).toBe(403)
})

test("fixture retirement checks the replay capability and proof and keeps retired identities unavailable", async () => {
  const fixture = createChatJournalFixture()
  await (await fixture.start(request, () => new Response(`${JSON.stringify({ runId: request.runId, type: "done" })}\n`))).text()
  expect((await fixture.access(post(TURN_RETIRE_PATH, { ...access, journal: { ...request.journal, token: "wrong" } }))).status).toBe(403)
  const proof = { runId: request.runId, legId: request.journal!.legId, retirementProof: createHash("sha256").update(agentTurnJournalDigestInput("access", request.journal!.token)).digest("hex") }
  expect((await fixture.access(post(TURN_ERASE_PATH, { ...proof, retirementProof: "0".repeat(64) }))).status).toBe(403)
  expect(await (await fixture.access(post(TURN_ERASE_PATH, proof))).json()).toEqual({ status: "retired" })
  expect((await fixture.access(post(TURN_REPLAY_PATH, access))).status).toBe(410)
  expect((await fixture.start(request, () => { throw new Error("retired producer repeated") })).status).toBe(410)
  expect((await fixture.access(post(TURN_ERASE_PATH, proof))).status).toBe(200)
})
