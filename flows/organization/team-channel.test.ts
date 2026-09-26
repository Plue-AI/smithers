/**
 * The team channel against the Slack fixture: finding or creating the
 * channel, joining it, inviting the owner once; posts under the role's name,
 * threaded per key, written to the wiki copy, never twice; the owner
 * mentioned only by the assistant, once per thread; replies a post asks of
 * other roles, within the thread's budget; the thread read back from Slack;
 * an owner's message in a thread routed as that thread's input; the wiki
 * log alone while the app lacks its scopes; and every kind of post with its
 * references as links whose pages the upstream holds when Slack gets it.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { Effect, Fiber } from "effect"
import { ok, refuse, type SlackFixture, startSlackFixture } from "../../packages/smithers/agent/integrations/test/SlackFixture.ts"
import { closing } from "./actions.ts"
import * as Links from "./links.ts"
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

test("every kind of post links what it names, each page pushed before the post, the label in place of the path", async () => {
  const world: World = { channels: [{ id: "C0TEAM", name: "smithers-team" }], scopes: true, posted: 0 }
  const { root, stateDir } = dirs()
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const bare = join(root, "..", "wiki.git")
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.name", "Fixture")
  git(root, "config", "user.email", "fixture@example.invalid")
  const page = (path: string, text = `# ${path}\n`) => {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const comment = "Org/Proposals/2026-09-26-security-vm-cancel-revocation-proof.md"
  page(comment)
  git(root, "add", ".")
  git(root, "commit", "-qm", "init")
  git(root, "remote", "add", "origin", bare)
  git(root, "push", "-q", "-u", "origin", "main")
  // What each post links must be on the upstream when Slack receives the post.
  const web = "https://github.com/acme/wiki/blob/main/"
  const missing: Array<string> = []
  const fixture = await startSlackFixture((call, response) => {
    if (call.method === "chat.postMessage") {
      for (const [, path] of (call.params.text ?? "").matchAll(/<https:\/\/github\.com\/acme\/wiki\/blob\/main\/([^|>]+)\|/g)) {
        try {
          execFileSync("git", ["--git-dir", bare, "cat-file", "-e", `main:${decodeURIComponent(path!)}`], { stdio: "ignore" })
        } catch {
          missing.push(decodeURIComponent(path!))
        }
      }
      return ok(response, { channel: call.params.channel, ts: `1800000000.${String(++world.posted).padStart(6, "0")}` })
    }
    if (call.method === "conversations.list") return ok(response, { channels: world.channels, response_metadata: { next_cursor: "" } })
    return call.method === "conversations.join" || call.method === "conversations.invite" ? ok(response, {}) : refuse(response, "unknown_method")
  })
  fixtures.push(fixture)
  const env = environment(fixture)
  await Effect.runPromise(TeamChannel.ensure({ stateDir, environment: env }, () => {}))
  const links = Links.make({
    root,
    stateDir,
    generatedDir: "Org/Runs",
    webUrl: "https://github.com/acme/wiki/blob/main",
    publish: ["Org/Runs", "Org/Specialists", "Org/Team", "Org/Proposals", "Org/Requests"],
    repositories: { "acme/demo": { path: root, github: "acme/demo" } }
  })
  const options = { root, stateDir, teamDir: "Org/Team", environment: env, assistant: "assistant", links }
  const say = (entry: Omit<TeamChannel.Post, "name">, name = entry.role) =>
    Effect.runPromise(TeamChannel.post(options, { ...entry, name }))
  const landed = closing({
    key: "cli-1",
    status: "landed",
    summary: "ok",
    principals: {},
    rounds: 1,
    applied: { branch: "organization/cli-1", commit: "0123456789abcdef0123456789abcdef01234567" } as never
  }, "Org/Runs/cli-1/deliver.json", "assistant", "acme/demo")
  const kinds: ReadonlyArray<readonly [string, Omit<TeamChannel.Post, "name">, ReadonlyArray<string>]> = [
    ["hire", { thread: "hire-1", role: "lead", text: "Hired lead.researcher", link: "Org/Specialists/lead.researcher.md" }, ["Org/Specialists/lead.researcher.md"]],
    ["handoff", { thread: "issue-7", role: "lead", text: "Handoff → builder: fix it", refs: [{ kind: "issue", github: "acme/demo", number: 7 }] }, []],
    ["progress", { thread: "cli-1", role: "checker", text: "Round 1: changes requested: see Org/Runs/cli-1/findings.md and #7" }, ["Org/Runs/cli-1/findings.md"]],
    ["onboarding", { thread: "onboarding-1", role: "lead", text: "Onboarding written", link: "Org/Team/lead/Onboarding.md" }, ["Org/Team/lead/Onboarding.md"]],
    ["proposal", { thread: "onboarding-1", role: "lead", text: "Proposal: Ship X", link: "Org/Proposals/2026-09-26-lead-ship-x.md" }, ["Org/Proposals/2026-09-26-lead-ship-x.md"]],
    ["comment", { thread: "onboarding-2", role: "builder", text: "Commented on 2026-09-26-security-vm-cancel-revocation-proof", link: comment }, []],
    ["request", { thread: "onboarding-2", role: "assistant", text: "Needs you: Pick the release", link: "Org/Requests/2026-09-26-lead-pick.md", mention: true }, ["Org/Requests/2026-09-26-lead-pick.md"]],
    ["routine", { thread: "routine-weekly", role: "lead", text: "Done: weekly", refs: [{ kind: "page", path: "Org/Runs/routines/weekly/2026-09-26.md" }, { kind: "page", path: "Org/Runs/routine-weekly/assignment.json" }] }, ["Org/Runs/routines/weekly/2026-09-26.md", "Org/Runs/routine-weekly/assignment.json"]],
    ["priorities", { thread: "onboarding-3", role: "lead", text: "Priorities: 1 accepted of 2", link: "Org/Team/Priorities.md" }, ["Org/Team/Priorities.md"]],
    ["reply", { thread: "hire-1", role: "builder", text: "@checker `Org/Team/lead/Onboarding.md` is in Org/Team/lead/Onboarding.md." }, []],
    ["final", { thread: "cli-1", role: landed.speaker, text: landed.text, refs: landed.refs }, ["Org/Runs/cli-1/deliver.json"]]
  ]
  const texts: Record<string, string> = {}
  for (const [kind, entry, written] of kinds) {
    // Each page is new when its post goes out, as the host writes it just before.
    for (const path of written) page(path)
    assert.equal(await say(entry), "slack", kind)
    texts[kind] = methods(fixture, "chat.postMessage").at(-1)!.params.text!
  }
  assert.deepEqual(missing, [])
  const link = (path: string, label: string) => `<${web}${path}|${label}>`
  assert.deepEqual(texts, {
    hire: `Hired ${link("Org/Specialists/lead.researcher.md", "lead.researcher")}`,
    handoff: "Handoff → builder: fix it · <https://github.com/acme/demo/issues/7|#7>",
    progress: `Round 1: changes requested: see ${link("Org/Runs/cli-1/findings.md", "findings")} and <https://github.com/acme/demo/issues/7|#7>`,
    onboarding: `${link("Org/Team/lead/Onboarding.md", "Onboarding")} written`,
    proposal: `Proposal: Ship X · ${link("Org/Proposals/2026-09-26-lead-ship-x.md", "2026-09-26-lead-ship-x")}`,
    comment: `Commented on ${link(comment, "2026-09-26-security-vm-cancel-revocation-proof")}`,
    request: `<@UOWNER> Needs you: Pick the release · ${link("Org/Requests/2026-09-26-lead-pick.md", "2026-09-26-lead-pick")}`,
    routine: `Done: weekly · ${link("Org/Runs/routines/weekly/2026-09-26.md", "2026-09-26")} · ${link("Org/Runs/routine-weekly/assignment.json", "receipt")}`,
    priorities: `${link("Org/Team/Priorities.md", "Priorities")}: 1 accepted of 2`,
    reply: `@checker \`Org/Team/lead/Onboarding.md\` is in ${link("Org/Team/lead/Onboarding.md", "Onboarding")}.`,
    // Neither the branch nor the commit is on the remote: code, not a link.
    final: `Landed on \`organization/cli-1\` \`0123456789ab\` · ${link("Org/Runs/cli-1/deliver.json", "receipt")}`
  })
  // No raw vault path outside code, and a path that does not exist is left as it is.
  for (const text of Object.values(texts)) assert.doesNotMatch(text.replaceAll(/`[^`]*`|<[^>]*>/g, ""), /Org\//)
  await say({ thread: "cli-9", role: "lead", text: "See Org/Nowhere.md" })
  assert.equal(methods(fixture, "chat.postMessage").at(-1)!.params.text, "See Org/Nowhere.md")
  // The wiki's copy names pages as wikilinks.
  const wiki = readFileSync(join(root, "Org/Team/Channel.md"), "utf8")
  assert.match(wiki, /builder · Commented on \[\[Org\/Proposals\/2026-09-26-security-vm-cancel-revocation-proof\|2026-09-26-security-vm-cancel-revocation-proof\]\] · \[onboarding-2\]/)
  assert.match(wiki, /assistant · Landed on organization\/cli-1 0123456789ab · \[\[Org\/Runs\/cli-1\/deliver\.json\|receipt\]\] · \[cli-1\]/)
})
