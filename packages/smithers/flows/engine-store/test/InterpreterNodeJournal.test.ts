/**
 * The graph a real engine run was driven from, in the real journal.
 *
 * The interpreter builds node records; this suite is the evidence that the
 * durable store turns them into journal rows, that a resumed walk collapses
 * onto the rows the first walk wrote instead of doubling every node, and that
 * a node served entirely from durable records settles `clean` rather than
 * claiming it rebuilt anything.
 */
import { Action, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise } from "./Sha256.ts"

const Read = Action.make("node-journal/read", {
  payload: { path: Schema.String },
  success: Schema.Number,
  // Keyed and versioned, so the record one run writes addresses the same
  // content the next run's dispatch asks for. A keyless sealed action is
  // keyed by its invocation, and a second run never finds its row.
  idempotencyKey: "node-journal-read-v1",
  implementationVersion: "1",
  // A hard boundary with a resolved read set is what makes a completion
  // publishable to the shared step cache; without one the engine refuses
  // `missing-boundary` and a second run has nothing to replay from.
  fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" }
})
const Double = Action.make("node-journal/double", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  idempotencyKey: "node-journal-double-v1",
  implementationVersion: "1",
  fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" }
})

const Chain = Flow.make("node-journal/chain", {
  payload: { path: Schema.String },
  success: Schema.Number,
  body: ({ path }) =>
    Read.call({ path }).pipe(
      Node.bindPlanned((value) => Double.call({ value })),
      Node.map((value) => value + 1)
    )
})

const gate = DurableDeferred.make("node-journal-gate", { success: Schema.Number })
const Ask = Action.make("node-journal/ask", {
  payload: {},
  success: Schema.Number,
  tier: "irreversible",
  idempotencyKey: "node-journal-ask"
})
const Parking = Flow.make("node-journal/parking", {
  payload: {},
  success: Schema.Number,
  body: () =>
    Ask.call({}).pipe(
      Node.bindPlanned((value) => Double.call({ value })),
      Node.map((value) => value + 1)
    )
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "test", changeId: "test" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const implementations = Layer.mergeAll(
  Read.toLayer(({ path }) => Effect.succeed(path.length), { implementationVersion: "1" }),
  Double.toLayer(({ value }) => Effect.succeed(value * 2), { implementationVersion: "1" })
)

const parkingImplementations = Layer.mergeAll(
  implementations,
  Ask.toLayer(() => DurableDeferred.await(gate))
)

/** One node record as this suite reads it back. */
interface NodeRow {
  readonly eventType: string
  readonly sourceId: string
  readonly payload: Record<string, unknown>
}

/** Waits, on the real clock, for the resumed run to reach its terminal row. */
const settledRun = (runs: RunStore.Service, runId: string) =>
  Effect.gen(function*() {
    let row = yield* runs.get(runId)
    for (let attempt = 0; attempt < 400 && (row.status === "suspended" || row.status === "running"); attempt++) {
      yield* Effect.sleep("10 millis")
      row = yield* runs.get(runId)
    }
    return row
  })

/** Every node record the journal holds for one run, oldest first. */
const nodeRows = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 })
    return page.entries
      .filter((entry) => entry.eventType.startsWith("flows.engine.node-") || entry.eventType.endsWith("-recorded"))
      .map((entry): NodeRow => ({
        eventType: entry.eventType,
        sourceId: entry.sourceId,
        payload: entry.payload as Record<string, unknown>
      }))
  })

it("journals the graph and one scheduled/settled pair per node of a real run", async () => {
  const chainRoot = await mkdtemp(join(tmpdir(), "smithers-node-journal-chain-"))
  try {
    const rows = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "node-journal" },
          journalSource: "node-journal-test",
          isAlive: () => Effect.succeed(false)
        })
        const layer = Layer.mergeAll(implementations, Interpreter.layer(Chain)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        yield* Chain.execute({ path: "abcd" }, { executionId: "chain-run" }).pipe(Effect.provide(layer))
        return yield* nodeRows("chain-run")
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(chainRoot, "state.sqlite")))
      )
    )

    const recorded = rows.filter((row) => row.eventType === "flows.engine.plan-recorded")
    expect(recorded).toHaveLength(1)
    const graph = recorded[0]!.payload["graph"] as { nodes: Array<Record<string, unknown>> }
    expect(graph.nodes.length).toBe(recorded[0]!.payload["nodes"])
    expect(recorded[0]!.payload["flow"]).toBe("node-journal/chain")

    const scheduled = rows.filter((row) => row.eventType === "flows.engine.node-scheduled")
    const settled = rows.filter((row) => row.eventType === "flows.engine.node-settled")
    expect(scheduled.map((row) => row.payload["nodeId"]).sort())
      .toEqual(graph.nodes.map((node) => node["id"]).sort())
    expect(settled.map((row) => row.payload["nodeId"]).sort())
      .toEqual(graph.nodes.map((node) => node["id"]).sort())
    expect(settled.every((row) => row.payload["outcome"] === "built")).toBe(true)
    expect(scheduled.filter((row) => row.payload["action"] !== undefined).map((row) => row.payload["action"]).sort())
      .toEqual(["node-journal/chain", "node-journal/double", "node-journal/read"])
  } finally {
    await rm(chainRoot, { recursive: true, force: true })
  }
})

it("holds one row per node across a park and a resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-node-journal-"))
  try {
    const observed = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const makeEngine = EngineStore.make({
          owner: { hostId: "node-journal-parking" },
          journalSource: "node-journal-test",
          isAlive: () => Effect.succeed(false)
        })
        const first = yield* Scope.make()
        const engine: FlowRuntime.FlowRuntime["Service"] = yield* makeEngine.pipe(
          Effect.provideService(Scope.Scope, first)
        )
        const layer = Layer.mergeAll(parkingImplementations, Interpreter.layer(Parking)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        // The registration lives as long as the layer's scope, and the resumed
        // walk needs it: an engine that cannot find the flow leaves the run
        // parked forever, which is a harness bug and not the behaviour here.
        const observedRun = yield* Effect.gen(function*() {
          yield* Parking.execute({}, { executionId: "parking-run", discard: true })
          const runs = yield* RunStore.RunStore
          const parked = (yield* runs.get("parking-run")).status
          const duringPark = yield* nodeRows("parking-run")

          yield* engine.deferredDone(gate, {
            flowName: Parking._tag,
            executionId: "parking-run",
            deferredName: gate.name,
            exit: Exit.succeed(4)
          })
          const settledRow = yield* settledRun(runs, "parking-run")
          const afterResume = yield* nodeRows("parking-run")
          return { parked, duringPark, status: settledRow.status, afterResume }
        }).pipe(Effect.provide(layer))
        yield* Scope.close(first, Exit.void)
        return observedRun
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
        Effect.orDie
      )
    )

    expect(observed.parked).toBe("suspended")
    expect(observed.status).toBe("completed")
    // The walk that parked already announced four of the five nodes. The
    // resumed walk re-derives every one of them, so without a replay-stable
    // identity the journal would hold nine schedules for a five-node graph.
    const scheduledDuringPark = observed.duringPark.filter((row) => row.eventType === "flows.engine.node-scheduled")
    expect(scheduledDuringPark).toHaveLength(4)
    const scheduled = observed.afterResume.filter((row) => row.eventType === "flows.engine.node-scheduled")
    const settled = observed.afterResume.filter((row) => row.eventType === "flows.engine.node-settled")
    expect(scheduled).toHaveLength(5)
    expect(settled).toHaveLength(5)
    expect(new Set(scheduled.map((row) => row.payload["nodeId"])).size).toBe(5)
    expect(new Set(settled.map((row) => row.payload["nodeId"])).size).toBe(5)
    // The rows the first walk wrote are the rows that survive: a resumed
    // observation collapses onto them rather than replacing them.
    for (const row of scheduledDuringPark) {
      expect(scheduled.find((after) => after.sourceId === row.sourceId)?.payload).toEqual(row.payload)
    }
    // And the plan is recorded once, not once per walk.
    expect(observed.afterResume.filter((row) => row.eventType === "flows.engine.plan-recorded")).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("settles a second run's cached nodes clean, and the first run's built", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-node-journal-clean-"))
  const ran: Array<string> = []
  try {
    const rows = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "node-journal-clean" },
          journalSource: "node-journal-test",
          isAlive: () => Effect.succeed(false)
        })
        const layer = Layer.mergeAll(
          Read.toLayer(({ path }) =>
            Effect.sync(() => {
              ran.push("read")
              return path.length
            }), { implementationVersion: "1" }),
          Double.toLayer(({ value }) =>
            Effect.sync(() => {
              ran.push("double")
              return value * 2
            }), { implementationVersion: "1" }),
          Interpreter.layer(Chain)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          // Without a declared cache environment a sealed key folds in the
          // run id, so no second run can address the first run's row: the
          // environment identity is what makes the key cross-run.
          Layer.provideMerge(Action.layerCacheEnvironment({ layers: [], capabilities: {} })),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        return yield* Effect.gen(function*() {
          yield* Chain.execute({ path: "abcd" }, { executionId: "clean-first" })
          const first = yield* nodeRows("clean-first")
          yield* Chain.execute({ path: "abcd" }, { executionId: "clean-second" })
          const second = yield* nodeRows("clean-second")
          return { first, second }
        }).pipe(Effect.provide(layer))
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
        Effect.orDie
      )
    )

    // The bodies ran once, for the first run. The second run's dispatches
    // were served from the records the first run wrote.
    expect(ran).toEqual(["read", "double"])
    const outcomes = (recorded: ReadonlyArray<NodeRow>) =>
      Object.fromEntries(
        recorded
          .filter((row) => row.eventType === "flows.engine.node-settled")
          .map((row) => [row.payload["nodeId"], row.payload["outcome"]])
      )
    const first = outcomes(rows.first)
    expect(Object.values(first).every((outcome) => outcome === "built")).toBe(true)
    const second = outcomes(rows.second)
    // Exactly the nodes that dispatch an action are clean. A node that
    // dispatches nothing — a map, a join, the flow call itself — recomputed
    // its own value and says `built`, because it did.
    const dispatching = rows.second
      .filter((row) => row.eventType === "flows.engine.node-scheduled" && row.payload["kind"] === "ActionCall")
      .map((row) => row.payload["nodeId"] as string)
    expect(dispatching.length).toBeGreaterThan(0)
    for (const nodeId of Object.keys(second)) {
      expect(second[nodeId]).toBe(dispatching.includes(nodeId) ? "clean" : "built")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * The step whose first attempt fails, so the run has a node with two real
 * attempts under one dispatch key.
 */
const Flaky = Action.make("node-journal/flaky", {
  payload: {},
  success: Schema.Number,
  error: Schema.String,
  retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 })
})

/** The step whose result carries a credential the journal must not keep. */
const Secretive = Action.make("node-journal/secretive", {
  payload: {},
  success: Schema.Struct({ apiKey: Schema.String, region: Schema.String })
})

const Joined = Flow.make("node-journal/joined", {
  payload: {},
  success: Schema.Number,
  error: Schema.String,
  body: () =>
    Node.all({ retried: Flaky.call({}), secret: Secretive.call({}) }).pipe(
      Node.map((members: { readonly retried: number; readonly secret: { readonly region: string } }) =>
        members.retried + members.secret.region.length
      )
    )
})

/** Every attempt record the journal holds for one run, oldest first. */
const attemptRows = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.attempt-started")
      .map((entry) => entry.payload as Record<string, unknown>)
  })

it("joins every attempt record to the plan node that dispatched it", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-node-journal-join-"))
  let dispatches = 0
  try {
    const observed = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "node-journal-join" },
          journalSource: "node-journal-test",
          isAlive: () => Effect.succeed(false)
        })
        const layer = Layer.mergeAll(
          Flaky.toLayer(() =>
            Effect.suspend(() => ++dispatches === 1 ? Effect.fail("the first attempt fails") : Effect.succeed(7))
          ),
          Secretive.toLayer(() => Effect.succeed({ apiKey: "sk-live-abcdefgh12345678", region: "us-east-1" })),
          Interpreter.layer(Joined)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        return yield* Effect.gen(function*() {
          yield* Joined.execute({}, { executionId: "join-run" })
          return { nodes: yield* nodeRows("join-run"), attempts: yield* attemptRows("join-run") }
        }).pipe(Effect.provide(layer))
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
        Effect.orDie
      )
    )

    const settled = observed.nodes.filter((row) => row.eventType === "flows.engine.node-settled")
    const digestsOf = (row: NodeRow) => (row.payload["stepKeyDigests"] ?? []) as ReadonlyArray<string>

    // THE JOIN. Every attempt row names a step key digest and no node id, and
    // every one of those digests is now claimed by exactly one plan node, so
    // "attempt 2 of node X" is derivable from the two records together.
    expect(observed.attempts.length).toBeGreaterThan(0)
    const claimed = new Map<string, string>()
    for (const row of settled) {
      for (const digest of digestsOf(row)) claimed.set(digest, row.payload["nodeId"] as string)
    }
    for (const attempt of observed.attempts) {
      expect(claimed.get(String(attempt["stepKeyDigest"]))).toEqual(expect.any(String))
    }

    // A node that dispatches nothing claims no digest, so the join never
    // attributes a dispatch to a map or a join node.
    const dispatching = new Set(
      observed.nodes
        .filter((row) => row.eventType === "flows.engine.node-scheduled" && row.payload["kind"] === "ActionCall")
        .map((row) => row.payload["nodeId"] as string)
    )
    for (const row of settled) {
      expect(digestsOf(row).length > 0).toBe(dispatching.has(row.payload["nodeId"] as string))
    }

    // THE REAL ATTEMPT COUNT. The retried node ran twice under one dispatch
    // key; its settlement says two, and the attempt rows under its digest
    // agree.
    const retried = settled.find((row) => row.payload["action"] === "node-journal/flaky")!
    expect(retried.payload["attempts"]).toBe(2)
    const retriedDigest = digestsOf(retried)[0]
    expect(observed.attempts.filter((attempt) => attempt["stepKeyDigest"] === retriedDigest).map((a) => a["attempt"]))
      .toEqual([1, 2])
    // A node that never retried still says one.
    const secretive = settled.find((row) => row.payload["action"] === "node-journal/secretive")!
    expect(secretive.payload["attempts"]).toBe(1)

    // THE BOUNDED RESULT. A built node carries what it settled with, and the
    // journal's own redactor has already scrubbed the credential out of it.
    const result = secretive.payload["result"] as { readonly preview: string; readonly bytes: number }
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.preview).toContain("us-east-1")
    expect(result.preview).not.toContain("sk-live-abcdefgh12345678")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * A graph with an arm that settles before the other one parks, so the resumed
 * walk re-observes a node it already recorded.
 */
const Beside = Flow.make("node-journal/beside", {
  payload: { path: Schema.String },
  success: Schema.Number,
  body: ({ path }) =>
    Node.all({ ready: Read.call({ path }), parked: Ask.call({}) }).pipe(
      Node.map((members: { readonly ready: number; readonly parked: number }) => members.ready + members.parked)
    )
})

it("keeps the settlement the first walk wrote when the resumed walk observes another", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-node-journal-beside-"))
  let reads = 0
  try {
    const observed = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "node-journal-beside" },
          journalSource: "node-journal-test",
          isAlive: () => Effect.succeed(false)
        })
        const layer = Layer.mergeAll(
          Read.toLayer(({ path }) =>
            Effect.sync(() => {
              reads = reads + 1
              return path.length
            }), { implementationVersion: "1" }),
          Double.toLayer(({ value }) => Effect.succeed(value * 2), { implementationVersion: "1" }),
          Ask.toLayer(() => DurableDeferred.await(gate)),
          Interpreter.layer(Beside)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        return yield* Effect.gen(function*() {
          yield* Beside.execute({ path: "abcd" }, { executionId: "beside-run", discard: true })
          const runs = yield* RunStore.RunStore
          const duringPark = yield* nodeRows("beside-run")
          yield* engine.deferredDone(gate, {
            flowName: Beside._tag,
            executionId: "beside-run",
            deferredName: gate.name,
            exit: Exit.succeed(4)
          })
          const settledRow = yield* settledRun(runs, "beside-run")
          return { duringPark, status: settledRow.status, afterResume: yield* nodeRows("beside-run") }
        }).pipe(Effect.provide(layer))
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
        Effect.orDie
      )
    )

    expect(observed.status).toBe("completed")
    const settlementsOf = (rows: ReadonlyArray<NodeRow>) =>
      rows.filter((row) => row.eventType === "flows.engine.node-settled")
    const parked = settlementsOf(observed.duringPark)
    // The arm that needed no wait settled before the other one parked, and it
    // carries a dispatch's own evidence: a step key, an attempt and a result.
    const readRow = parked.find((row) => row.payload["action"] === "node-journal/read")!
    expect(readRow.payload["outcome"]).toBe("built")
    expect((readRow.payload["stepKeyDigests"] as ReadonlyArray<string>).length).toBe(1)
    expect(readRow.payload["result"]).toEqual({ preview: "4", bytes: 1, truncated: false })

    // The resumed walk re-dispatches it and the durable record answers — the
    // body ran once across both walks — so what the second walk OBSERVES is a
    // node that rebuilt nothing. Exactly-once is that the first row stands:
    // one settlement per node, and it is the one the walk that did the work
    // wrote.
    expect(reads).toBe(1)
    const resumed = settlementsOf(observed.afterResume)
    expect(resumed.filter((row) => row.sourceId === readRow.sourceId)).toHaveLength(1)
    expect(resumed.find((row) => row.sourceId === readRow.sourceId)?.payload).toEqual(readRow.payload)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("keeps every Unicode plan page within the encoded entry budget exactly once across resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-paged-resume-"))
  const runId = "paged-" + "界".repeat(100)
  const Paged = Flow.make("node-journal/paged", {
    payload: {},
    success: Schema.Number,
    body: () => {
      const members: Record<string, Node.Node<number>> = {}
      for (let index = 0; index < 24; index++) {
        members[`界😀${"語".repeat(12)}-${index}`] = Node.succeed(index)
      }
      return Node.all({ values: Node.all(members), gate: Ask.call({}) }).pipe(
        Node.map(({ values }) => Object.keys(values).length)
      )
    }
  })
  try {
    await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "paged-resume" },
          journalSource: "源".repeat(800),
          isAlive: () => Effect.succeed(false)
        })
        const layer = Layer.mergeAll(parkingImplementations, Interpreter.layer(Paged)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        yield* Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const runs = yield* RunStore.RunStore
          const pages = () =>
            journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 }).pipe(
              Effect.map((result) =>
                result.entries.filter((entry) =>
                  entry.eventType === "flows.engine.plan-recorded" ||
                  entry.eventType === "flows.engine.subgraph-appended"
                )
              )
            )
          yield* Paged.execute({}, { executionId: runId, discard: true })
          expect((yield* runs.get(runId)).status).toBe("suspended")
          const before = yield* pages()
          for (const page of before) {
            expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
              Interpreter.maximumPageBytes
            )
          }
          expect(before.length).toBeGreaterThan(1)
          // Assembled in page order. A node wider than one page is seated and
          // then continued, so the same id appears again with the next slice
          // of its dependency list; the graph is the union.
          const assembled = new Map<string, Array<string>>()
          for (const entry of before) {
            const graph = (entry.payload as {
              graph: { nodes: Array<{ id: string; dependsOn: ReadonlyArray<string> }> }
            }).graph
            for (const node of graph.nodes) {
              const held = assembled.get(node.id)
              if (held === undefined) assembled.set(node.id, [...node.dependsOn])
              else held.push(...node.dependsOn)
            }
          }
          const planned = Graph.nodes(Graph.build(Paged, {}))
          expect([...assembled.keys()]).toEqual(planned.map((node) => node.id))
          for (const node of planned) expect(assembled.get(node.id)).toEqual([...node.dependencies])
          yield* engine.deferredDone(gate, {
            flowName: Paged._tag,
            executionId: runId,
            deferredName: gate.name,
            exit: Exit.succeed(4)
          })
          expect((yield* settledRun(runs, runId)).status).toBe("completed")
          expect(yield* pages()).toEqual(before)
          expect(new Set(before.map((page) => page.sourceId)).size).toBe(before.length)
        }).pipe(Effect.provide(layer))
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(root, "state.sqlite")))
      )
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/*
 * The width a caller chooses, not the width a page happens to hold.
 *
 * `flows/wiki` fans out over an input-sized list, so a fan-in of any width is
 * something a host really records. The node's summary, its dependency list and
 * the thousand edges that end on it are spread over as many pages as they
 * need, measured through the DURABLE envelope — the redacted journal entry
 * this store writes, not an in-memory guess — and the run still parks and
 * resumes onto the rows the first walk wrote.
 */
it("pages a thousand-way fan-in through the durable envelope, once across resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-fan-in-"))
  const runId = "fan-in-run"
  const Wide = Flow.make("node-journal/fan-in", {
    payload: {},
    success: Schema.Number,
    body: () => {
      const members: Record<string, Node.Node<number>> = {}
      for (let index = 0; index < 1000; index++) members[`page-of-a-caller-sized-list-${index}`] = Node.succeed(index)
      return Node.all({ values: Node.all(members), gate: Ask.call({}) }).pipe(
        Node.map(({ values }) => Object.keys(values).length)
      )
    }
  })
  try {
    await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "fan-in" },
          journalSource: "fan-in-test",
          isAlive: () => Effect.succeed(false)
        })
        const layer = Layer.mergeAll(parkingImplementations, Interpreter.layer(Wide)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        yield* Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const runs = yield* RunStore.RunStore
          const pages = () =>
            journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 10_000 }).pipe(
              Effect.map((result) =>
                result.entries.filter((entry) =>
                  entry.eventType === "flows.engine.plan-recorded" ||
                  entry.eventType === "flows.engine.subgraph-appended"
                )
              )
            )
          yield* Wide.execute({}, { executionId: runId, discard: true })
          expect((yield* runs.get(runId)).status).toBe("suspended")
          const before = yield* pages()
          expect(before.length).toBeGreaterThan(1)
          for (const page of before) {
            expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
              Interpreter.maximumPageBytes
            )
          }
          const graphOf = (entry: { readonly payload: unknown }) =>
            (entry.payload as {
              graph: {
                nodes: ReadonlyArray<{ id: string; dependsOn: ReadonlyArray<string> }>
                edges: ReadonlyArray<{ from: string; to: string; reason: string }>
              }
            }).graph
          // Assembled, the pages are the whole graph: each node once, with the
          // dependency list it was built with, and each edge exactly once.
          const built = Graph.build(Wide, {})
          const assembled = new Map<string, Array<string>>()
          for (const entry of before) {
            for (const node of graphOf(entry).nodes) {
              const held = assembled.get(node.id)
              if (held === undefined) assembled.set(node.id, [...node.dependsOn])
              else held.push(...node.dependsOn)
            }
          }
          expect([...assembled.keys()]).toEqual(Graph.nodes(built).map((node) => node.id))
          for (const node of Graph.nodes(built)) expect(assembled.get(node.id)).toEqual([...node.dependencies])
          const edge = (value: { readonly from: string; readonly to: string; readonly reason: string }) =>
            `${value.from}->${value.to}:${value.reason}`
          expect(before.flatMap((entry) => graphOf(entry).edges.map(edge)).sort())
            .toEqual(Graph.edges(built).map(edge).sort())
          // An assembled PREFIX never names an edge with no destination.
          const known = new Set<string>()
          for (const entry of before) {
            for (const node of graphOf(entry).nodes) known.add(node.id)
            for (const value of graphOf(entry).edges) expect(known.has(value.to)).toBe(true)
          }
          yield* engine.deferredDone(gate, {
            flowName: Wide._tag,
            executionId: runId,
            deferredName: gate.name,
            exit: Exit.succeed(4)
          })
          // Join the re-drive explicitly; this fixture does not advance the lease clock.
          yield* Wide.execute({}, { executionId: runId, discard: true })
          expect((yield* runs.get(runId)).status).toBe("completed")
          // Exactly once across the resume: the same page ids, the same rows.
          expect(yield* pages()).toEqual(before)
          expect(new Set(before.map((page) => page.sourceId)).size).toBe(before.length)
        }).pipe(Effect.provide(layer))
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
        // Paging and replay are independent of the runner's elapsed wall time.
        // A real-clock lease can expire while this large graph is encoded.
        Effect.provide(TestClock.layer())
      )
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 300_000)

/**
 * One run under a declared revision, and the pages its graph was recorded on.
 *
 * `afterMake` runs once the store is built and before the flow executes: a
 * host that learns its revision after this layer is composed — the native one
 * does, because its modules are read during registration — declares a reader,
 * and this is where that reader's answer arrives.
 */
const pagesUnder = async (
  name: string,
  sourceRevision: string | (() => string | undefined),
  afterMake?: () => void
) => {
  const root = await mkdtemp(join(tmpdir(), `smithers-node-journal-${name}-`))
  try {
    const rows = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: `node-journal-${name}` },
          journalSource: `node-journal-${name}-test`,
          declarationRoot: "/repo",
          sourceRevision,
          isAlive: () => Effect.succeed(false)
        })
        afterMake?.()
        const layer = Layer.mergeAll(implementations, Interpreter.layer(Chain)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        yield* Chain.execute({ path: "abcd" }, { executionId: `${name}-run` }).pipe(Effect.provide(layer))
        return yield* nodeRows(`${name}-run`)
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(root, "state.sqlite")))
      )
    )
    return rows.filter((row) =>
      row.eventType === "flows.engine.plan-recorded" || row.eventType === "flows.engine.subgraph-appended"
    ).map((row) => (row.payload["graph"] as Record<string, unknown>)["sourceRevision"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/*
 * A host that does not know its revision while this store is composed declares
 * a reader instead, and the store asks it at each page rather than capturing
 * whatever it would have answered at construction.
 */
it("asks the reader a host declared, after that host had its answer", async () => {
  const revision = "f".repeat(40)
  let answer: string | undefined
  const pages = await pagesUnder("revision-reader", () => answer, () => {
    answer = revision
  })

  expect(pages.length).toBeGreaterThan(0)
  expect(pages).toEqual(pages.map(() => revision))
})

/* An answer that is not a revision records nothing, exactly as none does. */
it("records nothing where the reader answers something that is not a revision", async () => {
  const pages = await pagesUnder("revision-empty", () => "")

  expect(pages.length).toBeGreaterThan(0)
  expect(pages).toEqual(pages.map(() => undefined))
})

/*
 * D-068: the sites in those rows are a path and a line. A host that knows
 * which tree it read its flows out of states it on the same rows, so a reader
 * of this run can open that file AT that revision. A host that does not know
 * states nothing, and every row above is what that looks like.
 */
it("carries the host's declared source revision onto every recorded page", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-node-journal-revision-"))
  try {
    const rows = await runPromise(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "node-journal-revision" },
          journalSource: "node-journal-revision-test",
          declarationRoot: "/repo",
          sourceRevision: "c".repeat(40),
          isAlive: () => Effect.succeed(false)
        })
        const layer = Layer.mergeAll(implementations, Interpreter.layer(Chain)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        yield* Chain.execute({ path: "abcd" }, { executionId: "revision-run" }).pipe(Effect.provide(layer))
        return yield* nodeRows("revision-run")
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(join(root, "state.sqlite")))
      )
    )

    const pages = rows.filter((row) =>
      row.eventType === "flows.engine.plan-recorded" || row.eventType === "flows.engine.subgraph-appended"
    )
    expect(pages.length).toBeGreaterThan(0)
    expect(pages.map((row) => (row.payload["graph"] as Record<string, unknown>)["sourceRevision"]))
      .toEqual(pages.map(() => "c".repeat(40)))
    /* The revision describes the sources, so it is on the graph and nowhere else. */
    expect(
      rows.filter((row) => row.eventType === "flows.engine.node-settled").every((row) =>
        row.payload["sourceRevision"] === undefined
      )
    ).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
