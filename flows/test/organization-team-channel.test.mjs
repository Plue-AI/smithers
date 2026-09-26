/**
 * The team channel on the organization host, end to end against the Slack
 * fixture (the Web API over HTTP, Socket Mode over a real WebSocket) with
 * scripted seats: at start the host creates `#smithers-team`, joins it and
 * invites the owner, and a restart finds it again and invites nobody twice;
 * a hire is announced under the hiring role's name and starts a thread; a
 * role asked in that thread reads it back from Slack and answers there under
 * its own name, and a role it names answers in turn, never itself; nobody
 * mentions the owner; the app's own posts are not taken as requests; and the
 * owner's message in the thread is that thread's input, acknowledged there.
 * A second host whose app lacks the channel scopes keeps the wiki log only.
 *
 * Run: node --test flows/test/organization-team-channel.test.mjs
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { ok, refuse, startSlackFixture } from "../../packages/smithers/agent/integrations/test/SlackFixture.ts"
import { cleanup, host, organization, pause, repository, settled } from "../organization/testing/harness.mjs"

const fixtures = []
after(async () => {
  await cleanup()
  for (const fixture of fixtures) await fixture.close()
})

const researcher = {
  slug: "researcher",
  name: "Competitor Researcher",
  objective: "Compare what competitors charge, with a source and date for every row.",
  responsibilities: ["Collect competitor pricing with sources and dates"],
  tools: ["wiki-read"],
  knowledge: ["Org/Roles/"],
  budget: { tokensPerTask: 50000, tasksPerDay: 1 }
}

const slackEnvironment = (fixture) => ({
  SMITHERS_SLACK_BOT_TOKEN: "xoxb-fixture",
  SMITHERS_SLACK_APP_TOKEN: "xapp-fixture",
  SMITHERS_SLACK_API_BASE_URL: fixture.apiBaseUrl,
  SMITHERS_SLACK_TEAM_IDS: "T1",
  SMITHERS_SLACK_USER_IDS: "UOWNER",
  SMITHERS_ORGANIZATION_SLACK_FIXTURE: "1",
  SMITHERS_ORGANIZATION_SCRIPTED_HIRE: JSON.stringify({ "hire-research": researcher })
})

const waitFor = async (check, what, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = check()
    if (found) return found
    await pause(200)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("the organization's team channel", () => {
  it("creates, joins and invites once, threads persona posts, reads them back, and routes the owner's input", { timeout: 300_000 }, async () => {
    const channels = []
    let posted = 0
    const fixture = await startSlackFixture((request, response) => {
      switch (request.method) {
        case "apps.connections.open":
          return ok(response, { url: fixture.socketUrl() })
        case "conversations.list":
          return ok(response, { channels, response_metadata: { next_cursor: "" } })
        case "conversations.create":
          channels.push({ id: "C0TEAM", name: request.params.name })
          return ok(response, { channel: { id: "C0TEAM", name: request.params.name } })
        case "conversations.join":
          return ok(response, { channel: { id: request.params.channel } })
        case "conversations.invite":
          return ok(response, { channel: { id: request.params.channel } })
        case "conversations.replies":
          // The thread as Slack keeps it: the hire, and a request in it naming the checker.
          return ok(response, {
            messages: [
              { ts: request.params.ts, username: "Lead", text: "Hired lead.researcher", bot_id: "B1" },
              { ts: "1800000200.000001", username: "Will", text: "@checker verify the hire", bot_id: "B1" }
            ]
          })
        case "chat.postMessage":
          return ok(response, { channel: request.params.channel, ts: `1800000100.${String(++posted).padStart(6, "0")}` })
        default:
          return refuse(response, "unknown_method")
      }
    })
    fixtures.push(fixture)
    const root = organization()
    const handle = await host(root, repository(), slackEnvironment(fixture))
    await handle.start()
    const peer = await fixture.nextPeer()
    peer.send({ type: "hello" })
    const calls = (method) => fixture.calls.filter((call) => call.method === method)
    const posts = () => calls("chat.postMessage").filter((call) => call.params.channel === "C0TEAM")

    // The channel is created, joined, and the owner invited.
    assert.deepEqual(calls("conversations.create").map((call) => call.params.name), ["smithers-team"])
    assert.deepEqual(calls("conversations.invite").map((call) => [call.params.channel, call.params.users]), [["C0TEAM", "UOWNER"]])

    // A hire is announced under the hiring role's name and starts its thread.
    const hired = await handle.ops.start("organization/hire", { key: "hire-research", parent: "lead", need: "A sourced pricing brief." }, "hire-research")
    assert.equal((await settled(handle, hired.runId)).status, "completed", handle.output())
    const announcement = posts().find((call) => call.params.text === "Hired lead.researcher · Org/Specialists/lead.researcher.md")
    assert.ok(announcement, JSON.stringify(posts().map((call) => call.params.text)))
    assert.equal(announcement.params.username, "Lead")
    assert.equal(announcement.params.thread_ts, undefined)
    const parent = "1800000100.000001"

    // The builder, asked in the thread, reads it from Slack and answers there; the checker it names answers in turn.
    const asked = await handle.ops.start("organization/team-reply", {
      key: "team-reply-e2e",
      thread: "hire-research",
      from: "lead",
      to: "builder",
      text: "Can you check the hire?",
      depth: 0
    }, "team-reply-e2e")
    assert.equal((await settled(handle, asked.runId)).status, "completed", handle.output())
    assert.ok(calls("conversations.replies").some((call) => call.params.ts === parent && call.params.channel === "C0TEAM"))
    const builder = posts().find((call) => call.params.username === "Builder")
    assert.equal(builder.params.text, "Noted: @checker verify the hire")
    assert.equal(builder.params.thread_ts, parent)
    const checker = await waitFor(() => posts().find((call) => call.params.username === "Checker"), "the checker's reply")
    assert.equal(checker.params.thread_ts, parent)
    // The checker named itself: no one is asked again, and nobody mentioned the owner.
    await pause(4_000)
    assert.equal(posts().filter((call) => call.params.username === "Checker").length, 1)
    assert.ok(fixture.calls.every((call) => !String(call.params.text ?? "").includes("<@UOWNER>")))
    const wiki = readFileSync(join(root, "Org/Team/Channel.md"), "utf8")
    assert.match(wiki, /lead · Hired lead\.researcher · Org\/Specialists\/lead\.researcher\.md · \[hire-research\]/)
    assert.match(wiki, /builder · Noted: @checker verify the hire · \[hire-research\]/)

    // The app's own post in the channel is not a request.
    const before = (await handle.ops.runs({})).length
    const event = (id, body) => peer.send({
      envelope_id: `e-${id}`,
      type: "events_api",
      payload: {
        type: "event_callback",
        team_id: "T1",
        event_id: `Ev-${id}`,
        authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
        event: { type: "message", channel: "C0TEAM", channel_type: "channel", ts: `1800000300.00000${id}`, thread_ts: parent, ...body }
      }
    })
    event(1, { bot_id: "B1", username: "Builder", text: "echo" })
    await pause(2_000)
    assert.equal((await handle.ops.runs({})).length, before)

    // The owner's message in the thread is that thread's input: acknowledged in the thread, kept in the wiki.
    event(2, { user: "UOWNER", text: "Hold the brief until Friday." })
    const ack = await waitFor(() => posts().find((call) => call.params.text === "On it."), "the acknowledgment")
    assert.equal(ack.params.thread_ts, parent)
    assert.match(readFileSync(join(root, "Org/Team/Channel.md"), "utf8"), /owner · Hold the brief until Friday\. · \[hire-research\]/)

    // A restart finds the channel and invites nobody twice.
    await handle.stop()
    await handle.start()
    assert.equal(calls("conversations.create").length, 1)
    assert.equal(calls("conversations.invite").length, 1)
    assert.ok(calls("conversations.join").length >= 2)
  })

  it("keeps the wiki log alone while the app lacks the channel scopes, and says so once", { timeout: 120_000 }, async () => {
    const fixture = await startSlackFixture((request, response) => {
      if (request.method === "apps.connections.open") return ok(response, { url: fixture.socketUrl() })
      if (request.method.startsWith("conversations.")) return refuse(response, "missing_scope")
      return request.method === "chat.postMessage" ? ok(response, { channel: request.params.channel, ts: "1" }) : refuse(response, "unknown_method")
    })
    fixtures.push(fixture)
    const root = organization()
    const handle = await host(root, repository(), slackEnvironment(fixture))
    await handle.start()
    ;(await fixture.nextPeer()).send({ type: "hello" })
    assert.equal(handle.output().match(/team channel off/g)?.length, 1, handle.output())
    assert.match(handle.output(), /missing_scope/)
    const hired = await handle.ops.start("organization/hire", { key: "hire-research", parent: "lead", need: "A sourced pricing brief." }, "hire-research")
    assert.equal((await settled(handle, hired.runId)).status, "completed", handle.output())
    assert.equal(fixture.calls.filter((call) => call.method === "chat.postMessage").length, 0)
    assert.match(readFileSync(join(root, "Org/Team/Channel.md"), "utf8"), /lead · Hired lead\.researcher/)
  })
})
