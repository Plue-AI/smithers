/**
 * A native module run parks on its `park` budget like a prompt run does.
 *
 * The host is `NodeControl.layerExecutor` with a registered module whose flow
 * makes two `AgentAction` steps, an Undici mock for the provider and the
 * offline judge, so nothing leaves the process. The ceiling is the planner's,
 * as `flow start --budget-*` sets it: 50 tokens with `onExceeded: park`. Every
 * provider call costs 20 tokens and a step answers in two frames under the
 * judged completion brake, so the first step spends 40 and the second step's
 * first call is projected at 40 + 20 and parks the run for an operator's
 * raise (#2739).
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlSchema } from "@smthrs/control"
import { Flow, Interpreter } from "@smthrs/flow"
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
import * as CoreFlow from "../flows/core/src/Flow.ts"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

/** One OpenAI Responses stream whose only output is `text`, reporting 20 tokens spent. */
const sse = (text: string): string =>
  [
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: text })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1" })}`,
    "",
    `data: ${
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_module_budget", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
      })
    }`,
    "",
    ""
  ].join("\n")

const Step = AgentAction.make("test/Step", {
  payload: { n: Schema.Number },
  output: Schema.Struct({ n: Schema.Number }),
  seat: "openai:gpt-4o-mini",
  prompt: ({ n }) => `Report step ${n}.`
})

const Steps = Flow.make("test/Steps", {
  payload: Executable.Invocation,
  success: Schema.Struct({ n: Schema.Number }),
  error: AgentAction.AgentFailure,
  body: () => Step.call({ n: 1 }).pipe(Node.andThen(Step.call({ n: 2 })))
})

const definition = {
  name: "steps",
  description: "Makes two model-backed steps.",
  input: Schema.Struct({}),
  output: Schema.Unknown,
  capabilities: [],
  flows: ["test/Steps"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
} as const

const source = `
import * as Flow from "@smthrs/core/Flow"
import { Schema } from "effect"
export default Flow.make({
  name: "steps",
  description: ${JSON.stringify(definition.description)},
  input: Schema.Struct({}), output: Schema.Unknown,
  capabilities: [], flows: ["test/Steps"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
`

/** The task line one provider request carries, from its raw body. */
const task = (body: string): string | undefined => /Report step \d\./.exec(body)?.[0]

/**
 * Runs `steps` until it parks, answers the park with `decision`, and follows
 * the run until it settles or asks again.
 */
const parkedModuleRun = async (
  decision: "approve" | "deny",
  ceiling: { readonly budget: ControlSchema.Envelope["budget"]; readonly delayMs: number } = {
    budget: { tokens: 50, onExceeded: "park" },
    delayMs: 0
  }
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-module-budget-park-")))
  const agent = new MockAgent()
  try {
    await mkdir(join(root, "flows", "steps"), { recursive: true })
    await writeFile(join(root, "flows", "steps", "flow.ts"), source)
    const bodies: Array<string> = []
    agent.disableNetConnect()
    const reply = agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
      200,
      (options) => {
        // Undici hands the mock the encoded body; its text is the request.
        bodies.push(new TextDecoder().decode(options.body as Uint8Array))
        return sse(`\`\`\`cell\nctx.done(JSON.stringify({ n: ${bodies.length} }))\n\`\`\``)
      },
      { headers: { "content-type": "text/event-stream" } }
    )
    // Undici refuses a zero delay, so only a slow provider sets one.
    if (ceiling.delayMs > 0) reply.delay(ceiling.delayMs)
    reply.persist()
    const client = await Effect.runPromise(
      NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
    )
    const modules = Executable.layer({
      delegates: [Steps],
      load: () => Effect.succeed({ default: CoreFlow.make(definition) })
    }).pipe(Layer.provideMerge(Layer.mergeAll(Interpreter.layer(Steps), Step.layer)), Layer.orDie)
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
    const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({
          flowId: "steps",
          input: {},
          budget: ceiling.budget
        })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "module-budget-park"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        const runId = receipt.runId
        const summary = Effect.map(
          control.list({ _tag: "runs", filters: { runId } }),
          (page) => (page._tag === "runs" ? page.items[0] : undefined)
        )
        const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])
        const first = yield* control.watch({ runId, follow: true }).pipe(
          Stream.takeUntil((event) => terminal.has(event.kind) || event.kind === "control.approval.requested"),
          Stream.runCollect,
          Effect.timeout("30 seconds")
        )
        const requested = [...first].at(-1)!
        if (requested.kind !== "control.approval.requested") {
          return { first: requested.kind, bodies: bodies.length }
        }
        const parked = yield* summary.pipe(
          Effect.flatMap((run) => run?.status === "parked" ? Effect.succeed(run) : Effect.fail(run)),
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
          Effect.orDie
        )
        const callsWhileParked = bodies.length
        const stepsWhileParked = bodies.map(task)
        const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(
          (requested.payload as { readonly payload: unknown }).payload
        )
        yield* decision === "approve" ? control.approve(approval) : control.deny(approval)
        const events = yield* control.watch({ runId, follow: true, afterSequence: requested.sequence }).pipe(
          Stream.takeUntil((event) => terminal.has(event.kind) || event.kind === "control.approval.requested"),
          Stream.runCollect,
          Effect.timeout("30 seconds")
        )
        return {
          first: requested.kind,
          parked,
          callsWhileParked,
          stepsWhileParked,
          approval,
          last: [...events].at(-1)?.kind,
          settled: yield* summary,
          bodies: bodies.length
        }
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
    )
    return { ...observed, prompts: bodies }
  } finally {
    await agent.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

describe("a module run's parked budget", () => {
  it("parks with a budget approval request and completes after approve without replaying paid work", async () => {
    const observed = await parkedModuleRun("approve")

    // The second step parked the run instead of failing it with BudgetExceeded.
    expect(observed.first).toBe("control.approval.requested")
    expect(observed.parked).toMatchObject({ status: "parked", waitingReason: "budget" })
    expect(observed.stepsWhileParked).toEqual(["Report step 1.", "Report step 1."])
    // Spent 40, next 20, plus one more 50-token allowance.
    expect(observed.approval?.target.envelope.budget).toEqual({ tokens: 110, onExceeded: "park" })
    // The approved raise reached the resumed module handlers, and the first
    // step replayed from its journal rather than calling the provider again.
    expect(observed.last).toBe("control.run.completed")
    expect(observed.settled?.status).toBe("completed")
    expect(observed.prompts.slice(observed.callsWhileParked).map(task)).toEqual(["Report step 2.", "Report step 2."])
    expect(new Set(observed.prompts).size).toBe(observed.prompts.length)
  }, 60_000)

  it("fails the run when the raise is denied, without calling the provider again", async () => {
    const observed = await parkedModuleRun("deny")

    expect(observed.first).toBe("control.approval.requested")
    expect(observed.last).toBe("control.run.failed")
    expect(observed.settled?.status).toBe("failed")
    expect(observed.prompts).toHaveLength(observed.callsWhileParked!)
  }, 60_000)

  it("fails the run when a latency raise is denied instead of asking again on resume", async () => {
    // The first response takes 150 ms against a 100 ms ceiling, so the next
    // call parks. The elapsed time keeps growing while parked, and the denial
    // must still answer the request it was made on (#2739).
    const observed = await parkedModuleRun("deny", {
      budget: { milliseconds: 100, onExceeded: "park" },
      delayMs: 150
    })

    expect(observed.first).toBe("control.approval.requested")
    expect(observed.parked).toMatchObject({ status: "parked", waitingReason: "budget" })
    expect(observed.stepsWhileParked).toEqual(["Report step 1."])
    // No replacement request: the run settled on the denial.
    expect(observed.last).toBe("control.run.failed")
    expect(observed.settled?.status).toBe("failed")
    expect(observed.prompts).toHaveLength(observed.callsWhileParked!)
  }, 60_000)
})
