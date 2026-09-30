/**
 * An approved module AgentAction's tool calls run on the native host's picked
 * tool services under the owning run's authority (#2930): `read`, `bash` and
 * `jev` answer inside the approved envelope, and a flow outside it is refused.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Flow } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const effects = { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" } as const
const Answer = AgentAction.make("tools/Answer", {
  payload: {},
  output: Schema.Struct({ accepted: Schema.Boolean }),
  seat: "openai:gpt-4o-mini",
  prompt: () => "Use the tools, then accept.",
  corrections: 0
})
const sse = (text: string) =>
  [
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "answer", delta: text })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "answer" })}`,
    "",
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: { id: "tools-answer", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      })
    }`,
    "",
    ""
  ].join("\n")
const cell = (source: string) => `\`\`\`cell\n${source}\n\`\`\``
const probe = (label: string, expression: string) =>
  [
    "try {",
    `  const value = await ${expression}`,
    `  console.log("${label}-OK " + JSON.stringify(value))`,
    "} catch (error) {",
    `  console.log("${label}-REFUSED " + String(error))`,
    "}"
  ].join("\n")

describe("module AgentAction tool services", () => {
  it("serves read, bash and jev under the approved envelope", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-module-tools-")))
    const agent = new MockAgent()
    const bodies: Array<string> = []
    try {
      await mkdir(join(root, "flows", "tools"), { recursive: true })
      await mkdir(join(root, "allowed"))
      await writeFile(join(root, "allowed", "note.txt"), "approved-note\n")
      const capabilities = ["fs:read:/**", "proc:spawn:*", "model:call:*"]
      await writeFile(
        join(root, "flows", "tools", "flow.ts"),
        `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("tools", {
  description: "Use host tools from a module action.", payload: {}, success: Schema.Unknown,
  capabilities: ${JSON.stringify(capabilities)},
  effects: ${JSON.stringify(effects)},
  body: Node.capture({}, () => Node.succeed(null))
})
`
      )
      agent.disableNetConnect()
      agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
        200,
        (request) => {
          bodies.push(new TextDecoder().decode(request.body as Uint8Array))
          return bodies.length === 1
            ? sse(cell([
              probe("READ", `ctx.call("read", { path: ${JSON.stringify(join(root, "allowed", "note.txt"))} })`),
              probe(
                "WRITE",
                `ctx.call("write", { path: ${JSON.stringify(join(root, "allowed", "new.txt"))}, content: "x" })`
              ),
              probe("BASH", `ctx.call("bash", { command: "echo bash-ran" })`),
              probe(
                "JEV",
                `ctx.call("jev", { state: { context: { task: "tools" }, items: [{ kind: "memory", id: "m", text: "tools" }] }, questions: { unnecessary_0: { type: "boolean", instructions: "Is item 0 unnecessary?" } } })`
              )
            ].join("\n")))
            : sse(cell("ctx.done(JSON.stringify({accepted:true}))"))
        },
        { headers: { "content-type": "text/event-stream" } }
      ).persist()
      const client = await Effect.runPromise(
        NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
      )
      const Main = Flow.make("tools", {
        description: "Use host tools from a module action.",
        capabilities,
        effects,
        payload: {},
        success: Schema.Struct({ accepted: Schema.Boolean }),
        error: Schema.Union([HarnessError, AgentAction.AgentFailure]),
        body: Node.capture({}, () => Answer.call({}))
      })
      const modules = Executable.layer({
        delegates: [],
        load: () => Effect.succeed({ default: Main, layer: Answer.layer })
      }).pipe(Layer.orDie)
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const executor = NodeControl.layerExecutor(registry, engine, root, {
        evaluator: ScriptedJudge.layerAll,
        environment: { OPENAI_API_KEY: "fixture" },
        grants: GrantStore.layerNoop,
        requestExecutor: Layer.effect(RequestExecutor.RequestExecutor)(
          RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
        ),
        modules
      })
      const kind = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "tools", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "module-tools"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die(receipt)
          const events = yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
            Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
            Stream.runCollect,
            Effect.timeout("30 seconds")
          )
          return events.at(-1)?.kind
        }).pipe(
          Effect.provide(Application.layer({ root }, registry, engine, executor) as Layer.Layer<Control.Control>),
          Effect.scoped
        )
      )
      expect(kind).toBe("control.run.completed")
      const observed = bodies[1] ?? ""
      const printed = JSON.parse(observed).input.flatMap((item: { content: ReadonlyArray<{ text: string }> }) =>
        item.content.map((part) => part.text)
      ).find((text: string) => text.includes("What your cell printed:")) as string
      const line = (label: string) => printed.split("\n").find((text) => text.startsWith(`${label}-OK `)) ?? ""
      expect(line("READ")).toContain("approved-note")
      expect(line("READ")).not.toContain("\"ok\":false")
      expect(line("BASH")).toContain("bash-ran")
      expect(line("JEV")).toContain("\"answers\"")
      expect(line("JEV")).not.toContain("\"ok\":false")
      expect(line("WRITE")).toContain("capability_refused")
    } finally {
      await agent.close()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  }, 60_000)
})
