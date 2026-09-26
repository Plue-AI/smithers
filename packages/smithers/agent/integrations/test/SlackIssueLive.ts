/** Explicit opt-in live test runner invoked by backend TestIssueSlackLive. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Fiber, Layer } from "effect"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import * as Actions from "../src/slack/Actions.ts"
import * as Connections from "../src/slack/Connections.ts"
import * as IssueSync from "../src/slack/IssueSync.ts"
import * as SocketSource from "../src/slack/SocketSource.ts"

if (process.env["SMITHERS_SLACK_LIVE"] !== "1") throw new Error("Explicit live opt-in required")
const env: Record<string, string> = {}
for (const line of readFileSync(process.env["SMITHERS_SLACK_ENV_FILE"]!, "utf8").split("\n")) {
  const match = /^(SMITHERS_SLACK_(?:BOT|APP)_TOKEN)=(.*)$/.exec(line)
  if (match) env[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "").trim()
}
const channel = process.env["SMITHERS_SLACK_LIVE_CHANNEL"]!
const team = process.env["SMITHERS_SLACK_LIVE_TEAM"]!
const human = process.env["SMITHERS_SLACK_LIVE_USER"]!
const policy = { allowedTeamIds: [team], allowedChannelIds: [channel], allowedUserIds: [human] }
const connection = Connections.fromEnvironment({ containers: [channel] }, env)
const executor = async (flow: any, payload: any, executionId: string): Promise<any> => {
  const layer = Layer.mergeAll(Actions.layer, Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, Connections.layer([connection]), NodeCrypto.layer))
  )
  return Effect.runPromise(flow.execute(payload, { executionId }).pipe(Effect.provide(layer), Effect.scoped))
}
const execute: IssueSync.Executor = {
  post: (p, id) => executor(IssueSync.Post, p, id),
  update: (p, id) => executor(IssueSync.Update, p, id),
  delete: (p, id) => executor(IssueSync.Delete, p, id),
  react: (p, id) => executor(IssueSync.React, p, id),
  reconcile: (p, id) => executor(IssueSync.Reconcile, p, id)
}
const origin = process.env["ISSUE_TEST_URL"]!
const request = (path: string, init?: RequestInit) => fetch(origin + path, init)
const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
  const r = await request(`/api/repos/sync_test/sync-test/issues${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  })
  if (!r.ok) throw new Error(`Product HTTP ${method} ${path} = ${r.status}: ${await r.text()}`)
  return r.status === 204 ? undefined : r.json()
}
const options = {
  connectionId: connection.connection.id,
  policy,
  owner: "sync_test",
  repo: "sync-test",
  request,
  execute
}
let bridge = IssueSync.make(options)
if (process.argv.includes("--restart-check")) {
  const resent = await bridge.drain()
  if (resent !== 0) throw new Error("A fresh process repeated a settled delivery")
  console.log("Fresh process: zero repeated deliveries")
  process.exit(0)
}
const issue = await api("", "POST", { title: "sync test", kind: "chat" })
const mapping = {
  connection_id: connection.connection.id,
  team_id: team,
  channel_id: channel,
  ...(process.env["SMITHERS_SLACK_LIVE_THREAD_TS"] ? { thread_ts: process.env["SMITHERS_SLACK_LIVE_THREAD_TS"] } : {})
}
await api(`/${issue.number}/slack`, "PUT", mapping)
await api("/slack/channels", "PUT", { ...mapping, slack_user_id: human })
await api(`/${issue.number}/comments`, "POST", { body: "sync test", idempotency_key: "live-root" })
if (await bridge.drain() !== 1) throw new Error("Initial message did not settle")
const mapped = await api(`/${issue.number}/slack`)
if (!mapped.thread_ts) throw new Error("No real Slack root receipt")
const thread = mapped.thread_ts
const summary: Record<string, unknown> = {
  thread,
  channel,
  issue: issue.number,
  url: `https://app.slack.com/client/${team}/${channel}/thread/${channel}-${thread}`,
  appToSlack: true
}
writeFileSync("/tmp/smithers-chat-live-evidence.json", JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary))
const seen: string[] = []
const source = SocketSource.make({ policy, client: connection.client })
const fiber = Effect.runFork(source.run((events) =>
  Effect.tryPromise(async () => {
    for (const event of events) {
      const raw: any = event.payload
      const inner = raw.event?.message ?? raw.event?.previous_message ?? raw.event
      if (inner?.thread_ts !== thread && inner?.ts !== thread) continue
      await bridge.ingest(raw)
      seen.push(raw.event?.subtype ?? raw.event?.type)
      console.log(`Human ingress committed: ${seen.at(-1)}`)
      summary["humanEvents"] = seen
      writeFileSync("/tmp/smithers-chat-live-evidence.json", JSON.stringify(summary, null, 2))
    }
  })
))
try {
  const reply = await api(`/${issue.number}/comments`, "POST", {
    body: "sync test reply",
    idempotency_key: "live-reply"
  })
  if (await bridge.drain() !== 1) throw new Error("Delivery did not settle")
  const comments = await api(`/${issue.number}/comments`)
  const beforeRestart = comments.length
  bridge = IssueSync.make(options)
  const resent = await bridge.drain()
  if (resent !== 0) throw new Error("Restart repeated a delivery")
  const restarted = spawnSync(process.execPath, [import.meta.filename, "--restart-check"], {
    env: process.env,
    encoding: "utf8"
  })
  if (restarted.status !== 0) throw new Error(`Restart check failed: ${restarted.stderr}`)
  summary["restartWithoutDuplicates"] = true
  summary["freshProcessRestart"] = restarted.stdout.trim()
  await api(`/comments/${reply.id}`, "PATCH", { body: "sync test edited" })
  if (await bridge.drain() !== 1) throw new Error("Delivery did not settle")
  const afterEdit = await Effect.runPromise(connection.client.call("conversations.replies", { channel, ts: thread }))
  if (!Array.isArray(afterEdit["messages"]) || !afterEdit["messages"].some((m: any) => m.text === "sync test edited")) {
    throw new Error("Slack edit was not observed")
  }
  summary["edit"] = true
  await api(`/comments/${reply.id}`, "DELETE")
  if (await bridge.drain() !== 1) throw new Error("Delivery did not settle")
  const afterDelete = await Effect.runPromise(connection.client.call("conversations.replies", { channel, ts: thread }))
  if (
    !Array.isArray(afterDelete["messages"]) || afterDelete["messages"].some((m: any) => m.text === "sync test edited")
  ) throw new Error("Slack deletion was not observed")
  summary["delete"] = true
  const persona = await api(`/${issue.number}/comments`, "POST", {
    body: "sync test persona",
    idempotency_key: "live-persona",
    persona: { username: "Sync Test", iconEmoji: ":test_tube:" }
  })
  if (await bridge.drain() !== 1) throw new Error("Delivery did not settle")
  const remote = await Effect.runPromise(
    connection.client.call("conversations.replies", { channel, ts: thread, include_all_metadata: true })
  )
  if (
    !Array.isArray(remote["messages"]) ||
    !remote["messages"].some((m: any) => m.text === "sync test persona" && m.username === "Sync Test")
  ) throw new Error("Persona was not observed")
  summary["persona"] = true
  await api(`/${issue.number}/comments/${persona.id}/reactions`, "PUT", { name: "eyes", active: true })
  if (await bridge.drain() !== 1) throw new Error("Reaction did not settle")
  const reactionState = (await api(`/${issue.number}/slack`)).state
  summary["reaction"] = reactionState === "unsupported" ? "unsupported: missing reactions:write" : "applied"
  if (reactionState !== "unsupported") {
    await api(`/${issue.number}/comments/${persona.id}/reactions`, "PUT", { name: "eyes", active: false })
    if (await bridge.drain() !== 1) throw new Error("Reaction removal did not settle")
  }
  summary["remoteMessages"] = Array.isArray(remote["messages"])
    ? remote["messages"].map((m: any) => ({ ts: m.ts, text: m.text, username: m.username }))
    : []
  summary["noEcho"] = (await api(`/${issue.number}/comments`)).length === beforeRestart
  if (summary["noEcho"] !== true) throw new Error("Unexpected comments after bot writes")
  writeFileSync("/tmp/smithers-chat-live-evidence.json", JSON.stringify(summary, null, 2))
  console.log(
    "Outbound, edit, delete, persona, restart and no-echo receipts captured. Awaiting human test-thread reply/edit/delete."
  )
  const deadline = Date.now() + Number(process.env["SMITHERS_SLACK_LIVE_WAIT_MS"] ?? 480_000)
  while (
    Date.now() < deadline &&
    !(seen.includes("message") && seen.includes("message_changed") && seen.includes("message_deleted"))
  ) await new Promise((r) => setTimeout(r, 1000))
  summary["humanIngressComplete"] = seen.includes("message") && seen.includes("message_changed") &&
    seen.includes("message_deleted")
  summary["comments"] = await api(`/${issue.number}/comments`)
  writeFileSync("/tmp/smithers-chat-live-evidence.json", JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
  if (summary["humanIngressComplete"] !== true && process.env["SMITHERS_SLACK_LIVE_HUMAN_REQUIRED"] !== "0") {
    throw new Error("Human Slack reply/edit/delete evidence is incomplete")
  }
} finally {
  await Effect.runPromise(Fiber.interrupt(fiber))
}
