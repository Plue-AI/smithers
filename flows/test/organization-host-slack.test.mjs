/**
 * The organization host's one Slack app, end to end against the Slack
 * fixture server (`@smthrs/integrations`' test fixture: the Web API over
 * HTTP and Socket Mode over a real WebSocket):
 *
 * - The owner's direct message starts a delivery and is marked 👀; the
 *   Approval gate before the landing is asked in the thread with buttons and
 *   the message marked ⏸️; a stranger's press changes nothing; the owner's
 *   press lands the change; the thread ends with one line, the outcome, the
 *   branch and commit, and the receipt as a link to the wiki, pushed before
 *   the post; and the 👀 and ⏸️ become ✅. Nothing else is posted in the owner's
 *   thread: the contract and the checker's verdict are in the receipt.
 *   Slack's redelivery of the same event joins the run it started.
 * - A question is not a task: the assistant routes it to the role that
 *   knows, which answers in one reply with links, and no contract, workspace
 *   or check runs.
 * - An app that cannot react acknowledges with "On it." instead.
 *
 * The host is the scripted-seat host in its own process with real microVM
 * workspaces; the suite skips, by name, only where no microVM boots.
 *
 * Run: node --test flows/test/organization-host-slack.test.mjs
 */
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { ok, refuse, startSlackFixture } from "../../packages/smithers/agent/integrations/test/SlackFixture.ts"
import {
  branches,
  cleanup,
  git,
  host,
  line,
  organization,
  pause,
  pushed,
  receipt,
  repository,
  settled,
  unbootable,
  wikiRemote
} from "../organization/testing/harness.mjs"

const DM = "D0OWNER1"
const ASKED_TS = "1700000000.000100"
const WEB = "https://github.com/example/wiki/blob/main"
/** The scripted seats' answer to a question (`testing/scripted-host.ts`). */
const scriptedAnswer = "Control evidence is what a check records as proof. See Org/Organization.md and #1."
const missing = unbootable()

const fixtures = []
after(async () => {
  await cleanup()
  for (const fixture of fixtures) await fixture.close()
})

/**
 * A Slack fixture that posts, updates, and reacts (unless `reacts` is false:
 * `missing_scope`), and records, for each post, which wiki pages it links that
 * the bare remote did not hold yet.
 */
const slack = async ({ bare, reacts = true } = {}) => {
  let posted = 0
  const unpushed = []
  const fixture = await startSlackFixture((request, response) => {
    switch (request.method) {
      case "apps.connections.open":
        return ok(response, { url: fixture.socketUrl() })
      case "chat.postMessage":
        for (const [, path] of (request.params.text ?? "").matchAll(/<https:\/\/github\.com\/example\/wiki\/blob\/main\/([^|>]+)\|/g)) {
          if (bare === undefined || !pushed(bare, decodeURIComponent(path))) unpushed.push(decodeURIComponent(path))
        }
        return ok(response, { channel: request.params.channel, ts: `1700000100.${String(++posted).padStart(6, "0")}` })
      case "chat.getPermalink":
        return ok(response, { permalink: "https://example.slack.com/archives/D0OWNER1/p1" })
      case "chat.update":
        return ok(response, { channel: request.params.channel, ts: request.params.ts })
      case "reactions.add":
      case "reactions.remove":
        return reacts ? ok(response, {}) : refuse(response, "missing_scope")
      default:
        return refuse(response, "unknown_method")
    }
  })
  fixtures.push(fixture)
  const call = async (match, timeoutMs = 240_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = fixture.calls.find(match)
      if (found !== undefined) return found
      await pause(200)
    }
    throw new Error(`no Slack call matched; calls: ${JSON.stringify(fixture.calls.map((each) => [each.method, each.params.text ?? each.params.name]))}`)
  }
  const posts = () => fixture.calls.filter((each) => each.method === "chat.postMessage")
  const reactions = () =>
    fixture.calls.filter((each) => each.method.startsWith("reactions.")).map((each) => [each.method, each.params.channel, each.params.timestamp, each.params.name])
  return { fixture, call, posts, reactions, unpushed }
}

const slackEnvironment = (fixture, extra = {}) => ({
  SMITHERS_SLACK_BOT_TOKEN: "xoxb-fixture",
  SMITHERS_SLACK_APP_TOKEN: "xapp-fixture",
  SMITHERS_SLACK_API_BASE_URL: fixture.apiBaseUrl,
  SMITHERS_SLACK_TEAM_IDS: "T1",
  SMITHERS_SLACK_USER_IDS: "UOWNER",
  SMITHERS_ORGANIZATION_SLACK_FIXTURE: "1",
  ...extra
})

/** The owner's direct message, as Socket Mode delivers it. */
const dm = (id, text) => ({
  envelope_id: `e-${id}`,
  type: "events_api",
  payload: {
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev-${id}`,
    authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
    event: { type: "message", channel: DM, channel_type: "im", user: "UOWNER", text, ts: ASKED_TS }
  }
})

const intakes = async (handle) => (await handle.ops.runs()).filter((view) => view.flowId === "organization/intake")

describe("the organization host's Slack app", { skip: missing === undefined ? false : `skipped: ${missing}` }, () => {
  it("delivers an owner's DM through an approval asked with buttons in its thread", { timeout: 420_000 }, async () => {
    const repo = repository()
    const main = git(repo, "rev-parse", "main")
    const root = organization((org) => writeFileSync(join(org, "Policy/Gates.md"), [
      "---",
      "revision: slack-approval",
      "gates:",
      "  - at: { boundary: external-write, target: organization/apply-change }",
      "    spec: { _tag: Approval, id: land, approver: owner, prompt: \"Land this change?\" }",
      "---",
      ""
    ].join("\n")))
    const bare = wikiRemote(root)
    const { fixture, call, posts, reactions, unpushed } = await slack({ bare })
    const handle = await host(root, repo, slackEnvironment(fixture))
    await handle.start()
    const peer = await fixture.nextPeer()
    peer.send({ type: "hello" })

    const message = dm("dm", "Add a line to README.md")
    peer.send(message)
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-dm" })

    // The owner's message is marked 👀: no acknowledgement is posted.
    const eyes = await call((each) => each.method === "reactions.add" && each.params.name === "eyes")
    assert.equal(eyes.authorization, "Bearer xoxb-fixture")
    assert.equal(eyes.params.channel, DM)
    assert.equal(eyes.params.timestamp, ASKED_TS)

    // The gate is asked in the thread with the owner's buttons, and the message marked ⏸️.
    const prompt = await call((each) => each.method === "chat.postMessage" && each.params.text?.startsWith("Land this change?"))
    assert.equal(prompt.params.thread_ts, ASKED_TS)
    const buttons = JSON.parse(prompt.params.blocks).find((block) => block.type === "actions").elements
    const approve = buttons.find((button) => button.action_id.endsWith(":a"))
    assert.ok(approve, prompt.params.blocks)
    await call((each) => each.method === "reactions.add" && each.params.name === "double_vertical_bar" && each.params.timestamp === ASKED_TS)

    // Slack delivers the same message again: it joins the run it started.
    peer.send({ ...message, envelope_id: "e-dm-again" })
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-dm-again" })

    const press = (user, trigger) => ({
      envelope_id: `e-press-${trigger}`,
      type: "interactive",
      payload: {
        type: "block_actions",
        team: { id: "T1" },
        user: { id: user, team_id: "T1" },
        channel: { id: DM },
        container: { channel_id: DM, message_ts: "1700000100.000001", thread_ts: ASKED_TS },
        trigger_id: trigger,
        actions: [{ action_id: approve.action_id, value: "approve" }]
      }
    })
    // A stranger's press is dropped at the door; the gate stays open.
    peer.send(press("USTRANGER", "t-1"))
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-press-t-1" })
    await pause(3_000)
    const [waiting] = await intakes(handle)
    assert.equal(waiting.status, "waiting-approval")
    assert.equal(fixture.calls.some((each) => each.method === "chat.update"), false)

    // The owner's press answers the gate, updates the prompt, and takes the ⏸️ off.
    peer.send(press("UOWNER", "t-2"))
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-press-t-2" })
    const update = await call((each) => each.method === "chat.update")
    assert.equal(update.params.text, "Approved by <@UOWNER>: land.")
    assert.equal((await settled(handle, waiting.runId)).status, "completed", handle.output())

    const report = receipt(root, "slack:T1:Ev-dm").report
    assert.equal(report.status, "landed")
    // The thread ends with one line: the outcome, the branch and commit (not on
    // a remote: code), and the receipt as a link the wiki's remote already holds.
    const result = await call((each) => each.method === "chat.postMessage" && each.params.text?.startsWith("Landed on "))
    assert.equal(
      result.params.text,
      `Landed on \`${report.applied.branch}\` \`${report.applied.commit.slice(0, 12)}\` · <${WEB}/Org/Runs/slack-T1-Ev-dm/deliver.json|receipt>`
    )
    assert.deepEqual(unpushed, [])
    assert.equal(result.params.username, "Assistant")
    assert.equal(result.params.thread_ts, ASKED_TS)
    // 👀 and ⏸️ become ✅.
    await call((each) => each.method === "reactions.add" && each.params.name === "white_check_mark")
    assert.deepEqual(reactions(), [
      ["reactions.add", DM, ASKED_TS, "eyes"],
      ["reactions.add", DM, ASKED_TS, "double_vertical_bar"],
      ["reactions.remove", DM, ASKED_TS, "double_vertical_bar"],
      ["reactions.remove", DM, ASKED_TS, "eyes"],
      ["reactions.remove", DM, ASKED_TS, "double_vertical_bar"],
      ["reactions.add", DM, ASKED_TS, "white_check_mark"]
    ])
    // Nothing else reached the owner's thread: no acknowledgement, no contract, no verdict.
    assert.deepEqual(
      posts().filter((each) => each.params.channel === DM).map((each) => each.params.text.split("\n")[0]),
      ["Land this change?", result.params.text]
    )
    assert.equal(git(repo, "show", `${report.applied.branch}:README.md`), `# Demo\n${line}`)
    assert.deepEqual(branches(repo), [report.applied.branch])
    assert.equal(git(repo, "rev-parse", "main"), main)
    assert.equal((await intakes(handle)).length, 1)
    await handle.stop()
  })

  it("answers a question in one reply from the role that knows, with links, and no delivery", { timeout: 240_000 }, async () => {
    const repo = repository()
    const root = organization()
    const bare = wikiRemote(root)
    const { fixture, call, posts, reactions, unpushed } = await slack({ bare })
    const handle = await host(root, repo, slackEnvironment(fixture, {
      SMITHERS_ORGANIZATION_SCRIPTED_ROLES: JSON.stringify({ assistant: "question:lead", lead: "contract:builder,checker", builder: "build", checker: "check" })
    }))
    await handle.start()
    const peer = await fixture.nextPeer()
    peer.send({ type: "hello" })
    peer.send(dm("ask", "What is control evidence?"))
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-ask" })

    const [asked] = await (async () => {
      for (let i = 0; i < 100; i++) {
        const found = await intakes(handle)
        if (found.length > 0) return found
        await pause(200)
      }
      throw new Error("no intake")
    })()
    assert.equal((await settled(handle, asked.runId)).status, "completed", handle.output())
    const report = receipt(root, "slack:T1:Ev-ask").report
    assert.equal(report.status, "answered")
    assert.deepEqual(report.answer, { principal: "lead", text: scriptedAnswer })
    // One reply, from the lead, with the page and the issue as links.
    const reply = await call((each) => each.method === "chat.postMessage" && each.params.channel === DM)
    assert.equal(
      reply.params.text,
      `Control evidence is what a check records as proof. See <${WEB}/Org/Organization.md|Organization> and <https://github.com/example/demo/issues/1|#1>.`
    )
    assert.equal(reply.params.username, "Lead")
    assert.equal(reply.params.thread_ts, ASKED_TS)
    await call((each) => each.method === "reactions.add" && each.params.name === "white_check_mark")
    assert.deepEqual(posts().filter((each) => each.params.channel === DM).length, 1)
    assert.deepEqual(reactions().filter(([method]) => method === "reactions.add").map((entry) => entry[3]), ["eyes", "white_check_mark"])
    assert.deepEqual(unpushed, [])
    // No contract, no workspace, no branch.
    assert.deepEqual(branches(repo), [])
    assert.equal(report.rounds, 0)
    assert.equal(report.applied, undefined)
    await handle.stop()
  })

  it("acknowledges with \"On it.\" when the app cannot react", { timeout: 240_000 }, async () => {
    const repo = repository()
    const root = organization()
    const { fixture, call, reactions } = await slack({ reacts: false })
    const handle = await host(root, repo, slackEnvironment(fixture, {
      SMITHERS_ORGANIZATION_SCRIPTED_ROLES: JSON.stringify({ assistant: "answer" })
    }))
    await handle.start()
    const peer = await fixture.nextPeer()
    peer.send({ type: "hello" })
    peer.send(dm("plain", "What is control evidence?"))
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-plain" })
    const ack = await call((each) => each.method === "chat.postMessage" && each.params.text === "On it.")
    assert.equal(ack.params.thread_ts, ASKED_TS)
    assert.equal(ack.params.username, "Assistant")
    // The assistant answers the question itself; without the wiki's remote the page is named, unlinked.
    const reply = await call((each) => each.method === "chat.postMessage" && each.params.text !== "On it.")
    assert.equal(reply.params.text, "Control evidence is what a check records as proof. See Org/Organization.md and <https://github.com/example/demo/issues/1|#1>.")
    assert.equal(reply.params.username, "Assistant")
    // The 👀 was refused, and so is the attempt to take it off at the end.
    await call((each) => each.method === "reactions.remove")
    await pause(1_000)
    assert.deepEqual(reactions().map((entry) => [entry[0], entry[3]]), [["reactions.add", "eyes"], ["reactions.remove", "eyes"]])
    await handle.stop()
  })
})
