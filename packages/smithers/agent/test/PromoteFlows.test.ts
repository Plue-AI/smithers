/**
 * Turning the script the model just ran into a saved flow.
 *
 * The two bindings are one move split in half: `flows/show-script` hands the
 * model its own turn back together with the rules a saved flow has to follow,
 * and `flows/write-flow` writes the files that come back. These cases fix what
 * each half promises — the script is the turn's, the rules are the host's, an
 * unroutable id is refused before anything is written, and a registry that is
 * in context rescans so the new flow is callable on the next frame.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Capability from "@smthrs/capability/Capability"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellHistory from "@smthrs/harness/CellHistory"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type { HarnessError } from "@smthrs/harness/HarnessError"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as FlowStore from "../src/FlowStore.ts"
import * as PromoteFlows from "../src/PromoteFlows.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as Safety from "./Safety.ts"

const call = (flowName: string, input: unknown): Cell.Call =>
  new Cell.Call({
    flowName,
    input: input as typeof Schema.Json.Type,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 2,
      cell: "cell-digest",
      ordinal: 0,
      declaration: "declaration-digest",
      layers: []
    })
  })

const services = (
  history: CellHistory.Service,
  store: FlowStore.Service
): Context.Context<CellHistory.CellHistory | FlowStore.FlowStore> =>
  Context.add(Context.make(CellHistory.CellHistory, history), FlowStore.FlowStore, store)

/** Invokes one binding of a source the way the controller would. */
const invoke = (
  source: FlowBinding.Source,
  flowName: string,
  input: unknown
): Effect.Effect<Cell.CallResult, HarnessError> =>
  Effect.flatMap(source.bindings(), (bindings) => {
    const binding = bindings.find((candidate) => candidate.descriptor.name === flowName)
    return binding === undefined
      ? Effect.die(`no binding named ${flowName}`)
      : binding.run(call(flowName, input))
  })

const saved = (id: string) => ({
  id,
  description: `Digest the week's ${id}.`,
  flowSource: `export default Flow.make({ name: "${id}" })`,
  testSource: `it("runs ${id}", () => {})`,
  fixtureJson: `{ "calls": [] }`
})

const ran = (...sources: ReadonlyArray<string>): CellHistory.Service =>
  CellHistory.makeCells(sources.map((source, ordinal) => ({ ordinal, source })))

const writeFlowEnvelope = PromoteFlows.writeFlowCapabilities.map((pattern) =>
  Option.getOrThrow(Capability.parsePattern(pattern))
)

/** Runs a real agent whose first cell saves a flow and whose second calls it. */
const promoteAndCall = async (capabilityEnvelope: ReadonlyArray<Capability.CapabilityPattern>) => {
  let refreshes = 0
  let visibleReads = 0
  let calls = 0
  const written = new Map<string, string>()
  const descriptor = new Descriptor.FlowDescriptor({
    name: "weekly-digest",
    description: "The promoted weekly digest.",
    body: new Descriptor.BodyRefModule({ path: "/flows/weekly-digest/flow.ts" }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    modelInvocable: true,
    path: "/flows/weekly-digest",
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })
  const entries = () => refreshes > 0 ? [descriptor] : []
  const registry = Registry.makeNoop({
    list: () => Effect.sync(entries),
    visible: () =>
      Effect.sync(() => {
        visibleReads += 1
        return entries()
      }),
    getOption: (name) => Effect.sync(() => Option.fromUndefinedOr(entries().find((entry) => entry.name === name))),
    refresh: () =>
      Effect.sync(() => {
        refreshes += 1
      })
  })
  const source = PromoteFlows.source(
    Context.add(services(ran(), FlowStore.makeMemory(written)), Registry.Registry, registry)
  )
  const cells = [
    `await ctx.call("flows/write-flow", ${JSON.stringify(saved("weekly-digest"))}); console.log("saved")`,
    `const discovered = Object.keys(ctx.flows); const result = await ctx.call("weekly-digest", {}); ctx.done({ discovered, result })`
  ]
  const prompts: Array<string> = []
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const cell = cells[prompts.length]!
        prompts.push(request.system.map((part) => part.text).join("\n"))
        return Stream.make(
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        )
      })
  })
  const flow = Flow.make("agent/test/promotion", {
    payload: {},
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: () => Node.succeed(undefined)
  })
  const events: Array<AgentEvent.AgentEvent> = []
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const agent = yield* Agent.Agent
      yield* engine.register(flow, () =>
        agent.run({
          session: "promotion",
          seat: Seat.make({
            modelId: "test",
            id: "test",
            model,
            contextWindowTokens: 128000,
            route: {
              prepare: () =>
                Effect.succeed({
                  routeId: "test",
                  protocolId: "test",
                  method: "POST",
                  url: "https://example.invalid",
                  publicHeaders: {},
                  body: new TextEncoder().encode("{}"),
                  bodyText: "{}"
                })
            }
          }),
          prompt: "Save and call a weekly digest.",
          registry,
          flows: [source],
          maxFrames: 2,
          capabilityEnvelope,
          unmovedCap: 0,
          implementations: new Map([["weekly-digest", () =>
            Effect.sync(() => {
              calls += 1
              return new Cell.CallResult({ outcome: "success", value: "digest ready" })
            })]])
        }).pipe(Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event)
          })
        )))
      yield* engine.execute(flow, { executionId: "promotion", payload: {} })
    })).pipe(Effect.provide(
      Layer.mergeAll(
        Agent.layer,
        Agent.layerDefaults,
        scriptedCompletionJudge,
        FlowEngine.layerMemory,
        NodeCrypto.layer
      )
        .pipe(
          Layer.provideMerge(Safety.layer)
        )
    ))
  )

  return { refreshes, written, prompts, events, calls, visibleReads }
}

describe("PromoteFlows.source", () => {
  it("binds both halves of the move under one source name", async () => {
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory()))

    const bindings = await Effect.runPromise(source.bindings())

    expect(source.name).toBe("flows")
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual(["flows/show-script", "flows/write-flow"])
  })
})

describe("flows/show-script", () => {
  it("fills, discovers and executes its saved template without a host delegate", async () => {
    const source = PromoteFlows.source(services(ran("ctx.done('ready')"), FlowStore.makeMemory()))
    const shown = await Effect.runPromise(invoke(source, "flows/show-script", {}))
    expect(shown.outcome).toBe("success")
    const template = (shown.value as { template: string }).template
    const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
    const testDirectory = fileURLToPath(new URL(".", import.meta.url))

    await Effect.runPromise(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ directory: testDirectory, prefix: ".promotion-" })
      const flows = join(root, "flows")
      const example = join(flows, "example")
      yield* fs.makeDirectory(example, { recursive: true })
      yield* fs.writeFileString(join(example, "flow.ts"), template
        .replaceAll("<id>", "example")
        .replace("<one line naming what this flow produces>", "Returns the provided value."))

      const discovery = yield* Discovery.Discovery
      const found = yield* discovery.scan({ source: "project", root: flows, naming: "path" })
      expect(found.entries.map((entry) => entry.name)).toEqual(["example"])
      const executable = yield* Executable.fromDescriptor(found.entries[0]!, { delegates: [] })
      expect(executable.delegate).toBeUndefined()
      const result = yield* executable.flow.execute(
        { input: { value: "ready" } },
        { executionId: "promotion-example" }
      ).pipe(Effect.provide(
        Layer.mergeAll(Interpreter.layer(executable.flow), executable.layer).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      ))
      expect(result).toBe("ready")
    }).pipe(
      Effect.scoped,
      Effect.provide(Discovery.layer.pipe(Layer.provide(platform))),
      Effect.provide(platform)
    ) as Effect.Effect<void, unknown, never>)
  })

  it("hands back the source of every cell this turn ran, in order", async () => {
    const source = PromoteFlows.source(services(ran("ctx.done(1)", "ctx.done(2)"), FlowStore.makeMemory()))

    const result = await Effect.runPromise(invoke(source, "flows/show-script", {}))

    expect(result.outcome).toBe("success")
    expect(result.value).toMatchObject({
      cells: [{ ordinal: 0, source: "ctx.done(1)" }, { ordinal: 1, source: "ctx.done(2)" }],
      bestPractices: PromoteFlows.bestPractices,
      template: PromoteFlows.flowTemplate
    })
  })

  it("reports an empty script for a host that records nothing", async () => {
    const source = PromoteFlows.source(services(CellHistory.makeNoop(), FlowStore.makeMemory()))

    const result = await Effect.runPromise(invoke(source, "flows/show-script", {}))

    expect(result.value).toMatchObject({ cells: [] })
  })

  it("appends the caller's extra guidance after the house rules", async () => {
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory()))

    const result = await Effect.runPromise(
      invoke(source, "flows/show-script", { bestPractices: "Name the flow after the outcome." })
    )

    expect((result.value as { bestPractices: string }).bestPractices).toBe(
      `${PromoteFlows.bestPractices}\nName the flow after the outcome.`
    )
  })

  it("teaches the host's own rules and template when it has them", async () => {
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory()), {
      bestPractices: "One rule: the payload carries everything.",
      template: "export const Flow = defineFlow({})\n"
    })

    const result = await Effect.runPromise(invoke(source, "flows/show-script", {}))

    expect(result.value).toMatchObject({
      bestPractices: "One rule: the payload carries everything.",
      template: "export const Flow = defineFlow({})\n"
    })
  })
})

describe("flows/write-flow", () => {
  it("writes the flow, its test, and its fixture under the flow's id", async () => {
    const written = new Map<string, string>()
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory(written)))

    const result = await Effect.runPromise(invoke(source, "flows/write-flow", saved("weekly-digest")))

    expect(result.outcome).toBe("success")
    expect(result.value).toEqual({
      files: [
        "flows/weekly-digest/flow.ts",
        "flows/weekly-digest/flow.e2e.ts",
        "flows/weekly-digest/fixtures/weekly-digest.json"
      ]
    })
    expect(written.get("flows/weekly-digest/flow.e2e.ts")).toBe(`it("runs weekly-digest", () => {})`)
  })

  it("refuses an unroutable id as a correctable failure and writes nothing", async () => {
    const written = new Map<string, string>()
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory(written)))

    const result = await Effect.runPromise(
      invoke(source, "flows/write-flow", { ...saved("weekly-digest"), id: "Weekly Digest" })
    )

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("lowercase letters")
    expect(written.size).toBe(0)
  })

  it("reports a store that refuses the write rather than claiming a save", async () => {
    const source = PromoteFlows.source(services(ran(), FlowStore.makeNoop()))

    const result = await Effect.runPromise(invoke(source, "flows/write-flow", saved("weekly-digest")))

    expect(result.outcome).toBe("failure")
    expect(result.message).toContain("no flow was saved")
  })

  it("refreshes a registry that is in context so the flow is callable next frame", async () => {
    let refreshes = 0
    const registry = Registry.makeNoop({
      refresh: () =>
        Effect.sync(() => {
          refreshes += 1
        })
    })
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory()))

    const result = await Effect.runPromise(
      invoke(source, "flows/write-flow", saved("weekly-digest")).pipe(
        Effect.provideService(Registry.Registry, registry)
      )
    )

    expect(result.outcome).toBe("success")
    expect(refreshes).toBe(1)
  })

  it("discovers and calls the saved flow in the next real agent cell", async () => {
    const { calls, events, prompts, refreshes, visibleReads, written } = await promoteAndCall(writeFlowEnvelope)

    expect(refreshes).toBe(1)
    expect(written.size).toBe(3)
    expect(prompts).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain("unknown_flow")
    expect(calls).toBe(1)
    const completion = [...events].reverse().find((event) => event._tag === "cell-settled")
    expect(completion).toMatchObject({
      outcome: { transition: { output: expect.stringContaining("\"weekly-digest\"") } }
    })
    expect(completion).toMatchObject({ outcome: { transition: { output: expect.stringContaining("digest ready") } } })
    expect(prompts[0]).not.toContain("The promoted weekly digest.")
    expect(prompts[1]).toContain("The promoted weekly digest.")
    expect(visibleReads).toBe(2)
  })

  it("refuses to save a flow when the run's envelope grants no flow writes", async () => {
    const { events, refreshes, written } = await promoteAndCall([])

    expect(written.size).toBe(0)
    expect(refreshes).toBe(0)
    expect(JSON.stringify(events)).toContain(
      "Flow flows/write-flow needs fs:write:/flows/**, which is outside this run's capability envelope."
    )
  })

  it("declares the flow-file write it performs", () => {
    expect(PromoteFlows.writeFlowFlow.capabilities).toStrictEqual(["fs:write:/flows/**"])
  })

  it("does not refresh a registry when the write was refused", async () => {
    let refreshes = 0
    const registry = Registry.makeNoop({
      refresh: () =>
        Effect.sync(() => {
          refreshes += 1
        })
    })
    const source = PromoteFlows.source(services(ran(), FlowStore.makeNoop()))

    await Effect.runPromise(
      invoke(source, "flows/write-flow", saved("weekly-digest")).pipe(
        Effect.provideService(Registry.Registry, registry)
      )
    )

    expect(refreshes).toBe(0)
  })

  it("saves without a registry in context", async () => {
    const written = new Map<string, string>()
    const source = PromoteFlows.source(services(ran(), FlowStore.makeMemory(written)))

    const result = await Effect.runPromise(invoke(source, "flows/write-flow", saved("weekly-digest")))

    expect(result.outcome).toBe("success")
    expect(written.size).toBe(3)
  })
})
