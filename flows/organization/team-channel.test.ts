/**
 * The team channel against the Slack fixture: finding or creating the
 * channel, joining it, inviting the owner once; posts under the role's name,
 * threaded per key, written to the wiki copy, never twice; the owner
 * mentioned only by the assistant, once per thread; replies a post asks of
 * other roles, within the thread's budget; the thread read back from Slack;
 * an owner's message in a thread routed as that thread's input; and the wiki
 * log alone while the app lacks its scopes.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { Effect, Fiber } from "effect"
import { ok, refuse, type SlackFixture, startSlackFixture } from "../../packages/smithers/agent/integrations/test/SlackFixture.ts"
import { teamRequest } from "./slack.ts"
import * as TeamChannel from "./team-channel.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-team-channel-"))
const fixtures: Array<SlackFixture> = []
after(async () => {
  for (const fixture of fixtures) await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
})

let serial = 0
const dirs = () => {
  const base = join(scratch, String(++serial))
  mkdirSync(join(base, "root"), { recursive: true })
  mkdirSync(join(base, "state"), { recursive: true })
  return { root: join(base, "root"), stateDir: join(base, "state") }
}

interface World {
  readonly channels: Array<{ id: string; name: string }>
  readonly scopes: boolean
  posted: number
}

const slack = async (world: World) => {
  const fixture = await startSlackFixture((call, response) => {
    if (!world.scopes && call.method.startsWith("conversations.")) return refuse(response, "missing_scope")
    switch (call.method) {
      case "conversations.list": {
        // Two pages: the team channel is on the second.
        const page = call.params.cursor === "p2" ? world.channels : [{ id: "C0OTHER", name: "general" }]
        return ok(response, { channels: page, response_metadata: { next_cursor: call.params.cursor === "p2" ? "" : "p2" } })
      }
      case "conversations.create":
        world.channels.push({ id: "C0NEW", name: call.params.name! })
        return ok(response, { channel: { id: "C0NEW", name: call.params.name } })
      case "conversations.join":
        return ok(response, { channel: { id: call.params.channel } })
      case "conversations.invite":
        return call.params.users === "UALREADY" ? refuse(response, "already_in_channel") : ok(response, { channel: { id: call.params.channel } })
      case "chat.postMessage":
        return ok(response, { channel: call.params.channel, ts: `1800000000.${String(++world.posted).padStart(6, "0")}` })
      case "conversations.replies":
        return ok(response, {
          messages: [
            { ts: call.params.ts, username: "Lead", text: "Contract ready", bot_id: "B1" },
            { ts: "1800000009.000001", user: "UOWNER", text: "Ship Friday" }
          ]
        })
      default:
        return refuse(response, "unknown_method")
    }
  })
  fixtures.push(fixture)
  return fixture
}

const environment = (fixture: SlackFixture, extra: Record<string, string> = {}) => ({
  SMITHERS_SLACK_BOT_TOKEN: "xoxb-fixture",
  SMITHERS_SLACK_APP_TOKEN: "xapp-fixture",
  SMITHERS_SLACK_API_BASE_URL: fixture.apiBaseUrl,
  SMITHERS_SLACK_USER_IDS: "UOWNER",
  ...extra
})

const methods = (fixture: SlackFixture, method: string) => fixture.calls.filter((call) => call.method === method)

test("finds the channel across pages, joins it, and invites the owner once across restarts", async () => {
  const world: World = { channels: [{ id: "C0TEAM", name: "smithers-team" }], scopes: true, posted: 0 }
  const fixture = await slack(world)
  const { stateDir } = dirs()
  const logged: Array<string> = []
  const env = environment(fixture)
  assert.equal(await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: env }, (line) => logged.push(line))), "C0TEAM")
  assert.equal(await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: env }, (line) => logged.push(line))), "C0TEAM")
  assert.equal(methods(fixture, "conversations.create").length, 0)
  assert.deepEqual(methods(fixture, "conversations.invite").map((call) => [call.params.channel, call.params.users]), [["C0TEAM", "UOWNER"]])
  assert.equal(methods(fixture, "conversations.join").length, 2)
  assert.deepEqual(logged, [])
  // A second owner is invited on the next start; one already in the channel counts as invited.
  await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: { ...env, SMITHERS_SLACK_USER_IDS: "UOWNER,UALREADY" } }, () => {}))
  assert.deepEqual(methods(fixture, "conversations.invite").at(-1)!.params.users, "UALREADY")
  assert.deepEqual(TeamChannel.readState(stateDir).invited, ["C0TEAM:UOWNER", "C0TEAM:UALREADY"])
})

test("creates a missing channel under the configured name", async () => {
  const world: World = { channels: [], scopes: true, posted: 0 }
  const fixture = await slack(world)
  const { stateDir } = dirs()
  const id = await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: environment(fixture, { SMITHERS_SLACK_TEAM_CHANNEL: "#Org-Team" }) }, () => {}))
  assert.equal(id, "C0NEW")
  assert.deepEqual(methods(fixture, "conversations.create").map((call) => call.params.name), ["org-team"])
  assert.equal(TeamChannel.channelName({}), "smithers-team")
})

test("without the scopes the wiki log is the channel, said once", async () => {
  const world: World = { channels: [{ id: "C0TEAM", name: "smithers-team" }], scopes: false, posted: 0 }
  const fixture = await slack(world)
  const { root, stateDir } = dirs()
  const logged: Array<string> = []
  const env = environment(fixture)
  assert.equal(await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: env }, (line) => logged.push(line))), undefined)
  assert.equal(logged.length, 1)
  assert.match(logged[0]!, /team channel off .*missing_scope.*reinstalled from the updated manifest/)
  assert.match(TeamChannel.readState(stateDir).fallback!, /missing_scope/)
  const posted = await Effect.runPromise(TeamChannel.post({ root, stateDir, teamDir: "Org/Team", environment: env }, {
    thread: "cli:1",
    role: "lead",
    name: "Lead",
    text: "Contract ready"
  }))
  assert.equal(posted, "wiki")
  assert.equal(methods(fixture, "chat.postMessage").length, 0)
  assert.match(readFileSync(join(root, "Org/Team/Channel.md"), "utf8"), /^# Channel\n\n- \S+ \S+ · lead · Contract ready · \[cli:1\]\n$/)
  // No tokens: nothing to find.
  assert.equal(await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: {} }, () => {})), undefined)
})

test("posts under the role's name, threaded per key, once, mentioning the owner only for the assistant", async () => {
  const world: World = { channels: [{ id: "C0TEAM", name: "smithers-team" }], scopes: true, posted: 0 }
  const fixture = await slack(world)
  const { root, stateDir } = dirs()
  const env = environment(fixture)
  await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: env }, () => {}))
  const options = { root, stateDir, teamDir: "Org/Team", environment: env, assistant: "assistant" }
  const say = (entry: Omit<TeamChannel.Post, "thread"> & { thread?: string }) =>
    Effect.runPromise(TeamChannel.post(options, { thread: "cli:1", ...entry }))

  assert.equal(await say({ role: "lead", name: "Lead", text: "builder → checker", link: "Org/Runs/cli-1" }), "slack")
  assert.equal(await say({ role: "builder", name: "Builder", text: "Started" }), "slack")
  assert.equal(await say({ role: "builder", name: "Builder", text: "Started" }), "duplicate")
  assert.equal(await say({ role: "lead", name: "Lead", text: "Needs Will", mention: true }), "slack")
  assert.equal(await say({ role: "assistant", name: "Assistant", text: "Decide the launch scope", mention: true }), "slack")
  assert.equal(await say({ role: "assistant", name: "Assistant", text: "Still waiting", mention: true }), "slack")
  assert.equal(await say({ thread: "cli:2", role: "lead", name: "Lead", text: "Other task" }), "slack")

  const posts = methods(fixture, "chat.postMessage")
  assert.deepEqual(posts.map((call) => [call.params.username, call.params.thread_ts ?? "", call.params.text]), [
    ["Lead", "", "builder → checker · Org/Runs/cli-1"],
    ["Builder", "1800000000.000001", "Started"],
    ["Lead", "1800000000.000001", "Needs Will"],
    ["Assistant", "1800000000.000001", "<@UOWNER> Decide the launch scope"],
    ["Assistant", "1800000000.000001", "Still waiting"],
    ["Lead", "", "Other task"]
  ])
  assert.ok(posts.every((call) => call.params.channel === "C0TEAM"))
  const wiki = readFileSync(join(root, "Org/Team/Channel.md"), "utf8").split("\n").filter((line) => line.startsWith("- "))
  assert.equal(wiki.length, 6)
  assert.deepEqual(TeamChannel.recent(options, "cli:2").map((line) => line.replace(/^- \S+ \S+ · /, "")), ["lead · Other task · [cli:2]"])
  assert.equal(TeamChannel.threadOf(stateDir, "C0TEAM", "1800000000.000001"), "cli:1")
  assert.equal(TeamChannel.threadOf(stateDir, "C0ELSE", "1800000000.000001"), undefined)

  // The thread as Slack has it, the owner's message included.
  assert.deepEqual(await Effect.runPromise(TeamChannel.history(options, "cli:1")), ["Lead: Contract ready", "owner: Ship Friday"])
  assert.equal((await Effect.runPromise(TeamChannel.history(options, "cli:9"))).length, 0)
})

test("a post naming roles asks each for a reply, never itself, within the thread's budget", async () => {
  const { root, stateDir } = dirs()
  const options = { root, stateDir, teamDir: "Org/Team", environment: {} }
  const say = (role: string, text: string, depth = 0) =>
    Effect.runPromise(TeamChannel.post(options, { thread: "issue-7", role, name: role, text, depth }))
  assert.deepEqual(TeamChannel.mentionsOf("ask @docs and @quality, not email@x.io"), ["docs", "quality"])
  await say("lead", "@builder @lead please check")
  await say("builder", "done, @checker verify", 1)
  await say("checker", "@docs @design look", 2)
  const pending = TeamChannel.takePending(stateDir)
  assert.deepEqual(pending.map((reply) => [reply.from, reply.to, reply.depth]), [
    ["lead", "builder", 1],
    ["builder", "checker", 2],
    ["checker", "docs", 3]
  ])
  assert.deepEqual(TeamChannel.takePending(stateDir), [])
  // The thread's budget is spent: nothing more is asked in it.
  await say("docs", "@design next")
  assert.deepEqual(TeamChannel.takePending(stateDir), [])
  // The serving host starts each reply asked for in a new thread, for roles on the roster only.
  await Effect.runPromise(TeamChannel.post(options, { thread: "issue-8", role: "docs", name: "Docs", text: "@design @ghost next" }))
  const started: Array<string> = []
  const fiber = Effect.runFork(TeamChannel.dispatcher({ stateDir, roles: new Set(["design"]) }, async (reply) => started.push(`${reply.to}:${reply.thread}`), () => {}))
  await new Promise((resolve) => setTimeout(resolve, 300))
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.deepEqual(started, ["design:issue-8"])
})

test("an owner's message in a team thread is that thread's input, recorded in the wiki", async () => {
  const world: World = { channels: [{ id: "C0TEAM", name: "smithers-team" }], scopes: true, posted: 0 }
  const fixture = await slack(world)
  const { root, stateDir } = dirs()
  const env = environment(fixture)
  await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: env }, () => {}))
  const options = { root, stateDir, teamDir: "Org/Team", environment: env }
  await Effect.runPromise(TeamChannel.post(options, { thread: "cli:1", role: "lead", name: "Lead", text: "Contract ready" }))
  const request = {
    key: "slack:T1:Ev1",
    text: "Ship it Friday",
    source: "slack" as const,
    user: "UOWNER",
    conversation: { provider: "slack" as const, channel: "C0TEAM", thread: "1800000000.000001" }
  }
  const routed = teamRequest(stateDir, { root, teamDir: "Org/Team" }, request, Date.parse("2026-09-26T12:00:00Z"))
  assert.match(routed.text, /^Ship it Friday\n\nTeam thread cli:1:\n- .* · lead · Contract ready · \[cli:1\]/)
  assert.match(readFileSync(join(root, "Org/Team/Channel.md"), "utf8"), /owner · Ship it Friday · \[cli:1\]/)
  // A DM is not a team message.
  const direct = { ...request, conversation: { provider: "slack" as const, channel: "D0OWNER", thread: "1" } }
  assert.equal(teamRequest(stateDir, { root, teamDir: "Org/Team" }, direct, 0), direct)
})
