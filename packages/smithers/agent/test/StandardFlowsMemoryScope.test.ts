/**
 * Scoped model-facing memory, through the path an agent run dispatches.
 *
 * `StandardFlows.memory(services, scope)` is what a host composes when one
 * run may reach exactly one memory namespace, the way a role in a team keeps
 * its own memory. The refusal that matters is the one a model meets, so every
 * call here is a `ctx.call` from a cell that a real `Agent` run executes on
 * the real durable engine: the cell's call is resolved from the run's catalog,
 * keyed, journaled, and dispatched through `FlowBinding`, and the handler
 * behind it writes to and recalls from the authoritative SQL memory store
 * (`TestMemory`, in-memory SQLite) through keyword recall. Only the model is
 * recorded.
 *
 * The store and recall service are observed, not replaced: each keeps its
 * real behaviour and also writes down what reached it, which is how "refused
 * before any I/O" is shown rather than inferred from a result.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import { FlowEngine } from "@smthrs/engine"
import { Flow as EngineFlow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import { MemoryError } from "@smthrs/memory/MemoryError"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import type * as WithMemory from "@smthrs/memory/WithMemory"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as StandardFlows from "../src/StandardFlows.ts"
import * as Safety from "./Safety.ts"

type MemoryServices = MemoryStore.MemoryStore | Recall.Recall

/** A role's policy in the generic shape a host derives from its roster. */
const policyFor = (id: string, overrides: Partial<WithMemory.Policy> = {}): WithMemory.Policy => ({
  banks: [`agent-${id}`],
  maxTokens: 2048,
  ...overrides
})

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

/** A recorded model that replies with one cell per frame. */
const recorded = (cells: ReadonlyArray<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: () =>
      Stream.suspend(() => {
        const source = cells[index++] ?? cells.at(-1) ?? "ctx.done(\"done\")"
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

const emptyRegistry = Registry.makeNoop({
  list: () => Effect.succeed([]),
  visible: () => Effect.succeed([]),
  getOption: () => Effect.succeed(Option.none())
})

/**
 * One agent run whose only capabilities are the given flow sources.
 *
 * Each run states its own task. A model step is sealed and content-addressed
 * on the request, so two executions sending the same request would share one
 * recorded answer, and the second role would run the first role's cell.
 */
const run = (task: string, flows: ReadonlyArray<FlowBinding.Source>, cell: string) =>
  Effect.gen(function*() {
    const collected: Array<AgentEvent.AgentEvent> = []
    const agent = yield* Agent.Agent
    yield* agent.run({
      session: "session-1",
      seat: Seat.make({
        id: "anthropic:test-model",
        modelId: "test-model",
        model: recorded([cell]),
        route,
        contextWindowTokens: 0
      }),
      prompt: task,
      registry: emptyRegistry,
      capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
      flows,
      maxFrames: 3
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
      Effect.provide(Layer.merge(Agent.layerDefaults, scriptedCompletionJudge))
    )
    return collected
  }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))

type Outcome =
  | { readonly _tag: "completed"; readonly events: ReadonlyArray<AgentEvent.AgentEvent> }
  | { readonly _tag: "failed"; readonly error: unknown }

/** The one flow every execution below registers; its body is inert. */
const runFlow = EngineFlow.make("agent/test/memory-scope", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

type RunBody = Effect.Effect<
  ReadonlyArray<AgentEvent.AgentEvent>,
  unknown,
  Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
>

/**
 * Runs each body as its own execution of ONE durable engine, in order, over
 * ONE memory database, then hands the store to `inspect`. Sharing the engine
 * is what lets a sealed result recorded by one execution be offered to the
 * next, which is the cross-run path a scope must not open.
 */
const drive = <A>(
  plan: (services: Context.Context<MemoryServices>) => {
    readonly seed?: Effect.Effect<void, unknown, MemoryStore.MemoryStore>
    readonly runs: ReadonlyArray<readonly [executionId: string, body: RunBody]>
    readonly inspect: Effect.Effect<A, unknown, MemoryStore.MemoryStore>
  }
): Promise<{ readonly outcomes: ReadonlyArray<Outcome>; readonly inspected: A }> =>
  Effect.gen(function*() {
    const services = yield* Layer.build(RecallKeyword.layer.pipe(Layer.provideMerge(TestMemory.layer)))
    const { inspect, runs, seed } = plan(services)
    if (seed !== undefined) yield* Effect.provide(seed, services)
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const pending = new Map<string, { readonly body: RunBody; readonly settled: Deferred.Deferred<Outcome> }>()
    yield* engine.register(runFlow, (_payload, executionId) => {
      const entry = pending.get(executionId)!
      return Effect.onExit(entry.body, (exit) => {
        const outcome: Outcome = Exit.isSuccess(exit)
          ? { _tag: "completed", events: exit.value }
          : { _tag: "failed", error: Cause.squash(exit.cause) }
        return Effect.asVoid(Deferred.succeed(entry.settled, outcome))
      })
    }).pipe(Scope.provide(scope))
    const outcomes: Array<Outcome> = []
    for (const [executionId, body] of runs) {
      const settled = Deferred.makeUnsafe<Outcome>()
      pending.set(executionId, { body, settled })
      yield* engine.execute(runFlow, { executionId, payload: {}, discard: true })
      outcomes.push(yield* Deferred.await(settled))
    }
    return { outcomes, inspected: yield* Effect.provide(inspect, services) }
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer)),
    Effect.scoped,
    Effect.runPromise
  )

/**
 * The real store and recall service, each writing down what reached it. The
 * store behind keyword recall is the same real store, read directly.
 */
const observed = (
  services: Context.Context<MemoryServices>,
  reached: Array<string>
): Context.Context<MemoryServices> => {
  const store = Context.get(services, MemoryStore.MemoryStore)
  const recall = Context.get(services, Recall.Recall)
  const namespace = (input: MemoryStore.PutFactInput["namespace"]) =>
    typeof input === "string" ? input : Recall.bankForNamespace(input)
  return Context.make(
    MemoryStore.MemoryStore,
    MemoryStore.MemoryStore.of({
      ...store,
      putFact: (input) =>
        Effect.suspend(() => {
          reached.push(`putFact ${namespace(input.namespace)}/${input.key}`)
          return store.putFact(input)
        })
    })
  ).pipe(
    Context.add(
      Recall.Recall,
      Recall.Recall.of({
        recall: (input) =>
          Effect.suspend(() => {
            reached.push(`recall ${input.banks.join(",")}`)
            return recall.recall(input)
          })
      })
    )
  )
}

const seedFact = (bank: string, key: string, text: string) =>
  Effect.flatMap(MemoryStore.MemoryStore, (store) =>
    store.putFact({
      namespace: Recall.namespaceForBank(bank),
      key,
      value: { content: text },
      provenance: {}
    }))

const factText = (bank: string, key: string) =>
  Effect.flatMap(MemoryStore.MemoryStore, (store) =>
    Effect.map(
      store.getFact({ namespace: Recall.namespaceForBank(bank), key }),
      (fact) => fact === undefined ? undefined : (fact.value as { readonly content: string }).content
    ))

const eventsOf = (outcome: Outcome | undefined): ReadonlyArray<AgentEvent.AgentEvent> => {
  if (outcome?._tag !== "completed") throw new Error(`the run did not complete: ${JSON.stringify(outcome)}`)
  return outcome.events
}

const settledCalls = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  events.flatMap((event) => (event._tag === "cell-call-settled" ? [event] : []))

/** What the cell handed `ctx.done`, decoded from the run's resolved message. */
const doneValue = (events: ReadonlyArray<AgentEvent.AgentEvent>): unknown => {
  const resolved = events.find((event) => event._tag === "resolved")
  const content = resolved?._tag === "resolved" ? resolved.message.content : []
  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
  return JSON.parse(text)
}

/** One cell per role: its own bank first, then every foreign spelling. */
const builderCell = `const own = await ctx.call("recall", { banks: [], query: "plan" })
const attempt = async (flow, input) => {
  const result = await ctx.call(flow, input)
  return result.ok === false ? result.error.code + " " + result.error.message : "allowed"
}
const foreignWrite = await attempt("remember", { bank: "agent-checker", key: "plan", text: "overwritten by builder" })
const foreignRead = await attempt("recall", { banks: ["agent-checker"], query: "plan" })
const mixedRead = await attempt("recall", { banks: ["agent-builder", "agent-checker"], query: "plan" })
const otherKind = await attempt("recall", { banks: ["user-builder"], query: "plan" })
const unprefixed = await attempt("remember", { bank: "builder", key: "plan", text: "flow-local" })
const kept = await ctx.call("remember", { bank: "agent-builder", key: "next", text: "builder next: wire the plan" })
const named = await ctx.call("recall", { banks: ["agent-builder"], query: "plan" })
ctx.done(JSON.stringify({
  own: own.map((row) => row.bank + "/" + row.key),
  foreignWrite, foreignRead, mixedRead, otherKind, unprefixed,
  kept: kept.key,
  named: named.map((row) => row.bank + "/" + row.key).sort()
}))`

const checkerCell = `const own = await ctx.call("recall", { banks: [], query: "plan" })
ctx.done(JSON.stringify({ own: own.map((row) => row.bank + "/" + row.key + "=" + row.text) }))`

describe("StandardFlows.memory with a scope", () => {
  it("refuses every foreign bank before I/O and serves the policy bank, through an agent run", async () => {
    const reached: Array<string> = []
    const { inspected, outcomes } = await drive((services) => {
      const memory = observed(services, reached)
      return {
        seed: Effect.all([
          seedFact("agent-builder", "plan", "builder plan: ship the parser"),
          seedFact("agent-checker", "plan", "checker plan: review the parser")
        ]),
        runs: [
          [
            "exec-builder",
            run("keep the builder's plan", [
              StandardFlows.memory(memory, {
                policy: policyFor("builder"),
                provenance: { runId: "run-builder", nodeId: "role-task", iteration: 0 }
              })
            ], builderCell)
          ],
          [
            "exec-checker",
            run(
              "review the checker's plan",
              [StandardFlows.memory(memory, { policy: policyFor("checker") })],
              checkerCell
            )
          ]
        ],
        inspect: Effect.gen(function*() {
          const store = yield* MemoryStore.MemoryStore
          return {
            checkerPlan: yield* factText("agent-checker", "plan"),
            next: yield* store.getFact({ namespace: { kind: "agent", id: "builder" }, key: "next" }),
            flowLocal: yield* factText("builder", "plan")
          }
        })
      }
    })

    const builder = eventsOf(outcomes[0])
    const settled = settledCalls(builder)
    expect(settled.map((event) => [event.flowName, event.result.outcome])).toEqual([
      ["recall", "success"],
      ["remember", "failure"],
      ["recall", "failure"],
      ["recall", "failure"],
      ["recall", "failure"],
      ["remember", "failure"],
      ["remember", "success"],
      ["recall", "success"]
    ])
    const refusal =
      "invalid_namespace: memory bank is outside the policy namespace; this run's memory bank is agent-builder."
    for (const event of settled.filter((call) => call.result.outcome === "failure")) {
      expect(event.result.code).toBe(Cell.defaultCallFailureCode)
      expect(event.result.message).toBe(`Flow ${event.flowName} failed: ${refusal}`)
    }
    expect(doneValue(builder)).toEqual({
      own: ["agent-builder/plan"],
      foreignWrite: `flow_failed Flow remember failed: ${refusal}`,
      foreignRead: `flow_failed Flow recall failed: ${refusal}`,
      mixedRead: `flow_failed Flow recall failed: ${refusal}`,
      otherKind: `flow_failed Flow recall failed: ${refusal}`,
      unprefixed: `flow_failed Flow remember failed: ${refusal}`,
      kept: "next",
      named: ["agent-builder/next", "agent-builder/plan"]
    })

    // Nothing foreign reached the store or recall: the only I/O is the
    // policy bank's, and a recall that named no bank read the policy bank.
    expect(reached).toEqual([
      "recall agent-builder",
      "putFact agent-builder/next",
      "recall agent-builder",
      "recall agent-checker"
    ])
    expect(inspected.checkerPlan).toBe("checker plan: review the parser")
    expect(inspected.flowLocal).toBeUndefined()
    expect(inspected.next?.value).toEqual({ content: "builder next: wire the plan" })
    expect(inspected.next?.provenance).toEqual({ runId: "run-builder", nodeId: "role-task", iteration: 0 })

    // The checker's identical first call is not answered from the builder's
    // recorded, sealed recall: it reads its own bank and nothing else.
    expect(doneValue(eventsOf(outcomes[1]))).toEqual({
      own: ["agent-checker/plan=checker plan: review the parser"]
    })
  })

  it("honours recall none and retain never without touching the store", async () => {
    const reached: Array<string> = []
    const { inspected, outcomes } = await drive((services) => ({
      seed: seedFact("agent-builder", "plan", "builder plan: ship the parser"),
      runs: [[
        "exec-quiet",
        run(
          "draft quietly",
          [
            StandardFlows.memory(observed(services, reached), {
              policy: policyFor("builder", { recall: "none", retain: "never" })
            })
          ],
          `const kept = await ctx.call("remember", { bank: "agent-builder", key: "draft", text: "not kept" })
const own = await ctx.call("recall", { banks: [], query: "plan" })
const named = await ctx.call("recall", { banks: ["agent-builder"], query: "plan" })
const foreign = await ctx.call("recall", { banks: ["agent-checker"], query: "plan" })
ctx.done(JSON.stringify({ kept: kept.key, own, named, foreign }))`
        )
      ]],
      inspect: factText("agent-builder", "draft")
    }))

    // `recall: "none"` answers no rows before any bank is resolved, and
    // `retain: "never"` answers the key without writing: both as
    // `@smthrs/memory` defines them, so neither reached the store.
    expect(doneValue(eventsOf(outcomes[0]))).toEqual({ kept: "draft", own: [], named: [], foreign: [] })
    expect(reached).toEqual([])
    expect(inspected).toBeUndefined()
  })

  it("leaves the unscoped binding able to reach any bank a call names", async () => {
    const reached: Array<string> = []
    const { inspected, outcomes } = await drive((services) => ({
      seed: seedFact("agent-checker", "plan", "checker plan: review the parser"),
      runs: [[
        "exec-unscoped",
        run(
          "read another bank",
          [StandardFlows.memory(observed(services, reached), StandardFlows.hostWide)],
          `const read = await ctx.call("recall", { banks: ["agent-checker"], query: "plan" })
const kept = await ctx.call("remember", { bank: "agent-checker", key: "plan", text: "overwritten" })
ctx.done(JSON.stringify({ read: read.map((row) => row.text), kept: kept.key }))`
        )
      ]],
      inspect: factText("agent-checker", "plan")
    }))

    expect(doneValue(eventsOf(outcomes[0]))).toEqual({ read: ["checker plan: review the parser"], kept: "plan" })
    expect(reached).toEqual(["recall agent-checker", "putFact agent-checker/plan"])
    expect(inspected).toBe("overwritten")
  })

  it("answers each run's recall from the store, not from an earlier run's record", async () => {
    const reached: Array<string> = []
    const cell = `const rows = await ctx.call("recall", { banks: [], query: "plan" })
ctx.done(JSON.stringify(rows.map((row) => row.text)))`
    const { outcomes } = await drive((services) => {
      const memory = observed(services, reached)
      const scoped = (runId: string) =>
        StandardFlows.memory(memory, { policy: policyFor("builder"), provenance: { runId } })
      return {
        seed: seedFact("agent-builder", "plan", "first plan"),
        runs: [
          ["exec-1", run("recall the plan", [scoped("run-1")], cell)],
          [
            "exec-2",
            Effect.andThen(
              Effect.provide(seedFact("agent-builder", "plan", "second plan"), services),
              run("recall the plan", [scoped("run-2")], cell)
            )
          ]
        ],
        inspect: Effect.void
      }
    })

    // Both runs sent the same recall. The second one reached the store and
    // read the fact as it stands, rather than the first run's sealed record.
    expect(outcomes.map((outcome) => doneValue(eventsOf(outcome)))).toEqual([["first plan"], ["second plan"]])
    expect(reached).toEqual(["recall agent-builder", "recall agent-builder"])
  })

  it("reports a store failure under a scope with its code first", async () => {
    const failing = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
      Context.add(
        Recall.Recall,
        Recall.Recall.of({ recall: () => Effect.fail(RecallUnavailable) })
      )
    )
    const binding = (await Effect.runPromise(
      FlowBinding.catalog([StandardFlows.memory(failing, { policy: policyFor("builder") })])
    )).bindings.get("recall")!
    const result = await Effect.runPromise(binding.run(callOf(binding, { banks: [], query: "plan" })))
    expect(result).toMatchObject({
      outcome: "failure",
      message: "Flow recall failed: store: memory recall is unavailable"
    })
  })
})

const RecallUnavailable = new MemoryError({ code: "store", message: "memory recall is unavailable" })

/** A call the controller would build for this binding, for the direct-dispatch cases. */
const callOf = (binding: FlowBinding.Binding, input: Schema.Json): Cell.Call =>
  Cell.callOf(binding.descriptor, {
    input,
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: Cell.declarationDigest(binding.descriptor),
      layers: []
    })
  })

describe("StandardFlows.memory scope identity", () => {
  const services = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
    Context.add(Recall.Recall, Recall.makeNoop())
  )
  const digests = (source: FlowBinding.Source) =>
    Effect.runPromise(
      Effect.map(FlowBinding.catalog([source]), (catalog) =>
        catalog.descriptors.map((descriptor) =>
          [descriptor.name, Cell.declarationDigest(descriptor)] as const
        ))
    )

  it("binds the same two flows, with one declaration identity per policy and run", async () => {
    const run1 = { runId: "run-1", nodeId: "role-task", iteration: 0 }
    const unscoped = await digests(StandardFlows.memory(services, StandardFlows.hostWide))
    const builder = await digests(StandardFlows.memory(services, { policy: policyFor("builder"), provenance: run1 }))
    // The same coordinates in another key order are the same scope.
    const resumed = await digests(
      StandardFlows.memory(services, {
        policy: policyFor("builder"),
        provenance: { iteration: 0, nodeId: "role-task", runId: "run-1" }
      })
    )
    const nextRun = await digests(
      StandardFlows.memory(services, { policy: policyFor("builder"), provenance: { ...run1, runId: "run-2" } })
    )
    const checker = await digests(StandardFlows.memory(services, { policy: policyFor("checker"), provenance: run1 }))
    const quiet = await digests(
      StandardFlows.memory(services, { policy: policyFor("builder", { recall: "none" }), provenance: run1 })
    )
    const unplaced = await digests(StandardFlows.memory(services, { policy: policyFor("builder") }))
    const odd = await digests(
      StandardFlows.memory(services, { policy: policyFor("builder"), provenance: { iteration: Number.NaN } })
    )

    const scoped = [unscoped, builder, nextRun, checker, quiet, unplaced]
    for (const catalog of [...scoped, odd]) {
      expect(catalog.map(([name]) => name)).toEqual(["remember", "recall"])
    }
    // Stable for one scope, so a resumed run replays its own calls; distinct
    // across policies, runs and the unscoped binding, so no recorded call is
    // offered to a composition with other memory authority or another run.
    expect(resumed).toEqual(builder)
    // A non-finite iteration is no coordinate at all; it composes, as none.
    expect(odd).toEqual(unplaced)
    for (const index of [0, 1]) {
      expect(new Set(scoped.map((catalog) => catalog[index]![1])).size).toBe(scoped.length)
    }
  })

  it("binds nothing and fails composition when the policy does not decode", async () => {
    for (
      const policy of [
        policyFor("builder", { maxTokens: -1 }),
        { ...policyFor("builder"), banks: [""] },
        { ...policyFor("builder"), recall: "sometimes" as unknown as "none" },
        { ...policyFor("builder"), retain: "on-complete" as unknown as "never" }
      ]
    ) {
      const error = await Effect.runPromise(
        Effect.flip(FlowBinding.catalog([StandardFlows.memory(services, { policy })]))
      )
      expect(error).toBeInstanceOf(HarnessError)
      expect(error.code).toBe("assembly_failed")
      expect(error.message).toBe("The memory scope's policy is invalid, so no memory flows were bound.")
    }
  })

  // An untyped caller that names no scope gets no memory flows, never the
  // host-wide pair: only `StandardFlows.hostWide` binds every bank.
  it("binds nothing when a composition names no scope", async () => {
    const judge = Effect.runSync(
      Effect.provide(Effect.context<Evaluator.Evaluator>(), Evaluator.layerUnavailable())
    )
    for (
      const source of [
        (StandardFlows.memory as (...args: ReadonlyArray<unknown>) => FlowBinding.Source)(services),
        (StandardFlows.memory as (...args: ReadonlyArray<unknown>) => FlowBinding.Source)(
          services,
          judge
        )
      ]
    ) {
      const error = await Effect.runPromise(Effect.flip(FlowBinding.catalog([source])))
      expect(error).toBeInstanceOf(HarnessError)
      expect(error.code).toBe("assembly_failed")
      expect(error.message).toBe("The memory flows name no scope, so none were bound.")
    }
  })
})

describe("StandardFlows.memory capabilities", () => {
  it("allows granted reads while refusing writes and private reads before I/O", async () => {
    const reached: Array<string> = []
    const services = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
      Context.add(Recall.Recall, Recall.makeNoop())
    )
    const catalog = await Effect.runPromise(
      FlowBinding.catalog([StandardFlows.memory(observed(services, reached), StandardFlows.hostWide)])
    )
    const read = catalog.bindings.get("recall")!
    const write = catalog.bindings.get("remember")!
    const ceiling = [new Capability.CapabilityPattern({ action: "memory:read", resource: "global-team" })]
    const dispatch = (binding: FlowBinding.Binding, input: Schema.Json) =>
      Effect.runPromise(
        binding.run(callOf(binding, input)).pipe(CapabilitySet.attenuate(ceiling))
      )
    await dispatch(read, { banks: ["global-team"], query: "plan" })
    expect(reached).toEqual(["recall global-team"])
    expect(await dispatch(write, { bank: "global-team", key: "x", text: "private" })).toMatchObject({
      outcome: "failure"
    })
    expect(await dispatch(read, { banks: ["user-will"], query: "plan" })).toMatchObject({ outcome: "failure" })
    expect(reached).toEqual(["recall global-team"])
  })
})
