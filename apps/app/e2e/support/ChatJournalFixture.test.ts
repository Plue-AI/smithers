import { expect, test } from "bun:test"
import { TURN_REPLAY_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { createChatJournalFixture } from "./ChatJournalFixture"

test("replay before launch reports a missing leg rather than rejecting its capability", async () => {
  const fixture = createChatJournalFixture()
  const replay = (token: string) => fixture.access(new Request(`http://localhost${TURN_REPLAY_PATH}`, {
    method: "POST", body: JSON.stringify({ runId: "docs", journal: { legId: "answer", token } })
  }))
  const missing = await replay("capability")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ status: "missing" })
  await fixture.start({ runId: "docs", instructions: "", messages: [], journal: { version: 1, legId: "answer", token: "capability" } },
    () => new Response('{"type":"done"}\n'))
  const accepted = await replay("capability")
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toMatchObject({ status: "ok", batches: [] })
  const forbidden = await replay("wrong-capability")
  expect(forbidden.status).toBe(403)
  expect(await forbidden.json()).toEqual({ status: "forbidden" })
})
