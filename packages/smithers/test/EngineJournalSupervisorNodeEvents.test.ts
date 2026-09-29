/**
 * The graph a real engine run drove, arriving in the CONTROL journal.
 *
 * The engine writes its node records into its own private journal, and the
 * supervisor is what relays that history to the control plane a monitor reads.
 * Nothing between the two knows what a node record is: the projection copies
 * an engine entry verbatim. This suite is the evidence that it does, that the
 * node ids that arrive are the ids the graph was built with, and that a plan
 * far too large for one journal entry crosses in pages with no gap.
 */
import { NodeCrypto } from "@effect/platform-node"
import type { RunSummary } from "@smthrs/control/ControlSchema"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Context, Effect, Layer, Schedule, Schema, Scope } from "effect"
import { describe, expect, it } from "vitest"
import * as Projection from "../src/internal/EngineJournalProjection.ts"
import * as Supervisor from "../src/internal/EngineJournalSupervisor.ts"

const Read = Action.make("supervised/read", { payload: { path: Schema.String }, success: Schema.Number })
const Double = Action.make("supervised/double", { payload: { value: Schema.Number }, success: Schema.Number })

/**
 * The supervisor supervises exactly one native shape: a run whose flow is
 * `agent/run` and whose payload names the control run's plan. Anything else
 * is refused as "not the control run's recorded wrapper", so a suite that
 * wants to be relayed wears that shape.
 */
const Chain = Flow.make("agent/run", {
  payload: { planId: Schema.String },
  success: Schema.Number,
  body: ({ planId }) =>
    Read.call({ path: planId }).pipe(
      Node.bindPlanned((value) => Double.call({ value })),
      Node.map((value) => value + 1)
    )
})

/** Four hundred leaves under bounded joins: many pages, each node fits. */
const Wide = Flow.make("agent/run", {
  payload: { planId: Schema.String },
  success: Schema.Number,
  body: () => {
    const groups: Record<string, Node.Node<Record<string, number>>> = {}
    for (let group = 0; group < 16; group++) {
      const members: Record<string, Node.Node<number>> = {}
      for (let index = 0; index < 25; index++) members[`member-${index}`] = Node.succeed(index)
      groups[`group-${group}`] = Node.all(members)
    }
    return Node.map(Node.all(groups), (joined) => Object.values(joined).length)
  }
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "supervised", changeId: "supervised" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const implementations = Layer.mergeAll(
  Read.toLayer(({ path }) => Effect.succeed(path.length)),
  Double.toLayer(({ value }) => Effect.succeed(value * 2))
)

const summary = (runId: string): RunSummary => ({
  runId,
  flowId: "agent/run",
  status: "running",
  planId: "supervised-plan",
  createdAt: 1,
  updatedAt: 1
})

const until = <A, E>(read: Effect.Effect<A, E>, ready: (value: A) => boolean) =>
  Effect.retry(
    read.pipe(Effect.flatMap((value) => ready(value) ? Effect.succeed(value) : Effect.fail("not observed yet"))),
    { times: 250, schedule: Schedule.spaced("20 millis") }
  ).pipe(Effect.timeout("10 seconds"))

/** One relayed engine entry, as the control journal carries it. */
interface Relayed {
  readonly eventType: string
  readonly payload: Record<string, unknown>
}

const relayed = (rows: ReadonlyArray<JournalEvent.Entry>): ReadonlyArray<Relayed> =>
  rows
    .filter((entry) => entry.eventType === Projection.eventKind)
    .map((entry) => entry.payload as { readonly eventType: string; readonly payload: Record<string, unknown> })
    .map((envelope) => ({ eventType: envelope.eventType, payload: envelope.payload }))

/** Drives one flow through a real engine over `native`, then relays it. */
const supervised = (
  flow: typeof Chain,
  payload: Record<string, unknown>,
  runId: string
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, unknown, Scope.Scope> =>
  Effect.gen(function*() {
    const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
    const destination = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
    const engineJournal = Context.get(native, Journal.Journal)
    const controlJournal = Context.get(destination, Journal.Journal)

    yield* Effect.gen(function*() {
      const engine = yield* EngineStore.make({
        owner: { hostId: "supervised-host" },
        journalSource: "supervised",
        isAlive: () => Effect.succeed(false)
      })
      const layer = Layer.mergeAll(implementations, Interpreter.layer(flow)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
      )
      yield* (flow as unknown as {
        execute: (input: unknown, options: { executionId: string }) => Effect.Effect<unknown, unknown>
      }).execute(payload, { executionId: runId }).pipe(Effect.provide(layer))
    }).pipe(
      Effect.provide(jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(native),
      Effect.orDie
    )

    const scope = yield* Scope.make()
    const supervisor = yield* Supervisor.make({
      engineJournal,
      controlJournal,
      engineState: Context.get(native, DurableEngineState.DurableEngineState),
      runs: Context.get(native, RunStore.RunStore),
      control: {
        getRun: () => Effect.succeed(summary(runId)),
        pageRunIds: () => Effect.succeed({ ids: [runId], through: 1 })
      }
    }).pipe(Effect.provideService(Scope.Scope, scope))
    yield* controlJournal.transact(supervisor.start(runId))
    const rows = yield* until(
      controlJournal.entries({ runId: runId as JournalEvent.RunId, limit: 4000 }).pipe(
        Effect.map((page) => page.entries)
      ),
      (entries) => entries.some((entry) => entry.eventType === Supervisor.settledKind)
    )
    yield* Scope.close(scope, { _tag: "Success", value: undefined } as never)
    return rows
  }).pipe(Effect.provide(NodeCrypto.layer))

describe("node records reaching the control journal", () => {
  it(
    "relays every node the run drove, under the ids the graph was built with",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const rows = yield* supervised(Chain, { planId: "supervised-plan" }, "supervised-run")
        const events = relayed(rows)
        const graph = Graph.build(Chain as never, { planId: "supervised-plan" })
        const ids = Graph.nodes(graph).map((node) => node.id).sort()

        const scheduled = events.filter((event) => event.eventType === "flows.engine.node-scheduled")
        const settled = events.filter((event) => event.eventType === "flows.engine.node-settled")
        expect(scheduled.map((event) => event.payload["nodeId"]).sort()).toEqual(ids)
        expect(settled.map((event) => event.payload["nodeId"]).sort()).toEqual(ids)
        expect(settled.every((event) => event.payload["outcome"] === "built")).toBe(true)

        const plan = events.filter((event) => event.eventType === "flows.engine.plan-recorded")
        expect(plan).toHaveLength(1)
        const recorded = plan[0]!.payload["graph"] as { readonly nodes: ReadonlyArray<Record<string, unknown>> }
        expect(recorded.nodes.map((node) => node["id"]).sort()).toEqual(ids)
        // Nothing is missing: a relayed history with a hole says so, and this
        // one has none.
        expect(rows.filter((entry) => entry.eventType === Projection.gapKind)).toEqual([])
      }))),
    60_000
  )

  it(
    "relays a plan too large for one entry as pages, with no gap",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const rows = yield* supervised(Wide, { planId: "supervised-plan" }, "supervised-wide")
        const events = relayed(rows)
        const pages = events.filter((event) =>
          event.eventType === "flows.engine.plan-recorded" || event.eventType === "flows.engine.subgraph-appended"
        )
        expect(pages.length).toBeGreaterThan(1)
        for (const page of pages) {
          // The relayed entry includes source ids, timestamps and bridge fields.
          expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
            Interpreter.maximumPageBytes + 4096
          )
        }
        // Assembled in page order. A node wider than one page is seated and
        // then continued, so the same id appears again carrying the next slice
        // of its dependency list (D-061); the graph is the union.
        const assembled = new Map<string, Array<string>>()
        for (const page of pages) {
          const graph = page.payload["graph"] as {
            readonly nodes: ReadonlyArray<{ readonly id: string; readonly dependsOn: ReadonlyArray<string> }>
          }
          for (const node of graph.nodes) {
            const held = assembled.get(node.id)
            if (held === undefined) assembled.set(node.id, [...node.dependsOn])
            else held.push(...node.dependsOn)
          }
        }
        const planned = Graph.nodes(Graph.build(Wide as never, { planId: "supervised-plan" }))
        expect([...assembled.keys()]).toEqual(planned.map((node) => node.id))
        for (const node of planned) expect(assembled.get(node.id)).toEqual([...node.dependencies])
        expect(rows.filter((entry) => entry.eventType === Projection.gapKind)).toEqual([])
      }))),
    60_000
  )
})
