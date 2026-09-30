/** Approved authority follows module handoffs and detached child executions. */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Capability from "@smthrs/capability/Capability"
import { Control } from "@smthrs/control"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Steering from "@smthrs/harness/Steering"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Exit, Layer, Option, Schedule, Schema, Stream } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import { ModuleOwner } from "../src/internal/ModuleOwner.ts"
import * as NodeControl from "../src/NodeControl.ts"

const effects = { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" } as const
const Answer = AgentAction.make("authority/Answer", {
  payload: {},
  output: Schema.Struct({ accepted: Schema.Boolean }),
  seat: "openai:gpt-4o-mini",
  prompt: () => "Accept the approved run.",
  corrections: 0
})
const Probe = Action.make("authority/Probe", { payload: {}, success: Schema.Boolean, error: HarnessError })
const Launch = Action.make("authority/Launch", {
  payload: {},
  success: Schema.Struct({ accepted: Schema.Boolean }),
  error: Schema.Union([HarnessError, AgentAction.AgentFailure])
})
const Finish = Action.make("authority/Finish", { payload: {}, success: Schema.Struct({ accepted: Schema.Boolean }) })
const Child = Flow.make("authority/child", {
  payload: {},
  success: Schema.Struct({ accepted: Schema.Boolean }),
  error: Schema.Union([HarnessError, AgentAction.AgentFailure]),
  body: Node.capture({}, () => Probe.call({}).pipe(Node.andThen(Answer.call({})), Node.andThen(Finish.call({}))))
})
const source = (capabilities: ReadonlyArray<string>) => `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("authority", {
  description: "Run an approved module round.", payload: {}, success: Schema.Unknown,
  capabilities: ${
  JSON.stringify(capabilities)
}, effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  body: Node.capture({}, () => Node.succeed(null))
})
`
const sse = [
  `data: ${
    JSON.stringify({
      type: "response.output_text.delta",
      item_id: "answer",
      delta: "```cell\nctx.done(JSON.stringify({accepted:true}))\n```"
    })
  }`,
  "",
  `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "answer" })}`,
  "",
  `data: ${
    JSON.stringify({
      type: "response.completed",
      response: { id: "authority-answer", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    })
  }`,
  "",
  ""
].join("\n")

describe("module round execution authority", () => {
  it.each(
    [
      { mode: "handoff", capabilities: [] },
      { mode: "ensure", capabilities: [] },
      { mode: "handoff", capabilities: ["fs:read:allowed"] },
      { mode: "ensure", capabilities: ["fs:read:allowed"] }
    ] as const
  )("owns steering, host and budget across $mode ($capabilities)", async ({ mode, capabilities }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-module-authority-")))
    const agent = new MockAgent()
    const observed: Array<
      {
        rootId: string
        flowId: string
        capabilities: ReadonlyArray<string> | undefined
        budget: string
        sameBudget: boolean
        tokens: number
        outsideAllowed: boolean
      }
    > = []
    const accounting: Array<{ stage: string; tokens: number; decision?: string }> = []
    let requests = 0
    try {
      await mkdir(join(root, "flows", "authority"), { recursive: true })
      await writeFile(join(root, "flows", "authority", "flow.ts"), source(capabilities))
      agent.disableNetConnect()
      agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(200, () => {
        requests++
        return sse
      }, { headers: { "content-type": "text/event-stream" } }).persist()
      const client = await Effect.runPromise(
        NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
      )
      const probe = Layer.unwrap(
        Effect.map(Budget.Budget, (constructionBudget) =>
          Probe.toLayer(() =>
            Effect.gen(function*() {
              const steering = yield* Steering.Source
              yield* steering.read()
              const outsideAllowed = CapabilitySet.allows(
                yield* CapabilitySet.current,
                Capability.make("fs:read", "outside")
              )
              const owner = yield* ModuleOwner
              const host = yield* AgentAction.Host
              const budget = yield* Budget.Budget
              yield* budget.record("probe", { totalTokens: 3 }).pipe(Effect.orDie)
              observed.push({
                ...owner,
                capabilities: host.capabilityEnvelope?.map(Capability.format),
                budget: (yield* budget.check("probe").pipe(Effect.orDie))._tag,
                sameBudget: budget === constructionBudget,
                tokens: (yield* budget.usage.pipe(Effect.orDie)).tokens,
                outsideAllowed
              })
              return true
            })
          ))
      )
      const finish = Finish.toLayer(() =>
        Effect.gen(function*() {
          const budget = yield* Budget.Budget
          accounting.push({ stage: "provider", tokens: (yield* budget.usage.pipe(Effect.orDie)).tokens })
          yield* budget.record("ceiling", { totalTokens: 50 }).pipe(Effect.orDie)
          accounting.push({
            stage: "ceiling",
            tokens: (yield* budget.usage.pipe(Effect.orDie)).tokens,
            decision: (yield* budget.check("after-ceiling").pipe(Effect.orDie))._tag
          })
          return { accepted: true }
        })
      )
      const launch = Launch.toLayer(() =>
        Effect.gen(function*() {
          const budget = yield* Budget.Budget
          yield* budget.record("launch", { totalTokens: 5 }).pipe(Effect.orDie)
          const id = yield* Child.ensure({}, { key: "approved-child" }).pipe(Effect.orDie)
          const result = yield* Child.poll(id).pipe(
            Effect.flatMap((result) =>
              Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail("pending" as const)
            ),
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 2_000 }),
            Effect.orDie
          )
          if (result._tag !== "Complete" || !Exit.isSuccess(result.exit)) return yield* Effect.die(result)
          accounting.push({ stage: "parent-after-child", tokens: (yield* budget.usage.pipe(Effect.orDie)).tokens })
          return result.exit.value
        })
      )
      const Round = Flow.make("authority/round", {
        payload: {},
        success: Schema.Struct({ accepted: Schema.Boolean }),
        error: Schema.Union([HarnessError, AgentAction.AgentFailure]),
        body: Node.capture(
          { mode },
          (): Node.Node<
            { readonly accepted: boolean },
            HarnessError | AgentAction.AgentFailure,
            Action.Requirement<"authority/Probe" | "authority/Answer" | "authority/Launch" | "authority/Finish">
          > =>
            mode === "handoff"
              ? Probe.call({}).pipe(Node.andThen(Answer.call({})), Node.andThen(Finish.call({})))
              : Launch.call({})
        )
      })
      const Main = Flow.make("authority", {
        description: "Run an approved module round.",
        capabilities,
        effects,
        payload: {},
        success: Schema.Struct({ accepted: Schema.Boolean }),
        error: Schema.Union([HarnessError, AgentAction.AgentFailure]),
        body: Node.capture({}, () => Round.to({}))
      })
      const modules = Executable.layer({
        delegates: [],
        load: () =>
          Effect.succeed({
            default: Main,
            layer: Layer.mergeAll(
              Interpreter.layer(Round),
              Interpreter.layer(Child),
              probe,
              launch,
              finish,
              Answer.layer
            )
          })
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
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({
            flowId: "authority",
            input: {},
            budget: { tokens: 50, onExceeded: "fail" }
          })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: mode
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die(receipt)
          const events = yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
            Stream.takeUntil((event) => event.kind === "control.run.completed" || event.kind === "control.run.failed"),
            Stream.runCollect,
            Effect.timeout("30 seconds")
          )
          return { runId: receipt.runId, kind: events.at(-1)?.kind }
        }).pipe(
          Effect.provide(Application.layer({ root }, registry, engine, executor) as Layer.Layer<Control.Control>),
          Effect.scoped
        )
      )
      expect(result.kind).toBe("control.run.completed")
      expect(observed).toEqual([{
        rootId: result.runId,
        flowId: "authority",
        capabilities,
        budget: "proceed",
        sameBudget: false,
        tokens: mode === "ensure" ? 8 : 3,
        outsideAllowed: false
      }])
      expect(accounting).toEqual([
        { stage: "provider", tokens: mode === "ensure" ? 10 : 5 },
        { stage: "ceiling", tokens: mode === "ensure" ? 60 : 55, decision: "refuse" },
        ...(mode === "ensure" ? [{ stage: "parent-after-child", tokens: 60 }] : [])
      ])
      // An answer on an unchanged workspace completes without a second request (#2937).
      expect(requests).toBe(1)
    } finally {
      await agent.close()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  }, 60_000)
})
