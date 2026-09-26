/**
 * The organization host's one Slack app, end to end against the Slack
 * fixture server (`@smthrs/integrations`' test fixture: the Web API over
 * HTTP and Socket Mode over a real WebSocket): the owner's direct message
 * starts a delivery, the assistant acknowledges it in the thread ("On it."),
 * the Approval gate before the landing is asked in the thread with buttons, a
 * stranger's press changes nothing, the owner's press lands the change, and
 * the thread ends with one line: the outcome, the branch, and the receipt.
 * Nothing else is posted in the owner's thread: the contract and the
 * checker's verdict are in the receipt. Slack's redelivery of the same event
 * joins the run it started.
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
  receipt,
  repository,
  settled,
  unbootable
} from "../organization/testing/harness.mjs"

const DM = "D0OWNER1"
const ASKED_TS = "1700000000.000100"
const missing = unbootable()

let fixture
after(async () => {
  await cleanup()
  await fixture?.close()
})

/** Waits for the first Web API call matching `match`. */
const call = async (match, timeoutMs = 240_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = fixture.calls.find(match)
    if (found !== undefined) return found
    await pause(200)
  }
  throw new Error(`no Slack call matched; calls: ${JSON.stringify(fixture.calls.map((each) => [each.method, each.params.text]))}`)
}

const posts = () => fixture.calls.filter((each) => each.method === "chat.postMessage")

describe("the organization host's Slack app", { skip: missing === undefined ? false : `skipped: ${missing}` }, () => {
  it("delivers an owner's DM through an approval asked with buttons in its thread", { timeout: 420_000 }, async () => {
    let posted = 0
    fixture = await startSlackFixture((request, response) => {
      switch (request.method) {
        case "apps.connections.open":
          return ok(response, { url: fixture.socketUrl() })
        case "chat.postMessage":
          return ok(response, { channel: request.params.channel, ts: `1700000100.${String(++posted).padStart(6, "0")}` })
        case "chat.getPermalink":
          return ok(response, { permalink: "https://example.slack.com/archives/D0OWNER1/p1" })
        case "chat.update":
          return ok(response, { channel: request.params.channel, ts: request.params.ts })
        default:
          return refuse(response, "unknown_method")
      }
    })
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
    const handle = await host(root, repo, {
      SMITHERS_SLACK_BOT_TOKEN: "xoxb-fixture",
      SMITHERS_SLACK_APP_TOKEN: "xapp-fixture",
      SMITHERS_SLACK_API_BASE_URL: fixture.apiBaseUrl,
      SMITHERS_SLACK_TEAM_IDS: "T1",
      SMITHERS_SLACK_USER_IDS: "UOWNER",
      SMITHERS_ORGANIZATION_SLACK_FIXTURE: "1"
    })
    await handle.start()
    const peer = await fixture.nextPeer()
    peer.send({ type: "hello" })

    const message = {
      envelope_id: "e-dm",
      type: "events_api",
      payload: {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev-dm",
        authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
        event: { type: "message", channel: DM, channel_type: "im", user: "UOWNER", text: "Add a line to README.md", ts: ASKED_TS }
      }
    }
    peer.send(message)
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-dm" })

    // The assistant acknowledges in the thread, under its persona.
    const ack = await call((each) => each.method === "chat.postMessage" && each.params.text === "On it.")
    assert.equal(ack.authorization, "Bearer xoxb-fixture")
    assert.equal(ack.params.channel, DM)
    assert.equal(ack.params.thread_ts, ASKED_TS)
    assert.equal(ack.params.username, "Assistant")

    // The gate is asked in the thread with the owner's buttons.
    const prompt = await call((each) => each.method === "chat.postMessage" && each.params.text?.startsWith("Land this change?"))
    assert.equal(prompt.params.thread_ts, ASKED_TS)
    const buttons = JSON.parse(prompt.params.blocks).find((block) => block.type === "actions").elements
    const approve = buttons.find((button) => button.action_id.endsWith(":a"))
    assert.ok(approve, prompt.params.blocks)

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
        container: { channel_id: DM, message_ts: "1700000100.000003", thread_ts: ASKED_TS },
        trigger_id: trigger,
        actions: [{ action_id: approve.action_id, value: "approve" }]
      }
    })
    // A stranger's press is dropped at the door; the gate stays open.
    peer.send(press("USTRANGER", "t-1"))
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-press-t-1" })
    await pause(3_000)
    const [waiting] = (await handle.ops.runs()).filter((view) => view.flowId === "organization/intake")
    assert.equal(waiting.status, "waiting-approval")
    assert.equal(fixture.calls.some((each) => each.method === "chat.update"), false)

    // The owner's press answers the gate and updates the prompt.
    peer.send(press("UOWNER", "t-2"))
    assert.deepEqual(JSON.parse(await peer.next()), { envelope_id: "e-press-t-2" })
    const update = await call((each) => each.method === "chat.update")
    assert.equal(update.params.text, "Approved by <@UOWNER>: land.")
    assert.equal((await settled(handle, waiting.runId)).status, "completed", handle.output())

    const report = receipt(root, "slack:T1:Ev-dm").report
    assert.equal(report.status, "landed")
    // The thread ends with one line: the outcome, the branch, and the receipt.
    const result = await call((each) => each.method === "chat.postMessage" && each.params.text?.startsWith("Landed on "))
    assert.equal(
      result.params.text,
      `Landed on ${report.applied.branch} ${report.applied.commit.slice(0, 12)} · Org/Runs/slack-T1-Ev-dm/deliver.json`
    )
    assert.equal(result.params.username, "Assistant")
    assert.equal(result.params.thread_ts, ASKED_TS)
    // Nothing else reached the owner's thread: no contract, no verdict.
    assert.deepEqual(
      posts().filter((each) => each.params.channel === DM).map((each) => each.params.text.split("\n")[0]),
      ["On it.", "Land this change?", result.params.text]
    )
    assert.equal(git(repo, "show", `${report.applied.branch}:README.md`), `# Demo\n${line}`)
    assert.deepEqual(branches(repo), [report.applied.branch])
    assert.equal(git(repo, "rev-parse", "main"), main)
    assert.equal((await handle.ops.runs()).filter((view) => view.flowId === "organization/intake").length, 1)
    assert.equal(posts().filter((each) => each.params.text === "On it.").length, 1)
    await handle.stop()
  })
})
