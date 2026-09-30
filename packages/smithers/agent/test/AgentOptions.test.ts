/**
 * `Agent.Options` in combination, not one flag at a time.
 *
 * `Agent.test.ts` proves each declaration reaches the boundary. What it does
 * not do is cross them, and the crossings are where the meaning of one option
 * depends on another: memory only occupies a segment when its text is
 * non-empty, an envelope decides per flow rather than per run, a markdown flow
 * is callable only when a prompt runner exists, a discovered flow is callable
 * only when an implementation is bound, and a resolved context window of zero
 * turns compaction off however crowded the window gets.
 *
 * Every case here runs the production composition inside one real durable flow
 * execution, with a scripted provider and an in-memory registry.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import type * as CellCalls from "@smthrs/harness/CellCalls"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Monitor from "@smthrs/harness/Monitor"
import type * as Relevance from "@smthrs/harness/Relevance"
import type * as SnapshotRecorder from "@smthrs/memory/SnapshotRecorder"
import * as MemorySource from "@smthrs/memory/Source"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { RegistryError } from "@smthrs/registry/RegistryError"
import { Cause, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import type * as AgentAction from "../src/AgentAction.ts"
import type * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** A model that replies with one scripted cell per call and records requests. */
const scripted = (
  cells: ReadonlyArray<string>,
  requests: Array<ModelRequest.ModelRequest>
): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(request)
        const source = cells[index] ?? cells.at(-1) ?? "ctx.done(\"done\")"
        index++
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

interface DescriptorOptions {
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly markdown?: boolean | undefined
  readonly modelInvocable?: boolean | undefined
}

const descriptor = (name: string, options: DescriptorOptions = {}): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `The ${name} flow.`,
    body: options.markdown === true
      ? new Descriptor.BodyRefMarkdown({ path: `/flows/${name}/flow.md`, baseDirectory: `/flows/${name}` })
      : new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: options.capabilities ?? [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
    placement: Option.none(),
    modelInvocable: options.modelInvocable ?? true,
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

/**
 * One in-memory registry answering both `visible` — what the model is shown —
 * and `getOption` — what the boundary resolves against, so the fixture cannot
 * fake the two apart.
 */
const registryOf = (
  entries: ReadonlyArray<Descriptor.FlowDescriptor>,
  prompts: Record<string, string> = {}
): Registry.Registry => {
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  return Registry.makeNoop({
    list: () => Effect.succeed(entries),
    visible: () => Effect.succeed(entries),
    getOption: (name) => Effect.succeed(Option.fromNullishOr(byName.get(name))),
    runPrompt: (name) =>
      name in prompts
        ? Effect.succeed(prompts[name]!)
        : Effect.fail(new RegistryError({ code: "not_prompt_flow", message: `${name} has no prompt body` }))
  })
}

type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended" }

const classify = (exit: Exit.Exit<unknown, unknown>): Outcome =>
  Exit.isSuccess(exit)
    ? { _tag: "completed", value: exit.value }
    : Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "suspended" }
    : { _tag: "failed", error: Cause.squash(exit.cause) }

/** The one flow every `drive` execution registers; its body is inert. */
const driveFlow = Flow.make("agent/test/agent-options", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** Runs one body as the whole of one real durable flow execution. */
const drive = <A, E>(
  body: Effect.Effect<A, E, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
): Promise<Outcome> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.register(driveFlow, () =>
      Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(Effect.provide(Layer.merge(FlowEngine.layerMemory, NodeCrypto.layer)), Effect.scoped, Effect.runPromise)

type RunOptions = Omit<Agent.Options, "session" | "seat" | "prompt" | "registry"> & {
  readonly session?: string | undefined
  readonly prompt?: string | undefined
  readonly registry: Registry.Registry
  readonly model: Model.Model
  readonly contextWindowTokens?: number | undefined
  /** The judge; the offline completion judge when omitted. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
}

/** Runs the production agent with exactly the options a case declares. */
const collect = ({ evaluator, ...options }: RunOptions) =>
  Effect.gen(function*() {
    const agent = yield* Agent.Agent
    const events: Array<AgentEvent.AgentEvent> = []
    yield* agent.run({
      ...options,
      session: options.session ?? "session-1",
      prompt: options.prompt ?? "do the task",
      seat: Seat.make({
        id: "anthropic:test-model",
        modelId: "test-model",
        model: options.model,
        route,
        contextWindowTokens: options.contextWindowTokens ?? 0
      })
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(Layer.merge(Agent.layerDefaults, evaluator ?? scriptedCompletionJudge))
    )
    return events
  }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))

const events = (outcome: Outcome): ReadonlyArray<AgentEvent.AgentEvent> => {
  expect(outcome._tag).toBe("completed")
  return outcome._tag === "completed" ? outcome.value as ReadonlyArray<AgentEvent.AgentEvent> : []
}

/** Every call refusal the cell was handed back, in order. */
const refusals = (settled: ReadonlyArray<AgentEvent.AgentEvent>): ReadonlyArray<string> =>
  settled.flatMap((event) =>
    event._tag === "cell-call-settled" && event.result.outcome === "failure" ? [event.result.message ?? ""] : []
  )

/** The output of the last `complete` transition the run applied. */
const completedOutput = (settled: ReadonlyArray<AgentEvent.AgentEvent>): string | undefined => {
  for (let index = settled.length - 1; index >= 0; index--) {
    const event = settled[index]!
    if (event._tag === "transition-applied" && event.transition._tag === "complete") return event.transition.output
  }
  return undefined
}

const systemTexts = (request: ModelRequest.ModelRequest): ReadonlyArray<string> =>
  request.system.map((part) => part.text)

const complete = "ctx.done(\"done\")"

/**
 * A cell that never completes and never repeats its context.
 *
 * The counter is not decoration. A sealed model step is keyed on the context
 * digest, so a cell that projects a byte-identical window every frame replays
 * one recorded provider call instead of making another, and a frame-budget
 * assertion counting provider calls would count the cache instead of the
 * budget.
 */
const keepGoing = `var seen = (typeof seen === "number" ? seen : 0) + 1
console.log("again " + seen)`

const memoryText = "<flows_memory_context>\n[bank/fact] remembered\n</flows_memory_context>"
const memory: MemorySource.Declared = {
  rows: [{ origin: "recall", bank: "bank", key: "fact", text: "remembered" }],
  digest: "memory-digest"
}
const emptyMemory: MemorySource.Declared = { rows: [], digest: "empty-digest" }

describe("system teaching crossed with memory", () => {
  const run = (declared: {
    readonly system?: ReadonlyArray<string> | undefined
    readonly memory?: MemorySource.Declared | undefined
  }) => {
    const requests: Array<ModelRequest.ModelRequest> = []
    return drive(
      collect({
        registry: registryOf([]),
        model: scripted([complete], requests),
        maxFrames: 2,
        ...declared
      })
    ).then((outcome) => {
      events(outcome)
      return systemTexts(requests[0]!)
    })
  }

  it("injects neither when neither is declared, and still teaches the cell contract", async () => {
    const texts = await run({})
    expect(texts.some((text) => text.includes(memoryText))).toBe(false)
    // The task is always a prefix segment, whatever else is declared.
    expect(texts.some((text) => text.includes("do the task"))).toBe(true)
  })

  it("injects system teaching alone, ahead of the task", async () => {
    const texts = await run({ system: ["first teaching", "second teaching"] })
    expect(texts.indexOf("first teaching")).toBeGreaterThanOrEqual(0)
    // Declaration order is preserved, and both land before the task.
    expect(texts.indexOf("first teaching")).toBeLessThan(texts.indexOf("second teaching"))
    expect(texts.indexOf("second teaching")).toBeLessThan(
      texts.findIndex((text) => text.includes("do the task"))
    )
    expect(texts.some((text) => text.includes(memoryText))).toBe(false)
  })

  it("injects a memory snapshot alone", async () => {
    const texts = await run({ memory })
    expect(texts.some((text) => text.includes(memoryText))).toBe(true)
  })

  it("orders system teaching ahead of memory when both are declared", async () => {
    const texts = await run({ system: ["first teaching"], memory })
    const teaching = texts.indexOf("first teaching")
    const remembered = texts.findIndex((text) => text.includes(memoryText))
    const task = texts.findIndex((text) => text.includes("do the task"))
    expect(teaching).toBeGreaterThanOrEqual(0)
    expect(teaching).toBeLessThan(remembered)
    expect(remembered).toBeLessThan(task)
  })

  it("injects nothing for a present-but-empty memory snapshot, declared beside system teaching", async () => {
    // An empty snapshot is not the same as an absent one to the caller, and
    // must be the same to the window: a zero-length segment would still cost
    // a declared digest and a boundary in every request.
    const withEmpty = await run({ system: ["first teaching"], memory: emptyMemory })
    const withNone = await run({ system: ["first teaching"] })
    expect(withEmpty).toEqual(withNone)
  })

  it("injects nothing for an empty memory snapshot declared with no system teaching", async () => {
    expect(await run({ memory: emptyMemory })).toEqual(await run({}))
  })
})

describe("opening memory in the run-start relevance reading", () => {
  const rows: ReadonlyArray<SnapshotRecorder.Row> = [
    { origin: "primer", bank: "bank", key: "note-1", text: "use pnpm" },
    { origin: "recall", bank: "bank", key: "deploy", text: "deploy from the release branch" },
    { origin: "recall", bank: "bank", key: "parser", text: "the parser lives in src/parse" }
  ]
  const declared: MemorySource.Declared = { rows, digest: "memory-digest" }
  const completion = {
    complete: { probability: 0.99 },
    overclaims: { probability: 0.01 },
    invented: { probability: 0.01 },
    requiresWorkspaceChange: { probability: 0.5 },
    reportsLimitation: { probability: 0 }
  }
  const run = (relevance: (items: ReadonlyArray<Relevance.Item>) => ReturnType<Evaluator.Script>) => {
    const asked: Array<ReadonlyArray<Relevance.Item>> = []
    const requests: Array<ModelRequest.ModelRequest> = []
    const evaluator = Evaluator.layerScripted((request) => {
      if (!Object.keys(request.questions).some((id) => id.startsWith("unnecessary_"))) return completion
      const items = (request.state as { readonly items: ReadonlyArray<Relevance.Item> }).items
      asked.push(items)
      return relevance(items)
    })
    return drive(
      collect({
        registry: registryOf([descriptor("lookup")]),
        model: scripted([complete], requests),
        maxFrames: 2,
        judged: true,
        instructions: [{ path: "AGENTS.md", text: "- Use pnpm.\n" }],
        memory: declared,
        evaluator
      })
    ).then((outcome) => ({ events: events(outcome), asked, texts: systemTexts(requests[0]!) }))
  }

  it("renders only the rows Jev keeps, judged in the one reading beside flows and instructions", async () => {
    const { asked, events: settled, texts } = await run((items) =>
      Object.fromEntries(
        items.map((item, index) => [`unnecessary_${index}`, { probability: item.id === "deploy" ? 0.95 : 0.1 }])
      )
    )
    expect(asked).toHaveLength(1)
    expect(asked[0]!.map((item) => [item.kind, item.id])).toEqual([
      ["flow", "lookup"],
      ["instruction", "AGENTS.md#0"],
      ["memory", "note-1"],
      ["memory", "deploy"],
      ["memory", "parser"]
    ])
    const kept = MemorySource.render([rows[0]!, rows[2]!])
    expect(texts).toContain(kept)
    expect(kept).toMatch(
      /^<flows_memory_context>\n\[primer:bank\] use pnpm\n\[bank\/parser\] .*\n<\/flows_memory_context>$/
    )
    expect(texts.join("\n")).not.toContain("deploy from the release branch")
    expect(texts.findIndex((text) => text === kept)).toBeLessThan(
      texts.findIndex((text) => text.includes("do the task"))
    )
    const relevance = settled.find((event) => event._tag === "relevance-settled")
    expect(relevance?._tag === "relevance-settled" ? relevance.withheld : []).toEqual([
      expect.objectContaining({ kind: "memory", id: "deploy" })
    ])
  })

  it("drops the memory segment when every row is withheld", async () => {
    const { texts } = await run((items) =>
      Object.fromEntries(
        items.map((item, index) => [`unnecessary_${index}`, { probability: item.kind === "memory" ? 0.99 : 0 }])
      )
    )
    expect(texts.some((text) => text.includes("<flows_memory_context>"))).toBe(false)
    expect(texts.some((text) => text.includes("- Use pnpm."))).toBe(true)
  })

  it("keeps every row and journals decision-unjudged when Jev cannot answer", async () => {
    const { events: settled, texts } = await run(() =>
      Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" }))
    )
    expect(texts).toContain(MemorySource.render(rows))
    expect(settled.filter((event) => event._tag === "decision-unjudged")).toEqual([
      expect.objectContaining({ classifier: "relevance/unnecessary", frame: 0, items: 5 })
    ])
    expect(settled.some((event) => event._tag === "relevance-settled")).toBe(false)
  })
})

describe("the static stance", () => {
  const run = (declared: Pick<RunOptions, "judged" | "supervisor">) => {
    const requests: Array<ModelRequest.ModelRequest> = []
    return drive(
      collect({ registry: registryOf([]), model: scripted([keepGoing, complete], requests), maxFrames: 3, ...declared })
    ).then((outcome) => {
      const armed = events(outcome).find((event) => event._tag === "discipline-armed")
      return {
        stance: armed?._tag === "discipline-armed" ? armed.stance : undefined,
        taught: requests.map((request) => systemTexts(request).filter((text) => text.startsWith("Stance: ")))
      }
    })
  }

  it("teaches a judged run careful by default, every frame, and journals it", async () => {
    const { stance, taught } = await run({ judged: true })
    expect(stance).toBe("careful")
    expect(taught.length).toBeGreaterThanOrEqual(2)
    for (const texts of taught) expect(texts).toEqual([Monitor.carefulText])
  })

  it("teaches the stance a judged run selects", async () => {
    const { stance, taught } = await run({ judged: true, supervisor: { stance: "paranoid" } })
    expect(stance).toBe("paranoid")
    expect(taught[0]).toEqual([Monitor.paranoidText])
  })

  it("teaches an unjudged run no stance, whatever it selects", async () => {
    const { stance, taught } = await run({ supervisor: { stance: "paranoid" } })
    expect(stance).toBeUndefined()
    for (const texts of taught) expect(texts).toEqual([])
  })
})

describe("the capability envelope decides per flow", () => {
  // An envelope refusal is decided before the durable boundary opens, so the
  // cell sees it as a thrown exception rather than a settled call result.
  // A refused call resolves with the failure envelope rather than throwing, so
  // both calls are observable in one frame — which is what the mixing case
  // needs.
  const both = `const results = []
for (const flow of ["fs/read", "fs/write"]) {
  const result = await ctx.call(flow, {})
  results.push(flow + ": " + (result.ok === false ? result.error.message : result))
}
ctx.done(results.join("\\n"))`

  const flows = [
    descriptor("fs/read", { capabilities: ["fs:read:**"] }),
    descriptor("fs/write", { capabilities: ["fs:write:**"] })
  ]

  const implementations = (executed: Array<string>): ReadonlyMap<string, CellCalls.Implementation> =>
    new Map<string, CellCalls.Implementation>(
      flows.map((flow) => [
        flow.name,
        (call) =>
          Effect.sync(() => {
            executed.push(call.flowName)
            return new Cell.CallResult({ outcome: "success", value: "ran" })
          })
      ])
    )

  const run = (envelope: ReadonlyArray<Capability.CapabilityPattern> | undefined) => {
    const executed: Array<string> = []
    const requests: Array<ModelRequest.ModelRequest> = []
    return drive(
      collect({
        registry: registryOf(flows),
        model: scripted([both], requests),
        implementations: implementations(executed),
        capabilityEnvelope: envelope,
        // One frame only, so the completion is accepted as declared and each
        // flow is attempted exactly once.
        maxFrames: 1
      })
    ).then((outcome) => ({ executed, reported: completedOutput(events(outcome))?.split("\n") ?? [] }))
  }

  const pattern = (action: string, resource: string): Capability.CapabilityPattern =>
    Schema.decodeUnknownSync(Capability.CapabilityPattern)({ action, resource })

  it("grants nothing when the envelope is empty, which is the documented default", async () => {
    const result = await run([])
    expect(result.executed).toEqual([])
    expect(result.reported).toHaveLength(2)
    expect(result.reported.every((line) => line.includes("outside this run's capability envelope"))).toBe(true)
  })

  it("grants nothing when the envelope is absent, exactly as an empty one does", async () => {
    const absent = await run(undefined)
    const empty = await run([])
    expect(absent.executed).toEqual([])
    expect(absent.reported).toEqual(empty.reported)
  })

  it("admits both under a wildcard envelope", async () => {
    const result = await run([pattern("*", "**")])
    expect(result.executed).toEqual(["fs/read", "fs/write"])
    expect(result.reported).toEqual(["fs/read: ran", "fs/write: ran"])
  })

  it("admits one and refuses the other under a specific envelope", async () => {
    const result = await run([pattern("fs:read", "**")])
    expect(result.executed).toEqual(["fs/read"])
    expect(result.reported[0]).toBe("fs/read: ran")
    expect(result.reported[1]).toContain("fs:write:**")
    expect(result.reported[1]).toContain("outside this run's capability envelope")
  })
})

describe("the frame budget", () => {
  const run = (maxFrames: number | undefined, cells: ReadonlyArray<string> = [keepGoing]) => {
    const requests: Array<ModelRequest.ModelRequest> = []
    return drive(
      collect({ registry: registryOf([]), model: scripted(cells, requests), maxFrames })
    ).then((outcome) => {
      const settled = events(outcome)
      return {
        tags: settled.map((event) => event._tag),
        calls: requests.length,
        output: completedOutput(settled)
      }
    })
  }

  it("disarms a zero budget and keeps a positive budget bounded", async () => {
    const unlimited = await run(0, [keepGoing, complete])
    expect(unlimited.calls).toBe(2)
    expect(unlimited.output).toBe("done")
    const bounded = await run(1, [keepGoing, complete])
    expect(bounded.calls).toBe(1)
    expect(bounded.output).toBeUndefined()
  })

  it("spends the whole budget on a cell that never completes", async () => {
    expect((await run(4)).calls).toBe(4)
  })

  it("does not behave like the smallest budget when no budget is declared", async () => {
    // An undeclared budget is `CellTurn.defaultMaxFrames`, not zero: a run
    // that needs three frames to reach its answer gets them.
    const script = [keepGoing, keepGoing, complete]
    expect((await run(undefined, script)).output).toBe("done")
    expect((await run(1, script)).output).toBeUndefined()
  })
})

describe("authorize decides per call, and only when supplied", () => {
  const two = `await ctx.call("fs/read", {})
await ctx.call("fs/write", {})
ctx.done("done")`

  const flows = [descriptor("fs/read"), descriptor("fs/write")]

  const implementations = (executed: Array<string>): ReadonlyMap<string, CellCalls.Implementation> =>
    new Map<string, CellCalls.Implementation>(
      flows.map((flow) => [
        flow.name,
        (call) =>
          Effect.sync(() => {
            executed.push(call.flowName)
            return new Cell.CallResult({ outcome: "success", value: "ran" })
          })
      ])
    )

  const run = (authorize: Agent.Options["authorize"]) => {
    const executed: Array<string> = []
    const requests: Array<ModelRequest.ModelRequest> = []
    return drive(
      collect({
        registry: registryOf(flows),
        model: scripted([two], requests),
        implementations: implementations(executed),
        capabilityEnvelope: [],
        authorize,
        maxFrames: 2
      })
    ).then((outcome) => ({ executed, outcome }))
  }

  it("runs both calls when no hook is supplied", async () => {
    const result = await run(undefined)
    expect(result.outcome._tag).toBe("completed")
    expect(result.executed).toEqual(["fs/read", "fs/write"])
  })

  it("stops at the one call the hook refuses, after the one it admitted", async () => {
    const result = await run((call) =>
      call.flowName === "fs/write"
        ? Effect.fail(new HarnessError({ code: "engine_failed", message: "fs/write is not permitted here" }))
        : Effect.void
    )

    // The admitted call ran and its effect stands; the refused one never
    // opened a boundary, and the refusal is the run's, not a value the cell
    // could catch and route around.
    expect(result.executed).toEqual(["fs/read"])
    expect(result.outcome._tag).toBe("failed")
    expect(JSON.stringify(result.outcome)).toContain("fs/write is not permitted here")
  })

  it("resolves a call the host denies in the cell as capability_refused with the host's message", async () => {
    const denied = `await ctx.call("fs/read", {})
const result = await ctx.call("fs/write", {})
ctx.done(result.ok === false ? result.error.code + " " + result.error.message : "not denied")`
    const executed: Array<string> = []
    const outcome = await drive(
      collect({
        registry: registryOf(flows),
        model: scripted([denied], []),
        implementations: implementations(executed),
        capabilityEnvelope: [],
        authorize: (call) =>
          call.flowName === "fs/write"
            ? Effect.fail(
              new HarnessError({
                code: "engine_failed",
                message: "Denied",
                cause: Permission.permissionDenied(Capability.make("fs:write", "x"), "permission request denied")
              })
            )
            : Effect.void,
        maxFrames: 1
      })
    )

    // A person said no. The cell reads that as a value and finishes; the run
    // does not die, and the refused flow never ran.
    expect(executed).toEqual(["fs/read"])
    expect(completedOutput(events(outcome))).toBe("capability_refused Denied")
  })

  it("does not charge the time authorization waits to the call ceiling", async () => {
    const one = `const result = await ctx.call("fs/write", {})
ctx.done(typeof result === "string" ? result : result.error.code)`
    const executed: Array<string> = []
    const outcome = await drive(
      collect({
        registry: registryOf(flows),
        model: scripted([one], []),
        implementations: implementations(executed),
        capabilityEnvelope: [],
        limits: { callMs: 100 },
        authorize: () => Effect.sleep("300 millis"),
        maxFrames: 1
      })
    )

    expect(executed).toEqual(["fs/write"])
    expect(completedOutput(events(outcome))).toBe("ran")
  })

  it("authorizes an admitted call once", async () => {
    const one = `await ctx.call("fs/write", {})
ctx.done("done")`
    let asked = 0
    const outcome = await drive(
      collect({
        registry: registryOf(flows),
        model: scripted([one], []),
        implementations: implementations([]),
        capabilityEnvelope: [],
        authorize: () => Effect.sync(() => void asked++),
        maxFrames: 1
      })
    )

    expect(completedOutput(events(outcome))).toBe("done")
    expect(asked).toBe(1)
  })
})

describe("a markdown flow needs a prompt runner", () => {
  const call = `const answer = await ctx.call("docs/summarise", { args: "the release notes" })
ctx.done(String(answer))`

  const flows = [descriptor("docs/summarise", { markdown: true })]

  const run = (promptRunner: CellCalls.PromptRunner | undefined) => {
    const requests: Array<ModelRequest.ModelRequest> = []
    return drive(
      collect({
        registry: registryOf(flows, { "docs/summarise": "Summarise it." }),
        model: scripted([call], requests),
        promptRunner,
        capabilityEnvelope: [],
        // One frame only: a refused call raises inside the cell, and a second
        // frame would re-issue the same call and double every count.
        maxFrames: 1
      })
    ).then((outcome) => events(outcome))
  }

  it("refuses the call catchably when the host runs no markdown flows", async () => {
    const refused = refusals(await run(undefined))
    expect(refused).toHaveLength(1)
    expect(refused[0]).toBe("Flow docs/summarise is a markdown flow and this host runs none.")
  })

  it("hands the rendered body to the runner the host did supply", async () => {
    const rendered: Array<string> = []
    const settled = await run(({ text }) =>
      Effect.sync(() => {
        rendered.push(text)
        return new Cell.CallResult({ outcome: "success", value: "summarised" })
      })
    )

    expect(rendered).toEqual(["Summarise it."])
    expect(refusals(settled)).toEqual([])
  })
})

describe("a discovered flow needs an implementation", () => {
  const call = `await ctx.call("fs/read", {})
ctx.done("done")`

  const run = (implementations: ReadonlyMap<string, CellCalls.Implementation> | undefined) => {
    const requests: Array<ModelRequest.ModelRequest> = []
    return drive(
      collect({
        registry: registryOf([descriptor("fs/read")]),
        model: scripted([call], requests),
        implementations,
        flows: [],
        capabilityEnvelope: [],
        maxFrames: 1
      })
    ).then((outcome) => events(outcome))
  }

  it("refuses the call catchably when nothing is bound for it", async () => {
    const refused = refusals(await run(undefined))
    expect(refused).toEqual(["Flow fs/read is discovered but this host has no implementation bound for it."])
  })

  it("refuses the same way for an implementation map that has no entry for it", async () => {
    const refused = refusals(await run(new Map()))
    expect(refused).toEqual(["Flow fs/read is discovered but this host has no implementation bound for it."])
  })

  it("runs the call when the host binds one, with an explicitly empty flow source list", async () => {
    const executed: Array<string> = []
    const settled = await run(
      new Map<string, CellCalls.Implementation>([[
        "fs/read",
        (target) =>
          Effect.sync(() => {
            executed.push(target.flowName)
            return new Cell.CallResult({ outcome: "success", value: "ran" })
          })
      ]])
    )

    expect(executed).toEqual(["fs/read"])
    expect(refusals(settled)).toEqual([])
  })
})

describe("the resolved context window arms or disarms compaction", () => {
  /**
   * A model that answers with a cell that throws a very large message.
   *
   * That is the shape that grows a window: a raise is recorded as an
   * observation appended to the transcript, so every reply adds a segment
   * instead of replacing one, and the window crosses its budget within a few
   * frames. Prose served here until the reply a dead frame echoes back was
   * bounded; a test that grew a window that way would now be measuring a leak
   * rather than compaction.
   */
  const rambling = (requests: Array<unknown>): Model.Model =>
    Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          requests.push(request)
          const cell = `throw new Error("detail ".repeat(12000))`
          return Stream.fromIterable([
            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `text-${requests.length}` }),
            ModelEvent.ModelEvent.TextDelta({
              type: "text-delta",
              id: `text-${requests.length}`,
              text: "```cell\n" + cell + "\n```"
            }),
            ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `text-${requests.length}` }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          ])
        })
    })

  const run = (contextWindowTokens: number) => {
    const requests: Array<unknown> = []
    return drive(
      collect({
        registry: registryOf([]),
        model: rambling(requests),
        contextWindowTokens,
        maxFrames: 5
      })
    ).then((outcome) => events(outcome).map((event) => event._tag))
  }

  it("compacts the crowded window when the seat reports a real budget", async () => {
    expect(await run(40_000)).toContain("compaction-settled")
  })

  it("disables compaction entirely when the seat reports zero", async () => {
    // Zero is `CellTurn`'s "compaction disabled", which is why
    // `SeatResolver.contextWindowTokensFor` never returns it: the same
    // crowded window goes to the provider untouched.
    expect(await run(0)).not.toContain("compaction-settled")
  })
})

describe("adapter prompt runner contracts", () => {
  it("exposes the underlying agent runner on both hosts", () => {
    expectTypeOf<AgentAction.Host["promptRunner"]>().toEqualTypeOf<Agent.Options["promptRunner"]>()
    expectTypeOf<AgentSession.Options["promptRunner"]>().toEqualTypeOf<Agent.Options["promptRunner"]>()
  })
})
