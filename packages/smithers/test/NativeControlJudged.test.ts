/**
 * Every Jev gate on the executor `smithers run` ships, under
 * `ScriptedJudge.layerAll`.
 *
 * The host is `NodeControl.layerExecutor` with a real stdio MCP server as
 * the one source a person added, an Undici mock for the provider and the
 * offline judge for every classifier, so nothing leaves the process. A
 * markdown run arms judged, pins every standard flow and withholds the MCP
 * flow its task never names. A module run's `AgentAction` step reads
 * relevance on its own prompt, under its own session, and keeps that flow.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Flow, Interpreter } from "@smthrs/flow"
import * as Monitor from "@smthrs/harness/Monitor"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as CoreFlow from "../flows/core/src/Flow.ts"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const roots = new Set<string>()
const agents = new Set<MockAgent>()

afterEach(async () => {
  await Promise.all([...agents].map((agent) => agent.close()))
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })))
  agents.clear()
  roots.clear()
})

/** A real MCP server over stdio offering one tool, `ping`: `initialize` and `tools/list` only. */
const server = [
  "process.stdin.setEncoding('utf8')",
  "let buf = ''",
  "process.stdin.on('data', (chunk) => {",
  "  buf += chunk",
  "  let idx",
  "  while ((idx = buf.indexOf('\\n')) !== -1) {",
  "    const line = buf.slice(0, idx)",
  "    buf = buf.slice(idx + 1)",
  "    if (!line.trim()) continue",
  "    let msg",
  "    try { msg = JSON.parse(line) } catch { continue }",
  "    if (msg.id === undefined) continue",
  "    let result",
  "    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '0' } }",
  "    else if (msg.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Replies pong', inputSchema: { type: 'object' } }] }",
  "    else continue",
  "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')",
  "  }",
  "})"
].join("\n")

const mcpFlow = "mcp/ping/ping"

/** One OpenAI Responses stream whose only output is `text`. */
const sse = (text: string): string =>
  [
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: text })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1" })}`,
    "",
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_judged", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
      })
    }`,
    "",
    ""
  ].join("\n")

/** The subagent step: its prompt names the MCP flow, so its own reading keeps it. */
const Pinger = AgentAction.make("test/Pinger", {
  payload: { flow: Schema.String },
  output: Schema.Struct({ pong: Schema.Boolean }),
  seat: "openai:gpt-4o-mini",
  prompt: ({ flow }) => `Call ${flow} once and report whether it replies pong.`
})

const Probe = Flow.make("test/Probe", {
  payload: Executable.Invocation,
  success: Schema.Struct({ pong: Schema.Boolean }),
  error: AgentAction.AgentFailure,
  body: () => Pinger.call({ flow: mcpFlow })
})

const probe = {
  name: "probe",
  description: "Asks a subagent to ping.",
  input: Schema.Struct({}),
  output: Schema.Unknown,
  capabilities: [],
  flows: ["test/Probe"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

/** The module entry the catalog discovers; the host registers its delegate. */
const probeSource = `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default Flow.make({
  name: "probe",
  description: ${JSON.stringify(probe.description)},
  input: Schema.Struct({}), output: Schema.Unknown,
  capabilities: [], flows: ["test/Probe"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
`

/** A project with a markdown flow whose task never names the MCP flow, and the module flow. */
const project = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-native-judged-")))
  roots.add(root)
  await mkdir(join(root, "flows", "survey"), { recursive: true })
  await writeFile(
    join(root, "flows", "survey", "flow.mdx"),
    [
      "---",
      "name: survey",
      "description: Summarizes the repository layout.",
      "model: openai:gpt-4o-mini",
      "---",
      "",
      "Summarize the repository layout.",
      ""
    ].join("\n")
  )
  await mkdir(join(root, "flows", "probe"), { recursive: true })
  await writeFile(join(root, "flows", "probe", "flow.ts"), probeSource)
  return root
}

/** A `control.agent.*` event of the watched run, or a subagent's, as its kind and payload. */
interface Journaled {
  readonly kind: string
  readonly payload: Record<string, unknown>
  /** The subagent step that published it; absent for the run's own. */
  readonly step?: { readonly action: string; readonly executionId: string; readonly scope: string } | undefined
}

/**
 * The shipped executor over `root`: plans, approves and runs each flow in
 * `flowIds` in turn, and answers every run's watched events and the subagent
 * steps its execution journal holds.
 */
const runAll = async (root: string, flowIds: ReadonlyArray<string>) => {
  const agent = new MockAgent()
  agents.add(agent)
  agent.disableNetConnect()
  agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
    200,
    () => sse("```cell\nctx.done(JSON.stringify({ pong: true }))\n```"),
    { headers: { "content-type": "text/event-stream" } }
  ).persist()
  const client = await Effect.runPromise(
    NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
  )
  const modules = Executable.layer({
    delegates: [Probe],
    load: () => Effect.succeed({ default: CoreFlow.make(probe) })
  }).pipe(Layer.provideMerge(Layer.mergeAll(Interpreter.layer(Probe), Pinger.layer)), Layer.orDie)
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const runs = NodeControl.layerExecutor(registry, engine, root, {
    evaluator: ScriptedJudge.layerAll,
    environment: { OPENAI_API_KEY: "test-key", SMITHERS_SUPERVISOR_STANCE: "paranoid" },
    grants: GrantStore.layerNoop,
    requestExecutor: Layer.effect(RequestExecutor.RequestExecutor)(
      RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
    ),
    mcpServers: [{ server: "ping", command: process.execPath, args: ["-e", server] }],
    modules
  })
  const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
  const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])
  const watched = await Effect.runPromise(
    Effect.forEach(flowIds, (flowId) =>
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({ flowId, input: {} })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `native-judged:${flowId}`
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        const events = yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
          Stream.takeUntil((event) => terminal.has(event.kind)),
          Stream.runCollect
        )
        return [...events].map((event): Journaled => ({
          kind: event.kind,
          payload: event.payload as Record<string, unknown>
        }))
      })).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
  )
  // A subagent step publishes through the execution journal's step facts.
  const database = new DatabaseSync(NodeControl.executionDatabasePath(root), { readOnly: true })
  try {
    const steps = database.prepare(
      "SELECT payload_json FROM flows_journal_events WHERE event_type = 'flows.harness.step-fact.v1' ORDER BY rowid"
    ).all().map((row): Journaled => {
      const fact = JSON.parse((row as { readonly payload_json: string }).payload_json) as {
        readonly eventType: string
        readonly payload: Record<string, unknown>
        readonly step: Journaled["step"]
      }
      return { kind: fact.eventType, payload: fact.payload, step: fact.step }
    })
    return { watched, steps }
  } finally {
    database.close()
  }
}

const first = (events: ReadonlyArray<Journaled>, kind: string) => events.find((event) => event.kind === kind)

describe("the shipped Node executor under ScriptedJudge.layerAll", () => {
  it("forwards workspace AGENTS.md into the relevance gate", async () => {
    const root = await project()
    await writeFile(
      join(root, "AGENTS.md"),
      "- Keep failing tests visible.\n\n- Publish benchmark claims with artifacts.\n"
    )
    const { watched } = await runAll(root, ["survey"])
    const events = watched[0]!
    expect(events.at(-1)?.kind).toBe("control.run.completed")
    const settled = first(events, "control.agent.relevance-settled")!.payload as {
      readonly kept: ReadonlyArray<{ readonly id: string; readonly kind: string }>
      readonly withheld: ReadonlyArray<{ readonly id: string; readonly kind: string }>
    }
    expect([...settled.kept, ...settled.withheld].filter((item) => item.kind === "instruction").length).toBeGreaterThan(
      0
    )
    expect(settled.withheld.some((item) => item.id.includes("AGENTS.md"))).toBe(true)
    const prompts = events.filter((event) => event.kind === "control.agent.model-requested")
    expect(prompts.length).toBeGreaterThan(0)
    expect(JSON.stringify(prompts)).toContain("Keep failing tests visible")
    expect(JSON.stringify(prompts)).not.toContain("Publish benchmark claims with artifacts")
  }, 60_000)
  it("arms a judged run, and a subagent step reads relevance on its own prompt under its own session", async () => {
    const { steps, watched } = await runAll(await project(), ["survey", "probe"])
    const [survey, probed] = watched
    expect(survey!.at(-1)?.kind).toBe("control.run.completed")
    expect(probed!.at(-1)?.kind).toBe("control.run.completed")

    // The run arms judged, with every standard flow pinned, the default monitors and the operator's stance.
    const armed = first(survey!, "control.agent.discipline-armed")!.payload
    expect(armed).toMatchObject({ judged: true, stance: "paranoid" })
    expect((armed["monitors"] as ReadonlyArray<{ readonly id: string }>).map((monitor) => monitor.id)).toEqual(
      Monitor.defaults().map((monitor) => monitor.id)
    )
    const relevance = armed["relevance"] as { readonly pinned: ReadonlyArray<string>; readonly withholdAt: number }
    expect(relevance.withholdAt).toBe(0.9)
    expect(relevance.pinned).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "apply_patch",
        "ls",
        "glob",
        "grep",
        "bash",
        "remember",
        "recall",
        "jev",
        "wait",
        "ask"
      ])
    )
    expect(relevance.pinned).not.toContain(mcpFlow)

    // Only the MCP flow and the project's own flows are judged; the MCP flow the task never names is withheld.
    type Verdict = { readonly id: string }
    const settled = first(survey!, "control.agent.relevance-settled")!.payload as {
      readonly scope: string
      readonly source: string
      readonly kept: ReadonlyArray<Verdict>
      readonly withheld: ReadonlyArray<Verdict>
    }
    expect(settled.source).toBe("run")
    expect(settled.withheld.map((item) => item.id)).toContain(mcpFlow)
    expect([...settled.kept, ...settled.withheld].map((item) => item.id).sort()).toEqual([mcpFlow, "probe", "survey"])

    // The subagent arms on its own session and gates on its own prompt, which names the MCP flow.
    const subagent = steps.filter((event) => event.step?.action === "test/Pinger")
    const scope = subagent[0]!.step!.scope
    expect(scope.startsWith(`${subagent[0]!.step!.executionId}/test/Pinger@`)).toBe(true)
    expect(scope).not.toBe(settled.scope)
    expect(first(subagent, "control.agent.discipline-armed")!.payload).toMatchObject({
      judged: true,
      stance: "paranoid"
    })
    const own = first(subagent, "control.agent.relevance-settled")!.payload as typeof settled
    expect(own).toMatchObject({ scope, source: "run" })
    expect(own.kept.map((item) => item.id)).toContain(mcpFlow)
    expect(own.withheld.map((item) => item.id)).not.toContain(mcpFlow)
  }, 60_000)
})
