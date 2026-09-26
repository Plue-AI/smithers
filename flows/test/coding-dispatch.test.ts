import { NodeServices } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Graph } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Effect, Layer, Schema, Stream } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { conversation, DispatchInput, dispatchModels, seatFor } from "../coding/dispatch.ts"
import Dispatch, { dispatchRegistration } from "../coding/dispatch/flow.ts"
import { roleResolver } from "../coding/host.ts"
import { NativeCoding } from "../coding/native.ts"

const changeId = "k".repeat(32)
const commitId = "a".repeat(40)
const treeId = "b".repeat(40)
const operationId = "c".repeat(128)
const head = {
  kind: "resolved" as const,
  changeId,
  commitId,
  treeId,
  operationId,
  parentCommitIds: ["d".repeat(40)]
}

/** The workspace adapter a dispatched turn reads after it answers. */
const nativeStub = (reads: Array<number>) =>
  Layer.succeed(
    NativeCoding,
    NativeCoding.of({
      sourcePublication: "local-only",
      read: () =>
        Effect.sync(() => {
          reads.push(1)
          return {
            status: "read" as const,
            operationId,
            head,
            revisions: [head],
            capabilities: ["apply-files/v1", "import-source/v1"]
          }
        }),
      apply: () => Effect.die("a dispatch fixture applies no native operation"),
      publishOriginalSource: () => Effect.die("a dispatch fixture publishes no source")
    })
  )

/** A real cell loop; only the provider stream and the seat table are scripted. */
const scripted = (options: {
  readonly seats: Array<string>
  readonly prompts: Array<string>
  readonly answer: ReadonlyArray<string>
}) => {
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        options.prompts.push([
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
          )
        ].join("\n"))
        return Stream.fromIterable([
          ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell",
            text: `\`\`\`cell\nctx.done(${JSON.stringify({ messages: options.answer })})\n\`\`\``
          }),
          ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
  const base = SeatResolver.make({
    resolve: (id: string) => {
      // Recorded here as well as at the declared id, so a test can tell the
      // requested seat apart from the model the role table mapped it onto.
      options.seats.push(id)
      return Effect.succeed(Seat.make({
        id,
        modelId: id,
        model,
        contextWindowTokens: 200_000,
        route: {
          prepare: () =>
            Effect.succeed({
              routeId: "dispatch-test",
              protocolId: "dispatch-test",
              method: "POST" as const,
              url: "https://example.invalid",
              publicHeaders: {},
              body: new TextEncoder().encode("{}"),
              bodyText: "{}"
            })
        }
      }))
    }
  })
  // The host's own role table, so the test resolves a role exactly as a served
  // host does: a request's explicit model bypasses it, a role goes through it.
  const roles = roleResolver(base, "test:implementation-model")
  return SeatResolver.layer({
    resolve: (id: string) => {
      options.seats.push(id)
      return roles.resolve(id)
    }
  })
}

const agentHost = Layer.effect(
  AgentAction.Host,
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return {
      registry,
      limits: { memoryBytes: 128 * 1024 * 1024, steps: 25_000_000, calls: 8 },
      capabilityEnvelope: [],
      maxFrames: 6
    }
  })
).pipe(Layer.provide(Registry.layerFromDescriptors([])), Layer.provide(NodeServices.layer))

/** The offline dispatch host judges recorded completion evidence. */
const confidentEvaluator = ScriptedJudge.layer

const runTurn = async (
  t: TestContext,
  input: typeof DispatchInput.Type,
  options: { readonly answer?: ReadonlyArray<string> } = {}
) => {
  const root = await mkdtemp(join(tmpdir(), "coding-dispatch-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seats: Array<string> = []
  const prompts: Array<string> = []
  const reads: Array<number> = []
  const registration = Layer.mergeAll(
    dispatchRegistration(),
    dispatchModels
  ).pipe(
    Layer.provideMerge(nativeStub(reads)),
    Layer.provideMerge(
      Layer.mergeAll(
        agentHost,
        scripted({ seats, prompts, answer: options.answer ?? ["Read the greeting.", "Done."] }),
        Agent.layer
      )
    ),
    Layer.provideMerge(
      Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layer({ tokens: { max: 250_000, onExceeded: "fail" } }))
    ),
    Layer.provideMerge(Agent.layerDefaults),
    Layer.provideMerge(confidentEvaluator),
    Layer.provideMerge(Action.layerImplementations)
  )
  const host = NodeRuntime.layerHost(
    { filename: join(root, "engine.db"), workspaceRoot: root, owner: { hostId: "coding-dispatch-test" }, signals: [] },
    registration
  )
  const exit = await Effect.runPromiseExit(
    Effect.scoped(Dispatch.execute(input, { executionId: `dispatch-${input.turnId}` }).pipe(Effect.provide(host)))
  )
  if (exit._tag === "Failure") t.diagnostic(Cause.pretty(exit.cause))
  return { exit, seats, prompts, reads }
}

const baseInput = {
  turnId: "turn-1",
  prompt: "Explain what greeting.mjs exports.",
  history: [
    { role: "user" as const, content: "Where does the greeting live?" },
    { role: "assistant" as const, content: "In greeting.mjs." }
  ],
  role: "coding/dispatch"
}

test("a dispatched turn declares one seat per request and carries the caller's window into the prompt", () => {
  assert.equal(
    seatFor({ ...baseInput, model: "anthropic:claude-x" } as typeof DispatchInput.Type),
    "anthropic:claude-x"
  )
  assert.equal(seatFor(baseInput as typeof DispatchInput.Type), "coding/dispatch")
  const rendered = conversation(baseInput as typeof DispatchInput.Type)
  assert.match(rendered, /# Conversation so far/)
  assert.match(rendered, /<user>\nWhere does the greeting live\?\n<\/user>/)
  assert.match(rendered, /<assistant>\nIn greeting\.mjs\.\n<\/assistant>/)
  assert.match(rendered, /# This turn\nExplain what greeting\.mjs exports\./)
  // A first turn has no window and must not announce an empty conversation.
  assert.equal(
    conversation({ ...baseInput, history: [] } as typeof DispatchInput.Type),
    "# This turn\nExplain what greeting.mjs exports."
  )
})

test("the caller's window is bounded at the schema, not at the prompt", () => {
  const decode = Schema.decodeUnknownOption(DispatchInput)
  const message = { role: "user", content: "hello" }
  assert.equal(decode({ ...baseInput, history: Array.from({ length: 200 }, () => message) })._tag, "Some")
  assert.equal(decode({ ...baseInput, history: Array.from({ length: 201 }, () => message) })._tag, "None")
  assert.equal(decode({ ...baseInput, model: "not a model" })._tag, "None")
  assert.equal(decode({ ...baseInput, prompt: "" })._tag, "None")
})

test("the dispatched turn is one model call: no plan, no checks, no second loop", () => {
  const calls = [...Graph.nodes(Graph.build(Dispatch, baseInput as typeof DispatchInput.Type))]
    .filter((node) => node.kind === "ActionCall")
    .map((node) => (node.ast as { action: string }).action)
  assert.deepEqual(calls, ["coding/dispatch-turn", "coding/observe-dispatch"])
})

test("a real cell loop answers one turn on the request's own model and reports the workspace it leaves", {
  timeout: 60_000
}, async (t) => {
  const { exit, prompts, reads, seats } = await runTurn(
    t,
    { ...baseInput, model: "test:requested-model" } as typeof DispatchInput.Type
  )
  assert.equal(exit._tag, "Success", JSON.stringify(exit))
  const result = (exit as Extract<typeof exit, { _tag: "Success" }>).value
  assert.deepEqual(result.messages, [
    { ordinal: 0, role: "assistant", content: "Read the greeting." },
    { ordinal: 1, role: "assistant", content: "Done." }
  ])
  assert.equal(result.turnId, "turn-1")
  assert.equal(result.seat, "test:requested-model")
  // The run id is the handle a remote caller hands to /projections.
  assert.equal(result.runId, "dispatch-turn-1")
  assert.equal(result.head?.commitId, commitId)
  assert.deepEqual(result.revisions.map((revision) => revision.changeId), [changeId])
  assert.equal(reads.length, 1)
  // The declared seat is the request's model, not the host's launch role.
  assert.ok(seats.includes("test:requested-model"), seats.join(","))
  assert.ok(!seats.includes("coding/dispatch"), seats.join(","))
  assert.ok(
    prompts.some((prompt) => prompt.includes("Where does the greeting live?")),
    "the window must reach the model"
  )
})

test("a turn that names only a role resolves through the host's role table", { timeout: 60_000 }, async (t) => {
  const { exit, seats } = await runTurn(t, baseInput as typeof DispatchInput.Type)
  assert.equal(exit._tag, "Success", JSON.stringify(exit))
  assert.equal((exit as Extract<typeof exit, { _tag: "Success" }>).value.seat, "coding/dispatch")
  assert.ok(seats.includes("coding/dispatch"), seats.join(","))
  // roleResolver maps the role onto the host's configured implementation model.
  assert.ok(seats.includes("test:implementation-model"), seats.join(","))
})
