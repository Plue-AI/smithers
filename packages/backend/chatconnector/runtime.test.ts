import { strict as assert } from "node:assert"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { openHost } from "./runtime.ts"

test("production host reopens a lost receipt without a second provider write", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-host-test-"))
  let sent = 0, state = "pending", loseReceipt = true
  const server = createServer((req, res) => {
    req.resume()
    if (req.url?.endsWith("chat.postMessage")) sent++
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true, channel: "C001", ts: "100.000001" }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const request = async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      state = "dispatching"
      return Response.json({ state, token: "fixture-claim" })
    }
    if (init?.method === "PUT") {
      if (loseReceipt) return new Response(null, { status: 503 })
      assert.equal(JSON.parse(String(init.body)).message_id, "100.000001")
      state = "sent"
      return Response.json({})
    }
    return Response.json(state === "sent" ? [] : [{
      id: 1, key: "key", issue_id: 42, state, claim_token: state === "dispatching" ? "fixture-claim" : "",
      event: "comment.created", payload: { comment: { id: 7, body: "hello" } }, message_id: "",
      mapping: { provider: "slack", connection_id: "slack", scope_id: "T001", conversation_id: "C001", thread_id: "" }
    }])
  }
  const config = { owner: "will", repo: "chat", slack: { teamIds: ["T001"], channelIds: ["C001"], userIds: [] } }
  const env = { SMITHERS_SLACK_BOT_TOKEN: "fixture", SMITHERS_SLACK_APP_TOKEN: "fixture", SMITHERS_SLACK_API_BASE_URL: `http://127.0.0.1:${address.port}` }
  let host: Awaited<ReturnType<typeof openHost>> | undefined
  try {
    host = await openHost({ config, stateRoot: root, env, request })
    assert.equal(host.durability, "durable")
    await assert.rejects(host.drain(), /receipts did not commit/)
    assert.equal(sent, 1)
    await host.close()
    loseReceipt = false
    host = await openHost({ config, stateRoot: root, env, request })
    assert.equal(await host.drain(), 1)
    assert.equal(sent, 1)
  } finally {
    await host?.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test("Telegram intake checkpoints its cursor in the host's durable store", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-telegram-test-"))
  const offsets: Array<number | undefined> = []
  const allowed: Array<unknown> = []
  let admitted = 0
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    const { offset, allowed_updates } = JSON.parse(body)
    offsets.push(offset)
    allowed.push(allowed_updates)
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true, result: offset === undefined ? [{
      update_id: 10, message: { message_id: 7, date: 100, text: "hello", chat: { id: -100 }, from: { id: 42, is_bot: false } }
    }] : [] }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  const options = {
    config: { owner: "will", repo: "chat", telegram: { botId: "123", chatIds: ["-100"], userIds: ["42"] } },
    stateRoot: root,
    env: { SMITHERS_TELEGRAM_BOT_TOKEN: "fixture", SMITHERS_TELEGRAM_API_BASE_URL: `http://127.0.0.1:${port}` },
    request: async () => { admitted++; return Response.json({ issue_id: 42 }) }
  }
  let host: Awaited<ReturnType<typeof openHost>> | undefined
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail("intake did not checkpoint")
  }
  try {
    host = await openHost(options)
    let controller = new AbortController()
    let run = host.run(controller.signal).catch(error => { if (!controller.signal.aborted) console.error(error) })
    await until(() => offsets.includes(11))
    controller.abort()
    await run
    await host.close()
    const db = new DatabaseSync(join(root, "engine.sqlite"))
    assert.equal(db.prepare("SELECT cursor FROM smithers_integration_cursors WHERE source_id='telegram'").get()?.cursor, "11")
    db.close()
    offsets.length = 0
    host = await openHost(options)
    controller = new AbortController()
    run = host.run(controller.signal).catch(error => { if (!controller.signal.aborted) console.error(error) })
    await until(() => offsets.length > 0)
    controller.abort()
    await run
    assert.equal(offsets[0], 11)
    assert.equal(admitted, 1)
    assert.deepEqual(allowed[0], ["message", "edited_message", "message_reaction"])
  } finally {
    await host?.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test("Slack startup catches up a message missed while offline exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-slack-catchup-test-"))
  const now = Math.floor(Date.now() / 1000)
  const history: Array<{ type: string; user: string; text: string; ts: string; bot_id?: string }> = [
    { type: "message", user: "U001", text: "before the connector existed", ts: `${now - 60}.000100` }
  ]
  const oldest: Array<string | null> = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    const params = new URLSearchParams(body)
    res.setHeader("content-type", "application/json")
    if (req.url?.endsWith("auth.test")) return res.end(JSON.stringify({ ok: true, team_id: "T001", user_id: "UBOT" }))
    if (req.url?.endsWith("conversations.history")) {
      assert.equal(params.get("channel"), "C001")
      oldest.push(params.get("oldest"))
      const after = Number(params.get("oldest") ?? 0)
      return res.end(JSON.stringify({ ok: true, messages: history.filter(m => Number(m.ts) > after).reverse(), has_more: false }))
    }
    // Socket Mode stays unavailable: this test covers history only.
    res.end(JSON.stringify({ ok: false, error: "not_allowed_token_type" }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  const ingested: Array<Record<string, unknown>> = []
  const options = {
    config: { owner: "will", repo: "chat", slack: { teamIds: ["T001"], channelIds: ["C001"], userIds: ["U001"] } },
    stateRoot: root,
    env: { SMITHERS_SLACK_BOT_TOKEN: "fixture", SMITHERS_SLACK_APP_TOKEN: "fixture", SMITHERS_SLACK_API_BASE_URL: `http://127.0.0.1:${port}` },
    request: async (path: string, init?: RequestInit) => {
      if (path.endsWith("/events")) ingested.push(JSON.parse(String(init?.body)))
      return Response.json(path.endsWith("/events") ? { issue_id: 42 } : [])
    }
  }
  const start = async (calls: number) => {
    const host = await openHost(options)
    const controller = new AbortController()
    const run = host.run(controller.signal).catch(() => {})
    for (let i = 0; i < 200 && oldest.length < calls; i++) await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    await run
    await host.close()
    assert.equal(oldest.length, calls, "catch-up did not read history")
  }
  try {
    // First start follows from now: history older than the connector is not imported.
    await start(1)
    assert.equal(ingested.length, 0)
    const watermark = oldest[0]!
    // While offline, a person writes and a bot writes.
    history.push(
      { type: "message", user: "U001", text: "missed while offline", ts: `${now + 5}.000200` },
      { type: "message", bot_id: "B001", user: "UBOT", text: "bot echo", ts: `${now + 6}.000300` }
    )
    await start(2)
    assert.equal(oldest[1], watermark)
    assert.deepEqual(ingested.map(e => [e["kind"], e["message_id"], e["body"], e["scope_id"], e["conversation_id"]]), [
      ["message", `${now + 5}.000200`, "missed while offline", "T001", "C001"]
    ])
    // The next start resumes after the newest message seen, so nothing repeats.
    await start(3)
    assert.equal(oldest[2], `${now + 6}.000300`)
    assert.equal(ingested.length, 1)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
