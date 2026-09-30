/**
 * The run-start relevance reading: a judged run's frame 0 withholds the
 * catalog flows, instruction chunks and opening memory rows Jev is confident
 * the task does not need, a call restores a withheld flow, and a replay is
 * served the record.
 */
import { ModelRequest } from "@smthrs/model"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Descriptor } from "@smthrs/registry"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as EngineLike from "../src/EngineLike.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Relevance from "../src/Relevance.ts"
import * as Steering from "../src/Steering.ts"
import { descriptor, emits, of, pattern, run } from "./fixtures/cellTurn.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const read = descriptor("read", { capabilities: ["fs:read:**"] })
const search = descriptor("mcp.search")
const review = new Descriptor.FlowDescriptor({
  ...descriptor("review"),
  body: new Descriptor.BodyRefMarkdown({ path: "/flows/review/flow.mdx", baseDirectory: "/flows/review" })
})
const catalog = [read, search, review]

const agents: Relevance.Document = {
  path: "AGENTS.md",
  text: "- Run the parser tests with pnpm test.\n- Deploy only from the release branch.\n- Keep commits small.\n"
}
const instructions = [agents]

/** Jev withholds `mcp.search` and the deploy chunk, and keeps the rest. */
const withholding: Readonly<Record<string, number>> = { "mcp.search": 0.95, "AGENTS.md#1": 0.93 }

/**
 * A scripted Jev: each `unnecessary_*` item at the probability `ps` gives its
 * id, and a completion that stands. `asked` counts the relevance requests.
 */
const jev = (ps: (id: string) => number) => {
  const asked: Array<ReadonlyArray<Relevance.Item>> = []
  const tasks: Array<string> = []
  const layer = Evaluator.layerScripted((request) => {
    const ids = Object.keys(request.questions)
    if (!ids.some((id) => id.startsWith("unnecessary_"))) {
      return {
        complete: { probability: 0.99 },
        overclaims: { probability: 0.01 },
        invented: { probability: 0.01 },
        requiresWorkspaceChange: { probability: 0.5 },
        reportsLimitation: { probability: 0 }
      }
    }
    const { context, items } = request.state as {
      readonly context: Relevance.Context
      readonly items: ReadonlyArray<Relevance.Item>
    }
    asked.push(items)
    tasks.push(context.task)
    return Object.fromEntries(items.map((item, index) => [`unnecessary_${index}`, { probability: ps(item.id) }]))
  })
  return { asked, tasks, layer }
}

const judging = () => jev((id) => withholding[id] ?? 0.2)

const rows: ReadonlyArray<CellTurn.MemoryRow> = [
  { key: "note-1", text: "use pnpm" },
  { key: "deploy", text: "deploy from the release branch" },
  { key: "parser", text: "the parser lives in src/parse" }
]

/** A host's render: one fenced line per row. */
const render = (kept: ReadonlyArray<CellTurn.MemoryRow>): string =>
  kept.length === 0
    ? ""
    : `<flows_memory_context>\n${kept.map((row) => `[${row.key}] ${row.text}`).join("\n")}\n</flows_memory_context>`

const memory: CellTurn.Memory = { rows, digest: "memory-digest", render }

const opening = (
  flows: ReadonlyArray<Descriptor.FlowDescriptor>,
  remembered?: CellTurn.Memory,
  documents: ReadonlyArray<Relevance.Document> = instructions
): ContextWindow.ContextWindow =>
  CellTurn.teach(
    ContextWindow.make({
      modelId: "test-model",
      segments: [
        { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "host safety rules" })] },
        CellTurn.instructionsSegment(documents, new Set()),
        ...(remembered === undefined
          ? []
          : [CellTurn.memorySegment(remembered.render(remembered.rows), remembered.digest)]),
        {
          kind: "instructions",
          zone: "prefix",
          content: [ModelRequest.SystemPart.make({ text: "The task for this run:\n\nFix the parser." })]
        },
        { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("Begin.")] }
      ]
    }),
    flows
  )

const state = (
  overrides: {
    readonly frame?: number
    readonly flows?: ReadonlyArray<Descriptor.FlowDescriptor>
    readonly memory?: CellTurn.Memory
    readonly instructions?: ReadonlyArray<Relevance.Document>
  } = {}
) =>
  CellTurn.make({
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: [pattern("fs:read:**")],
    placement: Option.none(),
    contextWindow: opening(overrides.flows ?? catalog, overrides.memory, overrides.instructions),
    frame: overrides.frame ?? 0,
    maxFrames: 4,
    contextWindowTokens: 0
  })

const key = (boundary: EngineLike.RecordBoundary<unknown>): string =>
  `${boundary.name}\u0000${
    boundary.identity.session ?? ""
  }\u0000${boundary.identity.frame}\u0000${boundary.identity.boundary}`

/** A scripted engine whose recorded boundaries persist, encoded, in `records`. */
const journaled = (
  fixture: ScriptedEngine.Fixture,
  records: Map<string, unknown>
): Layer.Layer<EngineLike.EngineLike> =>
  EngineLike.layer(
    EngineLike.make({
      ...fixture.engine,
      record: (boundary) => {
        const held = records.get(key(boundary))
        if (held !== undefined) {
          return Effect.fromResult(Schema.decodeUnknownResult(boundary.success)(held)).pipe(
            Effect.mapError((cause) =>
              new HarnessError({ code: "engine_failed", message: `Boundary ${boundary.name} did not decode`, cause })
            )
          )
        }
        const encode = Schema.encodeUnknownSync(
          boundary.success as unknown as Schema.Schema<unknown> & { readonly "EncodingServices": never }
        )
        return boundary.execute.pipe(
          Effect.tap((value) => Effect.sync(() => records.set(key(boundary), encode(value))))
        )
      }
    })
  )

/** Runs the controller over a catalog refreshed every frame. */
const refreshed = async (options: {
  readonly script: ScriptedModel.Script
  readonly evaluator: Layer.Layer<Evaluator.Evaluator>
  readonly records?: Map<string, unknown>
  readonly calls?: ReadonlyArray<ScriptedEngine.CallStep>
  readonly memory?: CellTurn.Memory
  readonly instructions?: ReadonlyArray<Relevance.Document>
}) => {
  const model = ScriptedModel.make(options.script)
  const engine = ScriptedEngine.make(model.model, options.calls ?? [])
  const events: Array<AgentEvent.AgentEvent> = []
  const outcome = await CellTurn.run({
    state: state({
      flows: [],
      ...(options.memory === undefined ? {} : { memory: options.memory }),
      ...(options.instructions === undefined ? {} : { instructions: options.instructions })
    }),
    flows: [],
    refreshFlows: Effect.succeed(catalog),
    judged: true,
    instructions: options.instructions ?? instructions,
    pinned: ["read"],
    memory: options.memory
  }).pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.provide(journaled(engine, options.records ?? new Map())),
    Effect.provide(QuickJSSandbox.layer),
    Effect.provide(Steering.layerNoop()),
    Effect.provide(options.evaluator),
    Effect.exit,
    Effect.runPromise
  )
  return { events, model, engine, failed: outcome._tag === "Failure" }
}

const systemText = (request: ModelRequest.ModelRequest | undefined): string =>
  (request?.system ?? []).map((part) => part.text).join("\n")

const catalogText = (request: ModelRequest.ModelRequest | undefined): string =>
  (request?.system ?? []).map((part) => part.text).filter((text) => text.startsWith("Flows callable with ctx.call"))
    .join("\n")

const resolved = (events: ReadonlyArray<AgentEvent.AgentEvent>): unknown => {
  const part = of(events, "resolved")[0]?.message.content[0]
  return JSON.parse(part?.type === "text" ? part.text : "null")
}

const gate = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  events.filter((event) =>
    event._tag === "discipline-armed" || event._tag === "relevance-settled" ||
    (event._tag === "decision-settled" && event.classifier === "relevance/unnecessary")
  ).map((event) => event._tag)

describe("the run-start relevance reading", () => {
  it("withholds what Jev is confident of from the frame-0 request and keeps the recorded catalog whole", async () => {
    const judge = judging()
    const records = new Map<string, unknown>()
    const { events, failed, model } = await refreshed({
      script: [emits(`ctx.done("done")`)],
      evaluator: judge.layer,
      records
    })
    expect(failed).toBe(false)
    const request = model.recorder.requests[0]
    expect(catalogText(request)).not.toContain("mcp.search")
    expect(catalogText(request)).toContain("review")
    const system = systemText(request)
    expect(system).toContain("Run the parser tests")
    expect(system).not.toContain("Deploy only from the release branch")
    expect(system).toContain("Keep commits small")
    expect(system.indexOf("host safety rules")).toBeLessThan(system.indexOf("Run the parser tests"))

    const recordedCatalog = [...records].find(([name]) => name.startsWith("flow-catalog\u0000"))?.[1]
    expect((recordedCatalog as ReadonlyArray<{ readonly name: string }>).map((flow) => flow.name)).toContain(
      "mcp.search"
    )
    expect(judge.asked).toHaveLength(1)
    expect(judge.asked[0]!.map((item) => item.id)).toEqual([
      "mcp.search",
      "review",
      "AGENTS.md#0",
      "AGENTS.md#1",
      "AGENTS.md#2"
    ])
    expect(judge.asked[0]!.map((item) => item.kind)).toEqual([
      "flow",
      "skill",
      "instruction",
      "instruction",
      "instruction"
    ])

    expect(gate(events)).toEqual(["discipline-armed", "decision-settled", "relevance-settled"])
    expect(of(events, "discipline-armed")[0]!.relevance).toEqual({ withholdAt: 0.9, pinned: ["read"] })
    const settled = of(events, "relevance-settled")[0]!
    expect(settled).toMatchObject({ scope: "session-1", frame: 0, source: "run", withholdAt: 0.9 })
    expect(settled.withheld.map((item) => item.id)).toEqual(["mcp.search", "AGENTS.md#1"])
    expect(settled.kept.map((item) => item.id)).toEqual(["review", "AGENTS.md#0", "AGENTS.md#2"])
    expect(of(events, "decision-settled").find((event) => event.classifier === "relevance/unnecessary")?.acted)
      .toBe(true)
  })

  it("refuses a call to a withheld flow, restores it, and shows it from the next frame", async () => {
    const { events, failed, model, engine } = await refreshed({
      script: [
        emits(
          `var withheld = await ctx.call("mcp.search", {}); console.log(withheld.error.code, Object.keys(ctx.flows).join(","))`
        ),
        emits(`var found = await ctx.call("mcp.search", {});
var missing = await ctx.call("nope", {});
ctx.done({ names: Object.keys(ctx.flows), found, missing: missing.error.code })`)
      ],
      evaluator: judging().layer,
      calls: [{ _tag: "Success", value: "hits" }]
    })
    expect(failed).toBe(false)
    expect(of(events, "cell-printed")[0]!.text).toContain("flow_withheld read,review")
    expect(of(events, "relevance-restored")).toEqual([
      expect.objectContaining({ scope: "session-1", frame: 0, flow: "mcp.search" })
    ])
    expect(catalogText(model.recorder.requests[1])).toContain("mcp.search")
    expect(engine.recorder.calls.map((call) => call.flowName)).toEqual(["mcp.search"])
    expect(resolved(events)).toEqual({
      names: ["read", "mcp.search", "review"],
      found: "hits",
      missing: "unknown_flow"
    })
  })

  it("replays the reading without asking again", async () => {
    const records = new Map<string, unknown>()
    const script = (): ScriptedModel.Script => [emits(`console.log("look")`), emits(`ctx.done("done")`)]
    const first = await refreshed({ script: script(), evaluator: judging().layer, records })
    const everything = jev(() => 1)
    const replay = await refreshed({ script: script(), evaluator: everything.layer, records })
    expect(everything.asked).toEqual([])
    expect(replay.model.recorder.requests).toEqual(first.model.recorder.requests)
    expect(of(replay.events, "relevance-settled")).toEqual(of(first.events, "relevance-settled"))
  })

  it("keeps an edited chunk a replay's reading withheld under its old text", async () => {
    const records = new Map<string, unknown>()
    const script = (): ScriptedModel.Script => [emits(`ctx.done("done")`)]
    await refreshed({ script: script(), evaluator: judging().layer, records })
    const edited: Relevance.Document = {
      path: "AGENTS.md",
      text: "- Run the parser tests with pnpm test.\n- Never push to main.\n- Keep commits small.\n"
    }
    const replay = await refreshed({ script: script(), evaluator: jev(() => 1).layer, records, instructions: [edited] })
    expect(systemText(replay.model.recorder.requests[0])).toContain("Never push to main.")
  })

  it("keeps a resumed run's withheld flows from its state", async () => {
    const shown = [read, review]
    const resumed = Schema.decodeUnknownSync(CellTurn.State)(
      Schema.encodeUnknownSync(CellTurn.State)(
        new CellTurn.State({ ...state({ frame: 1, flows: shown }), withheldFlows: ["mcp.search"] })
      )
    )
    const everything = jev(() => 1)
    const { events, model } = await run({
      script: [emits(`ctx.done(Object.keys(ctx.flows).join(","))`)],
      state: resumed,
      flows: catalog,
      judged: true,
      instructions,
      evaluator: everything.layer
    })
    expect(everything.asked).toEqual([])
    expect(catalogText(model.recorder.requests[0])).not.toContain("mcp.search")
    expect(of(events, "resolved")[0]!.message.content[0]).toMatchObject({ text: "read,review" })
  })

  it("gates a static catalog", async () => {
    const { events, model } = await run({
      script: [emits(`ctx.done(Object.keys(ctx.flows).join(","))`)],
      state: state(),
      flows: catalog,
      judged: true,
      instructions,
      pinned: ["read"],
      evaluator: judging().layer
    })
    expect(catalogText(model.recorder.requests[0])).not.toContain("mcp.search")
    expect(catalogText(model.recorder.requests[0])).toContain("review")
    expect(systemText(model.recorder.requests[0])).not.toContain("Deploy only")
    expect(of(events, "resolved")[0]!.message.content[0]).toMatchObject({ text: "read,review" })
  })

  it("drops the instructions segment when every chunk is withheld, and never judges a pinned flow", async () => {
    const judge = jev((id) => id === "read" ? 1 : id.startsWith("AGENTS.md") ? 0.99 : 0)
    const { events, model } = await run({
      script: [emits(`ctx.done("done")`)],
      state: state(),
      flows: catalog,
      judged: true,
      instructions,
      pinned: ["read"],
      evaluator: judge.layer
    })
    expect(judge.asked.flat().map((item) => item.id)).not.toContain("read")
    const system = systemText(model.recorder.requests[0])
    expect(system).not.toContain("Project-specific instructions")
    expect(system).toContain("host safety rules")
    expect(system).toContain("Fix the parser.")
    expect(of(events, "relevance-settled")[0]!.withheld.map((item) => item.kind)).toEqual([
      "instruction",
      "instruction",
      "instruction"
    ])
  })

  it("leaves the instructions alone when Jev withholds only a flow", async () => {
    const { events, model } = await run({
      script: [emits(`ctx.done("done")`)],
      state: state(),
      flows: catalog,
      judged: true,
      instructions,
      evaluator: jev((id) => id === "review" ? 0.97 : 0).layer
    })
    expect(of(events, "relevance-settled")[0]!.withheld.map((item) => item.id)).toEqual(["review"])
    expect(catalogText(model.recorder.requests[0])).not.toContain("review")
    expect(systemText(model.recorder.requests[0])).toContain(Relevance.render(instructions, new Set()))
  })

  it("asks nothing when there is nothing to judge", async () => {
    const judge = jev(() => 1)
    const { events } = await run({
      script: [emits(`ctx.done("done")`)],
      state: state({ flows: [read] }),
      flows: [read],
      judged: true,
      pinned: ["read"],
      evaluator: judge.layer
    })
    expect(judge.asked).toEqual([])
    expect(of(events, "relevance-settled")).toEqual([])
    expect(of(events, "decision-unjudged")).toEqual([])
  })

  it("withholds nothing and journals the receipt when Jev cannot answer", async () => {
    const { events, model, failure } = await run({
      script: [emits(`ctx.done(Object.keys(ctx.flows).join(","))`)],
      state: state(),
      flows: catalog,
      judged: true,
      instructions,
      pinned: ["read"],
      evaluator: Evaluator.layerUnavailable()
    })
    // The claim brake cannot be judged either, so the run stops there.
    expect(failure).toMatchObject({ code: "completion_unjudged" })
    expect(of(events, "decision-unjudged")).toEqual([
      expect.objectContaining({ classifier: "relevance/unnecessary", frame: 0, items: 5 })
    ])
    expect(of(events, "relevance-settled")).toEqual([])
    expect(catalogText(model.recorder.requests[0])).toContain("mcp.search")
    expect(systemText(model.recorder.requests[0])).toContain("Deploy only from the release branch")
  })

  it("takes no reading when the run is not judged", async () => {
    const throwing = Evaluator.layerScripted((request) => {
      if (Object.keys(request.questions).some((id) => id.startsWith("unnecessary_"))) {
        throw new Error("the relevance reading ran unjudged")
      }
      return {
        complete: { probability: 0.99 },
        overclaims: { probability: 0.01 },
        invented: { probability: 0.01 },
        requiresWorkspaceChange: { probability: 0.5 },
        reportsLimitation: { probability: 0 }
      }
    })
    const { events, model, failure } = await run({
      script: [emits(`ctx.done(Object.keys(ctx.flows).join(","))`)],
      state: state(),
      flows: catalog,
      instructions,
      pinned: ["read"],
      evaluator: throwing
    })
    expect(failure).toBeUndefined()
    expect(of(events, "discipline-armed")[0]).not.toHaveProperty("relevance")
    expect(catalogText(model.recorder.requests[0])).toContain("mcp.search")
    expect(of(events, "resolved")[0]!.message.content[0]).toMatchObject({ text: "read,mcp.search,review" })
  })

  it("renders only the memory rows Jev keeps, in the one reading beside flows and instructions", async () => {
    const judge = jev((id) => id === "deploy" ? 0.95 : withholding[id] ?? 0.2)
    const { events, failed, model } = await refreshed({
      script: [emits(`ctx.done("done")`)],
      evaluator: judge.layer,
      memory
    })
    expect(failed).toBe(false)
    expect(judge.asked).toHaveLength(1)
    expect(judge.asked[0]!.map((item) => [item.kind, item.id])).toEqual([
      ["flow", "mcp.search"],
      ["skill", "review"],
      ["instruction", "AGENTS.md#0"],
      ["instruction", "AGENTS.md#1"],
      ["instruction", "AGENTS.md#2"],
      ["memory", "note-1"],
      ["memory", "deploy"],
      ["memory", "parser"]
    ])
    // Each row is judged against the task alone, never against itself.
    expect(judge.tasks).toEqual(["The task for this run:\n\nFix the parser."])
    const system = (model.recorder.requests[0]?.system ?? []).map((part) => part.text)
    expect(system).toContain(render([rows[0]!, rows[2]!]))
    expect(system.join("\n")).not.toContain("deploy from the release branch")
    expect(system.join("\n")).not.toContain("Deploy only from the release branch")
    expect(catalogText(model.recorder.requests[0])).not.toContain("mcp.search")
    const settled = of(events, "relevance-settled")[0]!
    expect(settled.withheld.map((item) => [item.kind, item.id])).toEqual([
      ["flow", "mcp.search"],
      ["instruction", "AGENTS.md#1"],
      ["memory", "deploy"]
    ])
  })

  it("drops the memory segment when every row is withheld, and withholds no flow for a row", async () => {
    const { events, model } = await refreshed({
      script: [emits(`ctx.done(Object.keys(ctx.flows).join(","))`)],
      evaluator: jev((id) => rows.some((row) => row.key === id) ? 0.99 : 0).layer,
      memory
    })
    expect(systemText(model.recorder.requests[0])).not.toContain("<flows_memory_context>")
    expect(systemText(model.recorder.requests[0])).toContain("Deploy only from the release branch")
    expect(of(events, "resolved")[0]!.message.content[0]).toMatchObject({ text: "read,mcp.search,review" })
  })

  it("keeps every memory row and journals the receipt when Jev cannot answer", async () => {
    const { events, model } = await refreshed({
      script: [emits(`ctx.done("done")`)],
      evaluator: Evaluator.layerUnavailable(),
      memory
    })
    expect(of(events, "decision-unjudged")).toEqual([
      expect.objectContaining({ classifier: "relevance/unnecessary", frame: 0, items: 8 })
    ])
    expect(of(events, "relevance-settled")).toEqual([])
    expect((model.recorder.requests[0]?.system ?? []).map((part) => part.text)).toContain(render(rows))
  })

  it("replays the memory rows it kept without asking again", async () => {
    const records = new Map<string, unknown>()
    const script = (): ScriptedModel.Script => [emits(`console.log("look")`), emits(`ctx.done("done")`)]
    const first = await refreshed({
      script: script(),
      evaluator: jev((id) => id === "deploy" ? 0.95 : 0).layer,
      records,
      memory
    })
    const everything = jev(() => 1)
    const replay = await refreshed({ script: script(), evaluator: everything.layer, records, memory })
    expect(everything.asked).toEqual([])
    expect(replay.model.recorder.requests).toEqual(first.model.recorder.requests)
    expect(systemText(replay.model.recorder.requests[0])).toContain(render([rows[0]!, rows[2]!]))
  })
})

describe("a flow journaling into its run", () => {
  it("reaches the run that called it through AgentEvent.Journal, and goes nowhere outside a run", async () => {
    const receipt = new AgentEvent.RelevanceSettled({
      eventType: AgentEvent.eventType.relevanceSettled,
      scope: "session-1",
      frame: 0,
      source: "recall",
      withholdAt: Relevance.withholdAt,
      kept: [],
      withheld: [],
      latencyMs: 1
    })
    await Effect.runPromise(Effect.flatMap(AgentEvent.Journal, (journal) => journal(receipt)))
    const model = ScriptedModel.make([emits(`await ctx.call("read", {}); ctx.done("done")`)])
    const fixture = ScriptedEngine.make(model.model)
    const events: Array<AgentEvent.AgentEvent> = []
    await CellTurn.run({ state: state({ flows: [read] }), flows: [read] }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(EngineLike.layer(EngineLike.make({
        ...fixture.engine,
        call: (call) =>
          Effect.flatMap(AgentEvent.Journal, (journal) => journal(receipt)).pipe(
            Effect.andThen(fixture.engine.call(call))
          )
      }))),
      Effect.provide(QuickJSSandbox.layer),
      Effect.provide(Steering.layerNoop()),
      Effect.provide(jev(() => 0).layer),
      Effect.runPromise
    )
    expect(of(events, "relevance-settled")).toEqual([receipt])
  })
})
