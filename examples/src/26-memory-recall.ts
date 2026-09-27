/**
 * Store facts in one run and recall them in a later execution.
 *
 * Separate durable runs share the SQL memory store. `WithMemory.withMemory`
 * applies namespace, recall budget, and retention policy to a flow tree. The
 * handler source must use the annotated flow so those policies reach the store.
 *
 * The scenarios also exercise `recall: "none"` and `retain: "never"`. Recall
 * uses SQLite FTS5, enabled for the relevant namespace kind. A scripted model
 * keeps the example independent of provider access.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as MemoryFlows from "@smthrs/memory/Flows"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as RecallFts from "@smthrs/memory/RecallFts"
import * as WithMemory from "@smthrs/memory/WithMemory"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { durableEngine } from "./durable-layer.ts"

/** The bank this example's flow tree reads and writes. */
export const namespace = { kind: "flow", id: "release-notes" } as const

/** The bank name the namespace is spelled as at the recall boundary. */
export const bank: string = Recall.bankForNamespace(namespace)

/** The policy every run below carries, before a refusal overrides a field. */
export const basePolicy: WithMemory.Policy = {
  banks: [bank],
  maxTokens: 2048,
  retain: "on-complete"
}

/**
 * The two memory flows, bound under one policy, as a source a cell can call.
 *
 * This is the shape `Flows.handlersFor` documents and the reason it exists: the
 * declaration a host binds is the policy-carrying COPY, and the handler is
 * built from that same copy. `StandardFlows.memory` binds a different
 * `recall`: the bare declaration, filtered by Jev (`JudgedRecallOutput`), so it
 * needs a judge context and applies no policy.
 */
export const memorySource = (
  services: Context.Context<MemoryStore.MemoryStore | Recall.Recall>,
  policy: WithMemory.Policy
): FlowBinding.Source => {
  const remember = WithMemory.withMemory(MemoryFlows.remember, policy)
  const recall = WithMemory.withMemory(MemoryFlows.recall, policy)
  return FlowBinding.source("memory", [
    FlowBinding.provide(
      FlowBinding.make({ flow: remember, handler: MemoryFlows.handlersFor(remember).remember }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({ flow: recall, handler: MemoryFlows.handlersFor(recall).recall }),
      services
    )
  ])
}

/** What one notebook step must answer with. Nothing downstream parses prose. */
export const Reading = Schema.Struct({ keys: Schema.Array(Schema.String) })

/**
 * The step. Its prompt names the task, which is how a scripted model, and a
 * real one, learns whether this run is writing or reading.
 */
export const Notebook = AgentAction.make("examples/Notebook", {
  payload: { task: Schema.String, note: Schema.String },
  output: Reading,
  seat: "anthropic:claude-sonnet-4-5",
  system: [
    "You keep release notes. Write down what you learn, and look it up later rather than guessing."
  ],
  prompt: ({ note, task }) => `TASK: ${task}\nNOTE: ${note}`
})

/** The flow one run of the notebook step is. */
export const Keep = Flow.make("examples/Keep", {
  payload: { task: Schema.String, note: Schema.String },
  success: Reading,
  error: AgentAction.AgentFailure,
  body: (payload: { readonly task: string; readonly note: string }) => Notebook.call(payload)
})

/** The facts run 1 records. */
export const facts: ReadonlyArray<{ readonly key: string; readonly text: string }> = [
  { key: "changelog-format", text: "Release notes group entries by package, newest first." },
  { key: "release-cadence", text: "Release notes ship with every tagged release, never between." },
  { key: "review-owner", text: "The docs owner reviews the notes before the tag is pushed." }
]

const prepared: Route.PreparedRequest = {
  routeId: "examples",
  protocolId: "examples",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/** The cell body the model writes for one task. */
const cellFor = (task: string, note: string): string => {
  if (task === "record") {
    return [
      ...facts.map((fact) =>
        // Writes name a valid bank before the policy-scoped handler runs.
        `await ctx.call("remember", { bank: ${JSON.stringify(bank)}, key: ${JSON.stringify(fact.key)}, text: ${JSON.stringify(fact.text)} })`
      ),
      `ctx.done(JSON.stringify({ keys: ${JSON.stringify(facts.map((fact) => fact.key))} }))`
    ].join("\n")
  }
  if (task === "forget") {
    return [
      `const dropped = await ctx.call("remember", { bank: ${JSON.stringify(bank)}, key: "never-stored", text: ${JSON.stringify(note)} })`,
      "ctx.done(JSON.stringify({ keys: [dropped.key] }))"
    ].join("\n")
  }
  const banks = task === "foreign" ? ["flow-other-project"] : []
  return [
    // No banks and no budget for the scoped read: both come from the policy.
    `const rows = await ctx.call("recall", { banks: ${JSON.stringify(banks)}, query: ${JSON.stringify(note)} })`,
    "ctx.done(JSON.stringify({ keys: rows.map((row) => row.key) }))"
  ].join("\n")
}

/**
 * A scripted model that reads the task out of the request and answers with one
 * cell that uses the memory flows.
 *
 * The task is not baked in: it arrives in the prompt at run time, exactly as it
 * would for a provider, and the cell the model writes closes over what it read.
 */
export const scripted = (asked: Array<string>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const text = [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          )
        ].join("\n")
        const task = /TASK: (.+)/.exec(text)?.[1]?.trim() ?? ""
        const note = /NOTE: (.+)/.exec(text)?.[1]?.trim() ?? ""
        asked.push(task)
        const cell = cellFor(task, note)
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/** What six durable runs over one memory bank observed. */
export interface Summary {
  /** The keys the writing run recorded, in order. */
  readonly written: ReadonlyArray<string>
  /** The keys a LATER run recalled, having been handed nothing but the file. */
  readonly recalled: ReadonlyArray<string>
  /** What recall answered for a bank nothing was written to. */
  readonly foreign: ReadonlyArray<string>
  /** What a policy of `recall: "none"` answered. */
  readonly refusedRecall: ReadonlyArray<string>
  /** The key a policy of `retain: "never"` answered with, having stored nothing. */
  readonly droppedWriteKey: string | undefined
  /** Whether the dropped write left a row a later run can find. */
  readonly droppedWriteStored: boolean
  /** The tasks the model was asked to do, in run order. */
  readonly asked: ReadonlyArray<string>
  /** The distinct events the recalling run journalled. */
  readonly eventTypes: ReadonlyArray<string>
}

/**
 * Runs the notebook six times over one SQLite file.
 *
 * Each call is a separate durable execution: its own run row, its own journal,
 * its own frames. The only thing they share is the memory the store holds.
 */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const asked: Array<string> = []

    // The store and the FTS recall service, over the engine's own database.
    const stores = Layer.provideMerge(RecallFts.layer, Layer.orDie(MemoryStore.layer))
    const base = stores.pipe(Layer.provideMerge(durableEngine(filename, "examples-memory")))

    const seats = SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            modelId: Seat.modelIdOf(id),
            model: scripted(asked),
            route: { prepare: () => Effect.succeed(prepared) },
            contextWindowTokens: 200_000
          })
        )
    })

    const registry = Registry.makeNoop({
      list: () => Effect.succeed([]),
      visible: () => Effect.succeed([]),
      getOption: () => Effect.succeed(Option.none())
    })

    return yield* Effect.scoped(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        // FTS is enabled per namespace kind, by the store, once.
        yield* store.enableFts("flow")

        // The services the bindings run their handlers in. A host with a
        // different store composes a different context and the cell sees no
        // difference.
        const services = yield* Effect.context<MemoryStore.MemoryStore | Recall.Recall>()

        /** One durable run of the notebook, under one memory policy. */
        const run = (
          executionId: string,
          task: string,
          note: string,
          policy: WithMemory.Policy = basePolicy
        ) =>
          Keep.execute({ task, note }, { executionId }).pipe(
            Effect.provide(
              Layer.mergeAll(Notebook.layer, Interpreter.layer(Keep)).pipe(
                Layer.provideMerge(
                  Layer.mergeAll(
                    AgentAction.layerHost({
                      registry,
                      flows: [memorySource(services, policy)],
                      limits: { calls: 8 },
                      capabilityEnvelope: [],
                      maxFrames: 2
                    }),
                    seats,
                    Agent.layer
                  )
                ),
                // The scripted seat has no provider quota, and these offline
                // runs have no approved plan envelope to derive a ceiling.
                // eslint-disable-next-line no-restricted-syntax -- these offline runs have no approved envelope
                Layer.provideMerge(Layer.mergeAll(QuotaPolicy.layerUnclassified(), Budget.layerUnbounded())),
                Layer.provideMerge(Agent.layerDefaults),
                // The completion brake judges every claim, and never falls back to
                // the model. This example scripts the judge the way it scripts the
                // seat, so it still needs no key. A host with a resolved seat binds
                // `Evaluator.layerFromSeat(judgeSeat)` instead.
                Layer.provideMerge(
                  ScriptedJudge.layer
                ),
                Layer.provideMerge(Action.layerImplementations)
              )
            )
          )

        const written = yield* run("notes-1", "record", "the three release-note rules")
        const recalled = yield* run("notes-2", "recall", "release notes")
        // Bind the other namespace explicitly. A policy-scoped handler refuses
        // foreign banks; an empty-bank read must use that bank's own policy.
        const foreign = yield* run("notes-3", "foreign", "release notes", {
          ...basePolicy,
          banks: ["flow-other-project"]
        })
        const refused = yield* run("notes-4", "recall", "release notes", {
          ...basePolicy,
          recall: "none"
        })
        const dropped = yield* run("notes-5", "forget", "Release notes are written by hand.", {
          ...basePolicy,
          retain: "never"
        })
        const after = yield* run("notes-6", "recall", "hand")

        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: "notes-2" as JournalEvent.RunId, limit: 500 })

        return {
          written: written.keys,
          recalled: recalled.keys,
          foreign: foreign.keys,
          refusedRecall: refused.keys,
          droppedWriteKey: dropped.keys[0],
          droppedWriteStored: after.keys.includes("never-stored"),
          asked: [...asked],
          eventTypes: [...new Set(page.entries.map((entry) => entry.eventType))]
        } satisfies Summary
      }).pipe(Effect.provide(base))
    )
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer)),
    Effect.orDie
  )
