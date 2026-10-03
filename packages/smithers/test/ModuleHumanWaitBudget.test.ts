/**
 * A native module run's human wait is not task time, across a restart.
 *
 * The host is `NodeControl.layerExecutor` with a registered module whose flow
 * makes an `AgentAction` step, asks a person through `HumanTask`, and then
 * makes a second step. Nothing parks a harness at the question: the native
 * execution suspends on its own wait. The latency allowance is 12 s with
 * `onExceeded: fail`. Composition A runs until the question is open and
 * closes. After a wait longer than the whole allowance, composition B opens
 * the same root and answers.
 *
 * The second step's admission must see only the time the run spent
 * executing, so the run completes (#2120). A budget that charged the wait
 * refuses that step with `BudgetExceeded` and fails the run.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Flow, HumanTask, Interpreter } from "@smthrs/flow"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schedule, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const allowanceMillis = 12_000
const betweenProcessesMillis = 13_000

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
        response: { id: "resp_module_wait", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
      })
    }`,
    "",
    ""
  ].join("\n")

const Step = AgentAction.make("test/WaitStep", {
  payload: { n: Schema.Number },
  output: Schema.Struct({ n: Schema.Number }),
  seat: "openai:gpt-4o-mini",
  prompt: ({ n }) => `Report step ${n}.`
})

const question = "Which service owns the retry budget?"

const Steps = Flow.make("test/WaitSteps", {
  payload: Executable.Invocation,
  success: Schema.Struct({ n: Schema.Number }),
  error: Schema.Union([AgentAction.AgentFailure, HumanTask.HumanTaskFailed]),
  body: () =>
    Step.call({ n: 1 }).pipe(
      Node.andThen(HumanTask.action.call({ name: "clarify", kind: "ask", prompt: question, maxAttempts: 1 })),
      Node.andThen(Step.call({ n: 2 }))
    )
})

const definition = {
  name: "steps",
  description: "Makes a model-backed step, asks a person, and makes another.",
  input: Schema.Struct({}),
  output: Schema.Unknown,
  capabilities: [],
  flows: ["test/WaitSteps"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

const source = `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default ({
  name: "steps",
  description: ${JSON.stringify(definition.description)},
  input: Schema.Struct({}), output: Schema.Unknown,
  capabilities: [], flows: ["test/WaitSteps"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
`

/** The task line one provider request carries, from its raw body. */
const task = (body: string): string | undefined => /Report step \d\./.exec(body)?.[0]

const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])

/** One process's production executor over `root`, answering the provider from `bodies`. */
const composition = async (root: string, agent: MockAgent) => {
  const client = await Effect.runPromise(
    NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
  )
  const modules = Executable.layer({
    delegates: [Steps],
    load: () => Effect.succeed({ default: definition })
  }).pipe(
    Layer.provideMerge(Layer.mergeAll(Interpreter.layer(Steps), Step.layer, HumanTask.layer)),
    Layer.orDie
  )
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const runs = NodeControl.layerExecutor(registry, engine, root, {
    evaluator: ScriptedJudge.layerAll,
    environment: { OPENAI_API_KEY: "test-key" },
    grants: GrantStore.layerNoop,
    requestExecutor: Layer.effect(RequestExecutor.RequestExecutor)(
      RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
    ),
    modules
  })
  return Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
}

const summary = (runId: string) =>
  Effect.flatMap(Control.Control, (control) =>
    Effect.map(
      control.list({ _tag: "runs", filters: { runId } }),
      (page) => (page._tag === "runs" ? page.items[0] : undefined)
    ))

describe("a module run's native human wait", () => {
  it("is not charged to the task allowance across a restart", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-module-wait-budget-")))
    const agent = new MockAgent()
    try {
      await mkdir(join(root, "flows", "steps"), { recursive: true })
      await writeFile(join(root, "flows", "steps", "flow.ts"), source)
      const bodies: Array<string> = []
      agent.disableNetConnect()
      agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
        200,
        (options) => {
          bodies.push(new TextDecoder().decode(options.body as Uint8Array))
          return sse(`\`\`\`cell\nctx.done(JSON.stringify({ n: ${bodies.length} }))\n\`\`\``)
        },
        { headers: { "content-type": "text/event-stream" } }
      ).persist()

      // Composition A: runs the first step and parks on the question.
      const first = await composition(root, agent)
      const parked = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({
            flowId: "steps",
            input: {},
            budget: { milliseconds: allowanceMillis, onExceeded: "fail" }
          })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "module-wait-budget"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
            return yield* Effect.die("expected an accepted run")
          }
          const runId = receipt.runId
          const run = yield* summary(runId).pipe(
            Effect.flatMap((run) => run?.status === "waiting-approval" ? Effect.succeed(run) : Effect.fail(run)),
            Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 1_500 }),
            Effect.orDie
          )
          return { runId, run }
        }).pipe(Effect.provide(first), Effect.scoped, Effect.orDie)
      )

      expect(bodies.map(task).filter((line) => line !== undefined).at(-1)).toBe("Report step 1.")
      const callsWhileParked = bodies.length

      // The wait alone outlasts the whole allowance.
      await new Promise((resolve) => setTimeout(resolve, betweenProcessesMillis))

      // Composition B: answers the question and follows the run to its end.
      const second = await composition(root, agent)
      const settled = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          yield* control.signal({
            runId: parked.runId,
            signal: { name: "clarify", payload: "the scheduler owns it" },
            idempotencyKey: `signal:${parked.runId}`
          })
          const events = yield* control.watch({ runId: parked.runId, follow: true }).pipe(
            Stream.filter((event) => terminal.has(event.kind)),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("60 seconds")
          )
          return { kind: events[0]?.kind, run: yield* summary(parked.runId) }
        }).pipe(Effect.provide(second), Effect.scoped, Effect.orDie)
      )

      expect(settled.kind).toBe("control.run.completed")
      expect(settled.run?.status).toBe("completed")
      // The first step replayed; only the second reached the provider again.
      expect(bodies.slice(callsWhileParked).map(task)).not.toContain("Report step 1.")
      expect(bodies.slice(callsWhileParked).map(task)).toContain("Report step 2.")
    } finally {
      await agent.close()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  }, 120_000)
})
