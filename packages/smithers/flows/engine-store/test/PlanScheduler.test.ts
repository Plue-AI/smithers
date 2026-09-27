import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
/**
 * Deterministic evaluation tests for the node scheduler, in the ethos of
 * Skyframe's `GraphTester`: the graph is declared as data, driven, and
 * asserted on. Determinism comes from Effect itself — a `Latch` to pin the
 * interleaving of two concurrently admitted nodes — rather than from the
 * `DeterministicHelper` the vault rejected. Nothing here sleeps.
 */
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan, StepKey } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "scheduler-host", pid: 91, nonce: "scheduler-process" }

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "scheduler-snapshot" as never, changeId: "scheduler-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

interface DraftOptions {
  readonly body?: unknown
  readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
  readonly reads?: ReadonlyArray<string>
  readonly writes?: ReadonlyArray<string>
  readonly removes?: ReadonlyArray<string>
  readonly kind?: Plan.PlanNode["kind"]
  readonly priority?: number
  readonly conflictStrategy?: Plan.PairStrategy
  readonly runtimeStrategy?: Plan.RuntimeStrategy
  readonly boundaryMode?: "hard" | "expected"
}

const draft = (id: string, options: DraftOptions = {}): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: options.body ?? { action: id },
    inputs: options.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    reads: options.reads ?? [],
    writes: options.writes ?? [`${id}.out`],
    ...(options.removes === undefined ? {} : { removes: options.removes }),
    boundaryMode: options.boundaryMode ?? "hard"
  },
  ...(options.kind === undefined ? {} : { kind: options.kind }),
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  ...(options.conflictStrategy === undefined ? {} : { conflictStrategy: options.conflictStrategy }),
  ...(options.runtimeStrategy === undefined ? {} : { runtimeStrategy: options.runtimeStrategy })
})

const compile = (nodes: ReadonlyArray<Plan.NodeDraft>, planId = "plan-1") =>
  Plan.compile({ planId, flow: "example/Build", nodes })

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    /* v8 ignore next */
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    /* v8 ignore next */
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const outcomes = (report: PlanScheduler.Report): Record<string, PlanScheduler.Outcome> =>
  Object.fromEntries(report.settlements.map((settlement) => [settlement.nodeId, settlement.outcome]))

const awaitNodeSettlement = (runId: string, nodeId: string) =>
  Effect.gen(function*() {
    while (true) {
      const page = yield* JournalRecords.entries(runId, undefined, 512)
      const settled = page.entries.find((entry) =>
        entry.eventType === "flows.engine.node-settled" &&
        (entry.payload as { readonly nodeId?: string }).nodeId === nodeId
      )
      if (settled !== undefined) return settled.payload
      yield* Effect.yieldNow
    }
  })

interface Harness {
  readonly runId: string
  readonly executor: PlanScheduler.Executor
  readonly boundary?: Layer.Layer<StepBoundary.Service> | undefined
  readonly reconciliation?: Layer.Layer<Reconciliation.Reconciliation> | undefined
  readonly options?: Omit<PlanScheduler.Options, "runId" | "owner" | "sourceId"> | undefined
}

const harness = (harness: Harness) =>
  Layer.mergeAll(
    harness.boundary ?? StepBoundary.layerTest(),
    jjLayer,
    PlanScheduler.layerExecutor(harness.executor),
    ...(harness.reconciliation === undefined ? [] : [harness.reconciliation])
  )

const scheduler = (options: Harness) =>
  PlanScheduler.make({
    runId: options.runId,
    owner,
    sourceId: `scheduler/${options.runId}`,
    ...options.options
  })

describe("PlanScheduler option bounds", () => {
  const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("unused") }

  it("shares incremental age history across scheduled node executors", async () => {
    const plan = await runPromise(compile(Array.from({ length: 50 }, (_, index) => draft(`incremental-${index}`))))
    let pages = 0
    await runPromise(
      Effect.gen(function*() {
        yield* activate("incremental-scheduler")
        const journal = yield* Journal.Journal
        yield* scheduler({
          runId: "incremental-scheduler",
          executor,
          options: { concurrency: { steps: 1 } }
        }).run(plan).pipe(Effect.provideService(Journal.Journal, {
          ...journal,
          entries: (options) =>
            journal.entries(options).pipe(Effect.tap(() =>
              Effect.sync(() => {
                // The scheduler also drains deviations in 512-row pages.
                // Count the cache guard's 128-row pages independently.
                if (options.limit === 128) pages++
              })
            ))
        }))
      }).pipe(
        Effect.provide(harness({ runId: "incremental-scheduler", executor })),
        Effect.provide(TestStores.layer())
      )
    )
    expect(pages).toBe(50)
  })

  it("rejects non-positive or non-integral concurrency caps synchronously", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        scheduler({
          runId: "run-invalid-concurrency",
          executor,
          options: { concurrency: { steps: value, agents: 1 } }
        })
      ).toThrow(/concurrency\.steps must be a positive safe integer/)
      expect(() =>
        scheduler({
          runId: "run-invalid-concurrency",
          executor,
          options: { concurrency: { steps: 1, agents: value } }
        })
      ).toThrow(/concurrency\.agents must be a positive safe integer/)
    }
  })

  it("rejects negative or non-integral rebase limits synchronously", () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        scheduler({
          runId: "run-invalid-rebases",
          executor,
          options: { rebaseLimit: value }
        })
      ).toThrow(/rebaseLimit must be a non-negative safe integer/)
    }
  })
})

describe("PlanScheduler over a static graph", () => {
  it("does not round away priority differences when waiting ages a large safe integer", async () => {
    const plan = await runPromise(compile([
      draft("first", { priority: Number.MAX_SAFE_INTEGER }),
      draft("first-2", { priority: Number.MAX_SAFE_INTEGER }),
      draft("lower", { priority: Number.MAX_SAFE_INTEGER - 1 }),
      draft("higher", { priority: Number.MAX_SAFE_INTEGER })
    ]))
    const order: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          order.push(node.id)
          return node.id
        })
    }
    await runPromise(
      Effect.gen(function*() {
        yield* activate("priority-exact")
        return yield* scheduler({ runId: "priority-exact", executor, options: { concurrency: { steps: 1 } } }).run(plan)
      }).pipe(Effect.provide(harness({ runId: "priority-exact", executor })), Effect.provide(TestStores.layer()))
    )
    expect(order).toEqual(["first", "first-2", "higher", "lower"])
  })

  it("refuses a source glob when no filesystem service can expand it", async () => {
    const plan = await runPromise(compile([{
      ...draft("glob-source"),
      effects: {
        reads: [{ _tag: "Glob", include: ["src/**"] }],
        writes: ["glob-source.out"],
        boundaryMode: "hard"
      }
    }]))
    const executor: PlanScheduler.Executor = { execute: () => Effect.die("must not execute") }
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-glob-no-fs")
        return yield* Effect.flip(scheduler({ runId: "run-glob-no-fs", executor }).run(plan))
      }).pipe(Effect.provide(harness({ runId: "run-glob-no-fs", executor })), Effect.provide(TestStores.layer()))
    )
    expect(failure).toMatchObject({ code: "boundary_unavailable" })
  })

  it("records the plan, builds every node, and reports the plan digest", async () => {
    const plan = await runPromise(compile([
      draft("source"),
      draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }], reads: ["source.out"] }),
      draft("sibling")
    ]))
    const order: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          order.push(node.id)
          return { ran: node.id }
        })
    }
    const program = Effect.gen(function*() {
      yield* activate("run-static")
      const service = scheduler({ runId: "run-static", executor })
      const recorded = yield* service.record(plan)
      const report = yield* service.run(plan)
      const events = yield* JournalRecords.entries("run-static", undefined, 512)
      return { events, recorded, report }
    }).pipe(Effect.provide(harness({ runId: "run-static", executor })), Effect.provide(TestStores.layer()))

    const { events, recorded, report } = await runPromise(program)
    expect(recorded).toEqual({ _tag: "Recorded" })
    expect(outcomes(report)).toEqual({ source: "built", derived: "built", sibling: "built" })
    expect(report.digest).toBe(plan.digest)
    expect(order.indexOf("derived")).toBeGreaterThan(order.indexOf("source"))
    expect(report.results).toEqual({
      source: { ran: "source" },
      derived: { ran: "derived" },
      sibling: { ran: "sibling" }
    })
    const types = events.entries.map((entry) => entry.eventType)
    expect(types).toContain("flows.engine.plan-recorded")
    expect(types).toContain("flows.engine.node-scheduled")
    expect(types.filter((type) => type === "flows.engine.node-settled").length).toBe(3)
    // A record says which node it is ABOUT and which tag that node dispatches.
    // Without the tag a reader can group a run's work by node and never by the
    // thing the node does, and the two executors would describe one graph in
    // two shapes.
    const payloads = (eventType: string) =>
      events.entries
        .filter((entry) => entry.eventType === eventType)
        .map((entry) => entry.payload as Record<string, unknown>)
    for (const eventType of ["flows.engine.node-scheduled", "flows.engine.node-settled"]) {
      expect(payloads(eventType).map((payload) => payload["action"]).sort())
        .toEqual(["derived", "sibling", "source"])
    }
    // And the plan record carries the graph it recorded, not only its size.
    const recordedPlan = payloads("flows.engine.plan-recorded")[0]!
    const graph = recordedPlan["graph"] as { readonly nodes: ReadonlyArray<Record<string, unknown>> }
    expect(graph.nodes.map((node) => node["id"]).sort()).toEqual(["derived", "sibling", "source"])
    expect(graph.nodes.length).toBe(recordedPlan["nodes"])
    expect(graph.nodes.map((node) => node["action"]).sort()).toEqual(["derived", "sibling", "source"])
    expect(graph.nodes.every((node) => node["tier"] === "sealed" && node["key"] !== undefined)).toBe(true)
    expect(graph.nodes.find((node) => node["id"] === "derived")!["dependsOn"]).toEqual(["source"])
  })

  it("hands an executor only projected Ref inputs, never ordering results", async () => {
    // An executor may only see data the dispatch key folds. The key folds a
    // Ref's PROJECTED digest and a constant for Pending, so the input record
    // carries exactly the projections — a Pending dependency's result or a
    // Ref's unprojected sibling fields would let a body consume state the key
    // never described, and a `clean` verdict would then serve a stale result.
    const plan = await runPromise(compile([
      draft("source"),
      draft("orderer"),
      draft("consumer", {
        inputs: [
          { _tag: "Ref", from: "source", path: ["nested", "field"] },
          { _tag: "Pending", from: "orderer" }
        ]
      })
    ]))
    const seen: Array<PlanScheduler.NodeInput["inputs"]> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ inputs, node }) =>
        Effect.sync(() => {
          if (node.id === "consumer") seen.push(inputs)
          return node.id === "source" ? { nested: { field: "projected" }, sibling: "hidden" } : { ran: node.id }
        })
    }
    const program = Effect.gen(function*() {
      yield* activate("run-projected-inputs")
      return yield* scheduler({ runId: "run-projected-inputs", executor }).run(plan)
    }).pipe(Effect.provide(harness({ runId: "run-projected-inputs", executor })), Effect.provide(TestStores.layer()))

    const report = await runPromise(program)
    expect(outcomes(report)).toEqual({ source: "built", orderer: "built", consumer: "built" })
    expect(seen).toEqual([[{ from: "source", path: ["nested", "field"], value: "projected" }]])
  })

  it("preserves every dispatch key in a diamond plan", async () => {
    const plan = await runPromise(compile([
      draft("producer"),
      draft("left", { inputs: [{ _tag: "Ref", from: "producer", path: [] }] }),
      draft("right", { inputs: [{ _tag: "Ref", from: "producer", path: [] }] })
    ], "diamond-plan"))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-diamond")
        return yield* scheduler({ runId: "run-diamond", executor }).run(plan)
      }).pipe(Effect.provide(harness({ runId: "run-diamond", executor })), Effect.provide(TestStores.layer()))
    )
    // Pinned literals, not magic constants: they are the drift detector for
    // the key material `@smthrs/plan` stores on a node. They move only when
    // that material moves, and such a move invalidates every cached step, so
    // a diff here has to be explained by a plan-side change rather than
    // re-pinned on sight.
    expect(Object.fromEntries(report.settlements.map(({ dispatchKey, nodeId }) => [nodeId, dispatchKey]))).toEqual({
      producer: "key1_ae53befe693bd7c9a8b374885fd89265438bbc892f50fb7c0db65420ef940711",
      left: "key1_5de052f426ed5a44615f93a3516833e74236b553226d195a5a4f3d07fff6cf13",
      right: "key1_c303102ae1d10627a6fc031811d0bd4cf7a2e7e869d3c5bc90145af8ba29b704"
    })
  })

  it("resolves a shared producer through both arms of a dependency diamond", async () => {
    const plan = await runPromise(compile([
      draft("producer"),
      draft("left", { inputs: [{ _tag: "Pending", from: "producer" }] }),
      draft("right", { inputs: [{ _tag: "Pending", from: "producer" }] }),
      draft("reader", {
        reads: ["producer.out"],
        inputs: [{ _tag: "Pending", from: "left" }, { _tag: "Pending", from: "right" }]
      })
    ]))
    expect(plan.nodes.find((node) => node.id === "reader")!.dependsOn).toEqual(["left", "right"])
    const reads: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ boundary, node }) =>
        Effect.sync(() => {
          if (node.id === "reader") reads.push(...StepBoundary.exactReads(boundary).map((entry) => entry.path))
          return node.id
        })
    }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-diamond-read")
        return yield* scheduler({ runId: "run-diamond-read", executor }).run(plan)
      }).pipe(Effect.provide(harness({ runId: "run-diamond-read", executor })), Effect.provide(TestStores.layer()))
    )
    expect(outcomes(report)).toEqual({ producer: "built", left: "built", right: "built", reader: "built" })
    expect(reads).toEqual(["producer.out"])
  })

  it("threads the engine-resolved environment into dispatch identity", async () => {
    const plan = await runPromise(compile([draft("environment")], "environment-plan"))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const { absent, present } = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-environment-absent")
        const absent = yield* scheduler({ runId: "run-environment-absent", executor }).run(plan)
        yield* activate("run-environment-present")
        const present = yield* scheduler({
          runId: "run-environment-present",
          executor,
          options: {
            environment: {
              declared: true,
              layers: ["workspace"],
              capabilities: { fs: ["read"] }
            }
          }
        }).run(plan)
        return { absent, present }
      }).pipe(
        Effect.provide(harness({ runId: "run-environment", executor })),
        Effect.provide(TestStores.layer())
      )
    )
    expect(present.settlements[0]?.dispatchKey).not.toBe(absent.settlements[0]?.dispatchKey)
  })

  it("re-keys one leaf and re-runs only its cone — every unchanged branch is a cache hit", async () => {
    const graph = (seed: number) => [
      draft("source", { body: { seed } }),
      draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] }),
      draft("sibling"),
      draft("sibling-child", { inputs: [{ _tag: "Pending", from: "sibling" }] })
    ]
    const before = await runPromise(compile(graph(1)))
    const after = await runPromise(compile(graph(2), "plan-2"))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed({ ran: node.id }) }
    // Replay authorization checks concrete output records. Supply each node's
    // own paths rather than the test boundary's opaque default replay payload.
    // The cache-hit expectations below remain the content-addressing contract.
    const boundary = Layer.effect(
      StepBoundary.StepBoundary,
      Effect.map(StepBoundary.StepBoundary, (base) =>
        StepBoundary.make({
          ...base,
          settle: (prepared) =>
            base.settle(prepared).pipe(Effect.map((evidence) => ({
              ...evidence,
              declaredOutputs: {
                outputs: prepared.descriptor.writeSet.map((path) => ({ path, digest: sha256(`fixture:${path}`) }))
              }
            })))
        }))
    ).pipe(Layer.provide(StepBoundary.layerTest()))
    const stores = TestStores.layer()
    const program = Effect.gen(function*() {
      yield* activate("run-rekey")
      const service = scheduler({ runId: "run-rekey", executor })
      yield* service.record(before)
      const first = yield* service.run(before)
      yield* activate("run-rekey-next")
      const next = scheduler({ runId: "run-rekey-next", executor })
      yield* next.record(after)
      const second = yield* next.run(after)
      return { first, second }
    }).pipe(Effect.provide(harness({ runId: "run-rekey", executor, boundary })), Effect.provide(stores))

    const { first, second } = await runPromise(program)
    expect(outcomes(first)).toEqual({
      source: "built",
      derived: "built",
      sibling: "built",
      "sibling-child": "built"
    })
    // THE BAZEL-SHAPED PROMISE: the edited leaf re-ran and the branch nothing
    // touched was served from the content-addressed cache.
    //
    // `derived` is `clean` here, and that is the early cutoff working. The
    // edit changed `source`'s declaration, so `source` re-ran — but this
    // executor returns `{ran: node.id}` for either seed, so the value
    // `derived` consumes is byte-identical to what it consumed before. A
    // dispatch key that folded the upstream PLAN key would have re-run it
    // anyway; `StepKey.dispatchIdentity` folds the upstream's settled output
    // instead, so invalidation stops at unchanged content the way Bazel's
    // `ActionCacheChecker` does.
    expect(outcomes(second)).toEqual({
      source: "built",
      derived: "clean",
      sibling: "clean",
      "sibling-child": "clean"
    })
  })

  it("carries declared removals into the measured boundary and orders readers behind them", async () => {
    // A removal moves a path's content exactly as a write does, so the plan
    // orders the reader behind the remover, the scheduler treats the path as
    // produced rather than pinning it as a source input, and the descriptor
    // the boundary settles against says the absence was declared.
    const plan = await runPromise(compile([
      draft("reader", { reads: ["stale.txt"] }),
      draft("remover", { writes: ["remover.out"], removes: ["stale.txt"] })
    ]))
    const seen: Array<FileBoundary> = []
    const order: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ boundary, node }) =>
        Effect.sync(() => {
          order.push(node.id)
          seen.push(boundary)
          return { ran: node.id }
        })
    }
    const program = Effect.gen(function*() {
      yield* activate("run-removes")
      const service = scheduler({ runId: "run-removes", executor })
      yield* service.record(plan)
      return yield* service.run(plan)
    }).pipe(Effect.provide(harness({ runId: "run-removes", executor })), Effect.provide(TestStores.layer()))

    expect(outcomes(await runPromise(program))).toEqual({ reader: "built", remover: "built" })
    expect(order.indexOf("reader")).toBeGreaterThan(order.indexOf("remover"))
    expect(seen.find((boundary) => boundary.removes !== undefined)?.removes).toEqual(["stale.txt"])
  })

  it("re-runs a dependent when the upstream's settled VALUE changes, not merely its declaration", async () => {
    // The other half of the cutoff: content, not identity, is the trigger. The
    // executor makes `source`'s output track the seed, so the same edit that
    // was invisible above must now propagate.
    const graph = (seed: number) => [
      draft("source", { body: { seed } }),
      draft("derived", { inputs: [{ _tag: "Ref", from: "source", path: [] }] })
    ]
    const before = await runPromise(compile(graph(1)))
    const after = await runPromise(compile(graph(2), "plan-value-2"))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.succeed(
          node.id === "source" ? { seed: (node.material.body as { seed: number }).seed } : { ran: node.id }
        )
    }
    const program = Effect.gen(function*() {
      yield* activate("run-value")
      const service = scheduler({ runId: "run-value", executor })
      yield* service.record(before)
      yield* service.run(before)
      yield* activate("run-value-next")
      const next = scheduler({ runId: "run-value-next", executor })
      yield* next.record(after)
      return yield* next.run(after)
    }).pipe(Effect.provide(harness({ runId: "run-value", executor })), Effect.provide(TestStores.layer()))

    expect(outcomes(await runPromise(program))).toEqual({ source: "built", derived: "built" })
  })

  it("halts the cone below a failure", async () => {
    const plan = await runPromise(compile([
      draft("root"),
      draft("broken", { inputs: [{ _tag: "Pending", from: "root" }] }),
      draft("downstream", { inputs: [{ _tag: "Pending", from: "broken" }] }),
      draft("untouched")
    ]))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) => node.id === "broken" ? Effect.fail("no") : Effect.succeed(node.id)
    }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-halt")
        return yield* scheduler({ runId: "run-halt", executor }).run(plan)
      }).pipe(Effect.provide(harness({ runId: "run-halt", executor })), Effect.provide(TestStores.layer()))
    )
    expect(outcomes(report)).toEqual({
      root: "built",
      broken: "failed",
      downstream: "skipped",
      untouched: "built"
    })
  })
})

describe("PlanScheduler durable input admission", () => {
  for (const kind of ["sealed", "compensable", "irreversible"] as const) {
    it(`refuses changed environments before replay for ${kind} work, while a new run remains independent`, async () => {
      const node = draft("node")
      const plan = await runPromise(compile([{ ...node, material: { ...node.material, kind } }]))
      let executions = 0
      const executor: PlanScheduler.Executor = { execute: () => Effect.sync(() => ++executions) }
      const environment = { declared: true as const, layers: ["runtime"], capabilities: { fs: ["b", "a", "a"] } }
      const drive = (runId: string, identity: StepKey.EnvironmentIdentity | undefined) =>
        scheduler({ runId, executor, options: { environment: identity } }).run(plan)
      await runPromise(
        Effect.gen(function*() {
          yield* activate("environment-original")
          const first = yield* drive("environment-original", environment)
          const equivalent = yield* drive("environment-original", { ...environment, capabilities: { fs: ["a", "b"] } })
          expect(equivalent.settlements[0]!.dispatchKey).toBe(first.settlements[0]!.dispatchKey)
          expect(executions).toBe(1)
          for (
            const changed of [undefined, { ...environment, layers: ["replacement"] }, {
              ...environment,
              declared: false as const,
              runScope: "environment-original"
            }]
          ) {
            const failure = yield* Effect.flip(drive("environment-original", changed))
            expect(failure).toMatchObject({ code: "store_failed", cause: { code: "incompatible_state" } })
          }
          expect(executions).toBe(1)
          yield* activate("environment-new")
          yield* drive("environment-new", { ...environment, layers: ["replacement"] })
          expect(executions).toBe(2)
        }).pipe(
          Effect.provide(harness({ runId: "environment-original", executor })),
          Effect.provide(TestStores.layer())
        )
      )
    })
  }

  it("captures nested environment data at construction, before admission and throughout dispatch", async () => {
    const plan = await runPromise(compile([
      draft("first"),
      draft("second", { inputs: [{ _tag: "Pending", from: "first" }] })
    ]))
    const original = { declared: true as const, layers: ["runtime"], capabilities: { fs: ["a"] } }
    const input = { declared: true as const, layers: ["runtime"], capabilities: { fs: ["a"] } }
    let executions = 0
    const executor: PlanScheduler.Executor = {
      execute: () =>
        Effect.sync(() => {
          input.layers[0] = "during-dispatch"
          input.capabilities.fs.push("during-dispatch")
          return ++executions
        })
    }
    const service = scheduler({ runId: "environment-capture", executor, options: { environment: input } })
    input.layers[0] = "before-admission"
    input.capabilities.fs.push("before-admission")
    await runPromise(
      Effect.gen(function*() {
        yield* activate("environment-capture")
        const first = yield* service.run(plan)
        const replay = yield* scheduler({
          runId: "environment-capture",
          executor,
          options: { environment: original }
        }).run(plan)
        expect(replay.settlements.map((node) => node.dispatchKey)).toEqual(
          first.settlements.map((node) => node.dispatchKey)
        )
        expect(executions).toBe(2)
      }).pipe(Effect.provide(harness({ runId: "environment-capture", executor })), Effect.provide(TestStores.layer()))
    )
  })

  it("rejects invalid runtime environments before observation and leaves no durable binding", async () => {
    const plan = await runPromise(compile([draft("node")]))
    let executions = 0
    const executor: PlanScheduler.Executor = { execute: () => Effect.sync(() => ++executions) }
    await runPromise(
      Effect.gen(function*() {
        yield* activate("environment-invalid")
        const sql = yield* SqlClient.SqlClient
        for (
          const environment of [
            null,
            { declared: false, layers: [], capabilities: {} },
            {
              declared: true,
              layers: [42],
              capabilities: {}
            },
            { declared: true, layers: ["\ud800"], capabilities: {} },
            { declared: true, layers: [], capabilities: {}, unknown: "ignored?" },
            {
              get declared() {
                throw new Error("private identity detail")
              }
            }
          ]
        ) {
          const failure = yield* Effect.flip(
            scheduler({
              runId: "environment-invalid",
              executor,
              options: { environment: environment as StepKey.EnvironmentIdentity }
            }).run(plan)
          )
          expect(failure).toMatchObject({ code: "key_uncomputable" })
          expect(JSON.stringify(failure)).not.toContain("private identity detail")
        }
        expect(yield* sql`SELECT * FROM flows_plan_input_heads`).toEqual([])
        expect(executions).toBe(0)
        yield* scheduler({ runId: "environment-invalid", executor }).run(plan)
        expect(executions).toBe(1)
      }).pipe(
        Effect.provide(harness({ runId: "environment-invalid", executor })),
        Effect.provide(TestStores.layerAt(":memory:"))
      )
    )
  })

  it("refuses replacing the approved graph inside an already observed run", async () => {
    const before = await runPromise(compile([draft("node", { body: "first" })]))
    const after = await runPromise(compile([draft("node", { body: "changed" })]))
    let executions = 0
    const executor: PlanScheduler.Executor = { execute: () => Effect.sync(() => ++executions) }
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("input-plan-changed")
        const service = scheduler({ runId: "input-plan-changed", executor })
        yield* service.run(before)
        return yield* Effect.flip(service.run(after))
      }).pipe(Effect.provide(harness({ runId: "input-plan-changed", executor })), Effect.provide(TestStores.layer()))
    )
    expect(failure.cause).toMatchObject({ code: "incompatible_state" })
    expect(executions).toBe(1)
  })

  it("self-interrupts before observation or execution when cancellation removed its fence", async () => {
    const plan = await runPromise(compile([draft("reader", { reads: ["input"] })]))
    let executions = 0
    const executor: PlanScheduler.Executor = { execute: () => Effect.sync(() => ++executions) }
    const exit = await runPromise(
      Effect.gen(function*() {
        yield* activate("input-fence-lost")
        const runs = yield* RunStore.RunStore
        yield* runs.requestCancel("input-fence-lost", 2)
        return yield* Effect.exit(scheduler({ runId: "input-fence-lost", executor }).run(plan))
      }).pipe(Effect.provide(harness({ runId: "input-fence-lost", executor })), Effect.provide(TestStores.layer()))
    )
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(executions).toBe(0)
  })

  it("rejects an incomplete host measurement before persisting it and can retry with a valid host", async () => {
    const plan = await runPromise(compile([draft("reader", { reads: ["input"] })]))
    const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("executed") }
    const { failure, report } = await runPromise(
      Effect.gen(function*() {
        yield* activate("input-bad-host")
        const service = scheduler({ runId: "input-bad-host", executor })
        const failure = yield* Effect.flip(service.run(plan)).pipe(Effect.provide(harness({
          runId: "input-bad-host",
          executor,
          boundary: StepBoundary.layerTest({ readSnapshot: [] })
        })))
        const report = yield* service.run(plan).pipe(Effect.provide(harness({ runId: "input-bad-host", executor })))
        return { failure, report }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(failure.cause).toMatchObject({ code: "corrupt_state" })
    expect(outcomes(report)).toEqual({ reader: "built" })
  })

  for (const produced of [false, true]) {
    it(`recovers glob observations without source enumeration; preceding producer present: ${produced}`, async () => {
      const glob = { _tag: "Glob" as const, include: ["src/**"] as [string] }
      const reader = {
        ...draft("reader"),
        effects: { reads: [glob], writes: ["reader.out"], boundaryMode: "hard" as const }
      }
      const plan = await runPromise(
        compile(produced ? [draft("producer", { writes: ["src/file"] }), reader] : [reader])
      )
      let executions = 0
      const executor: PlanScheduler.Executor = { execute: () => Effect.sync(() => ++executions) }
      const exit = await runPromise(
        Effect.gen(function*() {
          yield* activate("input-glob-recovery")
          const store = yield* PlanInputStore.PlanInputStore
          yield* store.record({
            runId: "input-glob-recovery",
            planId: plan.planId,
            baseDigest: plan.baseDigest,
            environmentDigest: yield* StepKey.environmentIdentity(),
            generation: 0
          }, {
            version: 1,
            generation: 0,
            nodes: plan.nodes.map((node) => ({
              id: node.id,
              key: node.key,
              reads: node.id === "reader" ?
                [{
                  entry: glob,
                  sourcePaths: produced ? [] : ["src/file"]
                }] :
                []
            })),
            pins: produced ? [] : [{ path: "src/file", digest: "initial" }]
          }, owner)
          return yield* Effect.exit(scheduler({ runId: "input-glob-recovery", executor }).run(plan))
        }).pipe(Effect.provide(harness({ runId: "input-glob-recovery", executor })), Effect.provide(TestStores.layer()))
      )
      if (produced) {
        expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
          code: "boundary_unavailable"
        })
      } else {
        expect(Exit.isSuccess(exit) ? outcomes(exit.value) : undefined).toEqual({ reader: "built" })
      }
      expect(executions).toBe(1)
    })
  }
})

// These admission cases have one deviator (`own.out`) and a separate writer.
// Supply the deviator's evidence explicitly; classification is tested over a real filesystem.
const admissionBoundary = Layer.effect(
  StepBoundary.StepBoundary,
  Effect.gen(function*() {
    const boundary = yield* StepBoundary.StepBoundary
    return StepBoundary.make({
      ...boundary,
      settle: (prepared) =>
        boundary.settle(prepared).pipe(Effect.map((evidence) =>
          prepared.descriptor.writeSet.includes("own.out")
            ? {
              ...evidence,
              deviation: { _tag: "ExpectedSetDeviation" as const, paths: ["shared.out"], diffIdentity: "test-diff" }
            }
            : evidence
        ))
    })
  })
).pipe(Layer.provide(StepBoundary.layerTest()))

describe("PlanScheduler admission", () => {
  it("admits by cap and effective priority while journaling event-driven aging", async () => {
    const plan = await runPromise(compile([
      draft("low"),
      draft("high", { priority: 5 }),
      draft("medium", { priority: 2 })
    ]))
    const order: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          order.push(node.id)
          return node.id
        })
    }
    const waited = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-priority")
        yield* scheduler({ runId: "run-priority", executor, options: { concurrency: { steps: 1 } } }).run(plan)
        const events = yield* JournalRecords.entries("run-priority", undefined, 512)
        return events.entries
          .filter((entry) => entry.eventType === "flows.engine.node-scheduled")
          .map((entry) => {
            const payload = entry.payload as { readonly nodeId: string; readonly waited: number }
            return [payload.nodeId, payload.waited] as const
          })
      }).pipe(Effect.provide(harness({ runId: "run-priority", executor })), Effect.provide(TestStores.layer()))
    )
    // The initial pass admits `high`; `medium` and `low` are passed over once.
    // The next completion opens a pass that admits `medium` and ages `low` a
    // second time. The journal records those exact capacity decisions.
    expect(order).toEqual(["high", "medium", "low"])
    expect(waited).toEqual([["high", 0], ["medium", 1], ["low", 2]])
  })

  it("charges an agent node against both caps", async () => {
    const plan = await runPromise(compile([
      draft("agent-a", { kind: "agent" }),
      draft("agent-b", { kind: "agent" }),
      draft("compute")
    ]))
    const started = new Set<string>()
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.sync(() => {
          started.add(node.id)
          return node.id
        })
    }
    await runPromise(
      Effect.gen(function*() {
        yield* activate("run-agents")
        const service = scheduler({
          runId: "run-agents",
          executor,
          options: { concurrency: { steps: 2, agents: 1 } }
        })
        return yield* service.run(plan)
      }).pipe(Effect.provide(harness({ runId: "run-agents", executor })), Effect.provide(TestStores.layer()))
    )
    // Two step permits, one agent permit: one agent and the compute node run
    // together, while the second agent waits for an agent permit.
    expect(started.size).toBe(3)
  })

  it("runs concurrently admitted nodes together", async () => {
    const plan = await runPromise(compile([draft("left"), draft("right")]))
    const program = Effect.gen(function*() {
      const gate = yield* Latch.make()
      const both = yield* Ref.make(0)
      const executor: PlanScheduler.Executor = {
        execute: ({ node }) =>
          Effect.gen(function*() {
            const arrived = yield* Ref.updateAndGet(both, (count) => count + 1)
            // The second arrival opens the gate the first is waiting on: this
            // completes only if the two ran concurrently.
            if (arrived === 2) yield* Latch.open(gate)
            yield* Latch.await(gate)
            return node.id
          })
      }
      yield* activate("run-parallel")
      return yield* Effect.provide(
        scheduler({ runId: "run-parallel", executor }).run(plan),
        harness({ runId: "run-parallel", executor })
      )
    }).pipe(Effect.provide(TestStores.layer()))
    const report = await runPromise(program)
    expect(outcomes(report)).toEqual({ left: "built", right: "built" })
  })

  it("admits a dependent as soon as its own dependency settles", async () => {
    const plan = await runPromise(compile([
      draft("fast"),
      draft("slow"),
      draft("dependent", { inputs: [{ _tag: "Pending", from: "fast" }] })
    ]))
    const observed = await runPromise(
      Effect.gen(function*() {
        const slowGate = yield* Latch.make()
        const slowStarted = yield* Latch.make()
        const executor: PlanScheduler.Executor = {
          execute: ({ node }) =>
            node.id === "slow"
              ? Latch.open(slowStarted).pipe(Effect.andThen(Latch.await(slowGate)), Effect.as(node.id))
              : Effect.succeed(node.id)
        }
        yield* activate("run-no-barrier")
        const running = yield* Effect.provide(
          scheduler({ runId: "run-no-barrier", executor }).run(plan),
          harness({ runId: "run-no-barrier", executor })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(slowStarted)
        const dependent = yield* awaitNodeSettlement("run-no-barrier", "dependent")
        const beforeRelease = yield* JournalRecords.entries("run-no-barrier", undefined, 512)
        yield* Latch.open(slowGate)
        const report = yield* Fiber.join(running)
        return {
          dependent,
          report,
          slowHadSettled: beforeRelease.entries.some((entry) =>
            entry.eventType === "flows.engine.node-settled" &&
            (entry.payload as { readonly nodeId?: string }).nodeId === "slow"
          )
        }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(observed.dependent).toMatchObject({ nodeId: "dependent", outcome: "built" })
    expect(observed.slowHadSettled).toBe(false)
    expect(outcomes(observed.report)).toEqual({ fast: "built", slow: "built", dependent: "built" })
  })

  it("applies a deviation verdict before admitting the deviating node's dependent", async () => {
    const plan = await runPromise(compile([
      draft("deviator", { writes: ["own.out"], boundaryMode: "expected" }),
      draft("unrelated", { writes: ["shared.out"] }),
      draft("dependent", { inputs: [{ _tag: "Pending", from: "deviator" }] })
    ]))
    const observed = await runPromise(
      Effect.gen(function*() {
        const unrelatedGate = yield* Latch.make()
        const unrelatedStarted = yield* Latch.make()
        const executed: Array<string> = []
        const executor: PlanScheduler.Executor = {
          execute: ({ node }) =>
            Effect.sync(() => {
              executed.push(node.id)
            }).pipe(
              Effect.andThen(
                node.id === "unrelated"
                  ? Latch.open(unrelatedStarted).pipe(Effect.andThen(Latch.await(unrelatedGate)))
                  : Effect.void
              ),
              Effect.as(node.id)
            )
        }
        const reconciliation = Reconciliation.layer({
          onDeviation: () => Effect.succeed({ _tag: "Fail", reason: "test verdict" }),
          onConflict: () => Effect.succeed({ _tag: "Fail", reason: "unused" })
        })
        yield* activate("run-deviation-order")
        const running = yield* Effect.provide(
          scheduler({ runId: "run-deviation-order", executor }).run(plan),
          harness({
            runId: "run-deviation-order",
            executor,
            boundary: admissionBoundary,
            reconciliation
          })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(unrelatedStarted)
        const dependent = yield* awaitNodeSettlement("run-deviation-order", "dependent")
        yield* Latch.open(unrelatedGate)
        return { dependent, executed, report: yield* Fiber.join(running) }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(observed.dependent).toMatchObject({ nodeId: "dependent", outcome: "skipped" })
    expect(observed.executed).not.toContain("dependent")
    expect(outcomes(observed.report)).toEqual({ deviator: "failed", unrelated: "built", dependent: "skipped" })
  })

  /**
   * The reader-after-writer edge, observed where it matters: a node that reads
   * a path another node writes must not dispatch before its producer settles,
   * or it measures pre-producer bytes and the dispatch key records that wrong
   * execution as a legitimate one.
   *
   * The trace is read as an interleaving. Each body announces itself, yields,
   * and announces its end, so concurrently admitted nodes interleave while a
   * dependent begins only after its producer ends. The first assertion is the
   * control that proves the probe discriminates.
   */
  it("never admits a reader before the node that writes what it reads settles", async () => {
    const traced = (runId: string, plan: Plan.Plan, parallel = false) => {
      const bothStarted = Latch.makeUnsafe()
      const trace: Array<string> = []
      const executor: PlanScheduler.Executor = {
        execute: ({ node }) =>
          Effect.gen(function*() {
            trace.push(`start:${node.id}`)
            if (parallel) {
              if (trace.length === 2) yield* bothStarted.open
              yield* bothStarted.await
            }
            yield* Effect.yieldNow
            trace.push(`end:${node.id}`)
            return node.id
          })
      }
      return Effect.gen(function*() {
        yield* activate(runId)
        yield* Effect.provide(scheduler({ runId, executor }).run(plan), harness({ runId, executor }))
        return trace
      }).pipe(Effect.provide(TestStores.layer()))
    }

    const independent = await runPromise(traced(
      "run-rw-control",
      await runPromise(compile([draft("writer", { writes: ["shared.out"] }), draft("bystander")])),
      true
    ))
    expect(independent.slice(0, 2).sort()).toEqual(["start:bystander", "start:writer"])
    expect(independent.slice(2).sort()).toEqual(["end:bystander", "end:writer"])

    const ordered = await runPromise(traced(
      "run-rw-ordered",
      await runPromise(compile([
        draft("writer", { writes: ["shared.out"] }),
        draft("reader", { reads: ["shared.out"], writes: ["reader.out"] })
      ]))
    ))
    expect(ordered).toEqual(["start:writer", "end:writer", "start:reader", "end:reader"])
  })
})

const conflict = () =>
  new WorkspaceSandbox.MaterializationConflict({
    paths: ["shared.out"],
    message: "the host moved under the transaction"
  })

describe("PlanScheduler conflict strategies", () => {
  it("recognizes live and rehydrated materialization conflicts", () => {
    const live = conflict()
    const rehydrated = { _tag: live._tag, paths: live.paths, message: live.message }
    expect(WorkspaceSandbox.isMaterializationConflict(live)).toBe(true)
    expect(WorkspaceSandbox.isMaterializationConflict(rehydrated)).toBe(true)
    expect(WorkspaceSandbox.isMaterializationConflict({ ...rehydrated, _tag: "different" })).toBe(false)
  })

  it("rejects malformed or hostile conflict lookalikes without throwing", () => {
    const tag = WorkspaceSandbox.MaterializationConflict.identifier
    const pathsWithExtraKey = ["out.txt"]
    Object.defineProperty(pathsWithExtraKey, "extra", { value: true, enumerable: true })
    const malformed: ReadonlyArray<unknown> = [
      { _tag: tag },
      { _tag: tag, paths: "out.txt", message: "raced" },
      { _tag: tag, paths: [], message: "" },
      { _tag: tag, paths: [""], message: "raced" },
      { _tag: tag, paths: ["out.txt"], message: "raced", extra: true },
      { _tag: tag, paths: pathsWithExtraKey, message: "raced" },
      { _tag: tag, paths: ["x".repeat(4_097)], message: "raced" },
      new Proxy({}, {
        getPrototypeOf: () => {
          throw new Error("hostile")
        }
      })
    ]
    const accessor = Object.defineProperty({}, "_tag", {
      enumerable: true,
      get: () => tag
    })
    for (const candidate of [...malformed, accessor]) {
      expect(() => WorkspaceSandbox.isMaterializationConflict(candidate)).not.toThrow()
      expect(WorkspaceSandbox.isMaterializationConflict(candidate)).toBe(false)
    }
  })

  it("delay/rebase replays a persisted conflict as a new attempt", async () => {
    const plan = await runPromise(compile([draft("replayed-racer")]))
    let dispatches = 0
    const executor: PlanScheduler.Executor = {
      execute: () =>
        Effect.sync(() => {
          dispatches = dispatches + 1
          return "landed"
        })
    }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-replayed-conflict")
        const node = plan.nodes[0]!
        const dispatchKey = yield* StepKey.dispatchIdentity({
          material: node.material,
          results: {},
          hermetic: {
            readSet: [],
            writeSet: ["replayed-racer.out"],
            boundaryMode: "hard"
          }
        })
        const attempts = yield* AttemptStore.AttemptStore
        const attemptId = {
          runId: "run-replayed-conflict",
          stepKeyDigest: sha256(dispatchKey),
          attempt: 1
        }
        const inserted = yield* attempts.put({
          ...attemptId,
          state: "running",
          startedAtMs: 1,
          meta: { tier: "sealed" }
        }, owner)
        /* v8 ignore next -- the activated deterministic store cannot reject its first attempt row */
        if (inserted._tag !== "Inserted") return yield* Effect.die(new Error("attempt seed was not inserted"))
        const live = conflict()
        const finished = yield* attempts.finish({
          ...attemptId,
          state: "failed",
          finishedAtMs: 2,
          error: {
            reasons: [{
              _tag: "Fail",
              error: { _tag: live._tag, paths: live.paths, message: live.message }
            }]
          },
          meta: { tier: "sealed" }
        }, owner)
        /* v8 ignore next -- the owner-fenced running row above has one valid terminal transition */
        if (finished._tag !== "Finished") return yield* Effect.die(new Error("attempt seed was not finished"))
        return yield* Effect.provide(
          scheduler({ runId: "run-replayed-conflict", executor }).run(plan),
          harness({ runId: "run-replayed-conflict", executor })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.settlements[0]).toMatchObject({ outcome: "built", attempts: 2, rebases: 1 })
    expect(dispatches).toBe(1)
  })

  it("delay/rebase re-keys a new attempt and lands within its bound", async () => {
    const plan = await runPromise(compile([draft("racer", { writes: ["shared.out"] })]))
    const attempts = await runPromise(
      Effect.gen(function*() {
        const seen = yield* Ref.make(0)
        const executor: PlanScheduler.Executor = {
          execute: () =>
            Effect.flatMap(
              Ref.updateAndGet(seen, (count) => count + 1),
              (count) => count < 3 ? Effect.fail(conflict()) : Effect.succeed("landed")
            )
        }
        yield* activate("run-rebase")
        const report = yield* Effect.provide(
          scheduler({ runId: "run-rebase", executor, options: { rebaseLimit: 3 } }).run(plan),
          harness({ runId: "run-rebase", executor })
        )
        return report.settlements[0]!
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(attempts.outcome).toBe("built")
    expect(attempts.rebases).toBe(2)
    expect(attempts.attempts).toBe(3)
  })

  it("delay/rebase is bounded — an exhausted budget asks reconciliation and fails", async () => {
    const plan = await runPromise(compile([
      draft("holder", { writes: ["shared.out"] }),
      draft("racer", { writes: ["shared.out"] })
    ]))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) => node.id === "racer" ? Effect.fail(conflict()) : Effect.succeed(node.id)
    }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-rebase-exhausted")
        return yield* Effect.provide(
          scheduler({ runId: "run-rebase-exhausted", executor, options: { rebaseLimit: 1 } }).run(plan),
          harness({ runId: "run-rebase-exhausted", executor, reconciliation: Reconciliation.layerDefault })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.settlements[1]).toMatchObject({ nodeId: "racer", outcome: "failed", rebases: 1, attempts: 2 })
    expect(report.verdicts).toEqual([{
      nodeId: "racer",
      verdict: { _tag: "Fail", reason: "racer could not land after 1 rebases under delay-rebase" }
    }])
  })

  it("stop/merge stops the loser and routes both lanes through an appended merge node", async () => {
    const plan = await runPromise(compile([
      draft("lane-a", { writes: ["shared.out"] }),
      draft("lane-b", { writes: ["shared.out"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" })
    ]))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        node.id === "lane-b"
          ? Effect.fail(conflict())
          : node.kind === "merge"
          ? Effect.succeed({ merged: node.material.body })
          : Effect.succeed(node.id)
    }
    const { persisted, report, settled } = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-merge")
        const service = scheduler({ runId: "run-merge", executor })
        // The merge node is an elaboration of the SAME plan, so the plan has
        // to be on disk for one to be appended to it.
        yield* service.record(plan)
        const report = yield* Effect.provide(service.run(plan), harness({ runId: "run-merge", executor }))
        const store = yield* PlanStore.PlanStore
        const page = yield* JournalRecords.entries("run-merge", undefined, 512)
        const settled = page.entries.filter((entry) => entry.eventType === "flows.engine.node-settled")
        return { persisted: yield* store.get("plan-1"), report, settled }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(settled.map((entry) => (entry.payload as { nodeId: string }).nodeId).sort()).toEqual([
      "lane-a",
      "lane-b",
      "lane-b+merge"
    ])
    expect(report.appended).toEqual(["lane-b+merge"])
    expect(outcomes(report)).toEqual({ "lane-a": "built", "lane-b": "skipped", "lane-b+merge": "built" })
    expect(report.results["lane-b+merge"]).toEqual({ merged: { merge: { stopped: "lane-b", winners: ["lane-a"] } } })
    // And it landed in the persisted plan as generation 1, not only in memory.
    expect(Option.getOrThrow(persisted).nodes.map((node) => node.id)).toEqual(["lane-a", "lane-b", "lane-b+merge"])
    expect(Option.getOrThrow(persisted).generation).toBe(1)
  })

  for (const resumeFrom of ["base", "grown"] as const) {
    for (const collision of [false, true]) {
      it(`preserves stopped-node meaning after reopening from ${resumeFrom}, collision=${collision}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "scheduler-merge-reopen-"))
        try {
          const filename = join(directory, "engine.sqlite")
          const runId = "merge-reopened"
          const plan = await runPromise(compile([
            draft("lane-a", { writes: ["shared.out"] }),
            draft("lane-b", { writes: ["shared.out"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" }),
            ...(collision ? [draft("lane-b+merge", { writes: ["unrelated.out"] })] : [])
          ]))
          const calls: Array<string> = []
          const executor: PlanScheduler.Executor = {
            execute: ({ node }) =>
              Effect.suspend(() => {
                calls.push(node.id)
                return node.id === "lane-b" ?
                  Effect.fail(conflict())
                  : Effect.succeed(node.kind === "merge" ? { merged: node.material.body } : node.id)
              })
          }
          const service = scheduler({ runId, executor })
          const first = await runPromise(
            Effect.gen(function*() {
              yield* activate(runId)
              yield* service.record(plan)
              return yield* service.run(plan).pipe(Effect.provide(harness({ runId, executor })))
            }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.scoped)
          )
          const mergeId = collision ? "lane-b+merge#1" : "lane-b+merge"
          expect(first.appended).toEqual([mergeId])
          expect(outcomes(first)).toEqual({
            "lane-a": "built",
            "lane-b": "skipped",
            ...(collision ? { "lane-b+merge": "built" } : {}),
            [mergeId]: "built"
          })
          const executed = [...calls]
          expect([...executed].sort()).toEqual(
            ["lane-a", "lane-b", mergeId, ...(collision ? ["lane-b+merge"] : [])].sort()
          )

          // Each provide creates and closes independent SQLite-backed services.
          // Repeat recovery to detect accumulating generations or journal drift.
          for (let restart = 0; restart < 2; restart++) {
            const reopened = await runPromise(
              Effect.gen(function*() {
                const store = yield* PlanStore.PlanStore
                const loaded = Option.getOrThrow(yield* store.get(plan.planId))
                const report = yield* scheduler({ runId, executor }).run(resumeFrom === "base" ? plan : loaded)
                  .pipe(Effect.provide(harness({ runId, executor })))
                const page = yield* JournalRecords.entries(runId, undefined, 512)
                const settled = page.entries.filter((entry) => entry.eventType === "flows.engine.node-settled")
                return { report, persisted: Option.getOrThrow(yield* store.get(plan.planId)), settled }
              }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.scoped)
            )
            expect(outcomes(reopened.report)).toEqual({
              "lane-a": "clean",
              "lane-b": "skipped",
              ...(collision ? { "lane-b+merge": "clean" } : {}),
              [mergeId]: "clean"
            })
            for (const node of reopened.persisted.nodes) {
              const records = reopened.settled.filter((entry) =>
                (entry.payload as { nodeId: string }).nodeId === node.id
              )
              // Replayed work settles clean on each invocation; the durable
              // stopped decision remains the same fact across reopenings.
              expect(records).toHaveLength(node.id === "lane-b" ? 1 : restart + 2)
              if (node.id === "lane-b") {
                expect(records[0]).toMatchObject({
                  sourceSeq: 0,
                  payload: { outcome: "skipped", attempts: 1, rebases: 0 }
                })
              }
            }
            expect(reopened.report.results).toEqual(first.results)
            expect(reopened.report.appended).toEqual([])
            expect(reopened.persisted.generation).toBe(1)
            expect(calls).toEqual(executed)
          }
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      })
    }
  }

  it("refuses an automatic merge that would exceed the approved graph-size ceiling", async () => {
    const plan = await runPromise(compile([
      draft("lane-a", { writes: ["shared.out"], priority: 100 }),
      draft("lane-b", {
        writes: ["shared.out"],
        priority: 100,
        conflictStrategy: "lane",
        runtimeStrategy: "stop-merge"
      }),
      ...Array.from({ length: Plan.maximumPlanNodes - 2 }, (_, index) => draft(`pending-${index}`, { writes: [] }))
    ]))
    const calls: Array<string> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) =>
        Effect.suspend(() => {
          calls.push(node.id)
          return node.id === "lane-b" ? Effect.fail(conflict()) : Effect.succeed(node.id)
        })
    }
    await runPromise(
      Effect.gen(function*() {
        const runId = "merge-graph-ceiling"
        yield* activate(runId)
        const service = scheduler({ runId, executor, options: { concurrency: { steps: 1, agents: 1 } } })
        yield* service.record(plan)
        const failure = yield* Effect.flip(service.run(plan).pipe(Effect.provide(harness({ runId, executor }))))
        expect(failure).toMatchObject({ code: "elaboration_failed", cause: { code: "graph_too_large" } })
        const store = yield* PlanStore.PlanStore
        expect(Option.getOrThrow(yield* store.get(plan.planId)).generation).toBe(0)
        const sql = yield* SqlClient.SqlClient
        expect(yield* sql`SELECT generation FROM flows_plan_input_generations`).toEqual([{ generation: 0 }])
        expect(yield* sql`SELECT * FROM flows_plan_merge_completions`).toEqual([])
        expect(yield* sql`SELECT count(*) AS count FROM flows_plan_merge_intents`).toEqual([{ count: 1 }])
        expect(calls).toEqual(["lane-a", "lane-b"])
      }).pipe(Effect.provide(TestStores.layerAt(":memory:")), Effect.scoped)
    )
  }, 120_000)

  it("holds a stop/merge elaboration until its conflicting peer settles", async () => {
    const plan = await runPromise(compile([
      draft("lane-a", { writes: ["shared.out"] }),
      draft("lane-b", { writes: ["shared.out"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" })
    ]))
    const observed = await runPromise(
      Effect.gen(function*() {
        const laneAGate = yield* Latch.make()
        const laneAStarted = yield* Latch.make()
        const executor: PlanScheduler.Executor = {
          execute: ({ node }) => {
            if (node.id === "lane-a") {
              return Latch.open(laneAStarted).pipe(
                Effect.andThen(Latch.await(laneAGate)),
                Effect.as(node.id)
              )
            }
            if (node.id === "lane-b") {
              return Latch.await(laneAStarted).pipe(Effect.andThen(Effect.fail(conflict())))
            }
            return Effect.succeed(node.id)
          }
        }
        yield* activate("run-merge-waits-for-peer")
        const service = scheduler({ runId: "run-merge-waits-for-peer", executor })
        yield* service.record(plan)
        const running = yield* Effect.provide(
          service.run(plan),
          harness({ runId: "run-merge-waits-for-peer", executor })
        ).pipe(Effect.forkChild({ startImmediately: true }))

        yield* awaitNodeSettlement("run-merge-waits-for-peer", "lane-b")
        const store = yield* PlanStore.PlanStore
        const beforePeerSettled = yield* store.get("plan-1")
        yield* Latch.open(laneAGate)
        return { beforePeerSettled, report: yield* Fiber.join(running) }
      }).pipe(Effect.provide(TestStores.layer()))
    )

    expect(Option.getOrThrow(observed.beforePeerSettled).nodes.map((node) => node.id)).toEqual(["lane-a", "lane-b"])
    expect(observed.report.appended).toEqual(["lane-b+merge"])
    expect(outcomes(observed.report)).toEqual({ "lane-a": "built", "lane-b": "skipped", "lane-b+merge": "built" })
  })

  it("appends and settles a stop/merge node while unrelated work remains in flight", async () => {
    const plan = await runPromise(compile([
      draft("lane-a", { writes: ["shared.out"] }),
      draft("lane-b", { writes: ["shared.out"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" }),
      draft("unrelated")
    ]))
    const observed = await runPromise(
      Effect.gen(function*() {
        const conflictGate = yield* Latch.make()
        const unrelatedGate = yield* Latch.make()
        const unrelatedStarted = yield* Latch.make()
        const executor: PlanScheduler.Executor = {
          execute: ({ node }) => {
            if (node.id === "lane-b") return Latch.await(conflictGate).pipe(Effect.andThen(Effect.fail(conflict())))
            if (node.id === "unrelated") {
              return Latch.open(unrelatedStarted).pipe(
                Effect.andThen(Latch.await(unrelatedGate)),
                Effect.as(node.id)
              )
            }
            return Effect.succeed(node.id)
          }
        }
        yield* activate("run-merge-mid-flight")
        const service = scheduler({ runId: "run-merge-mid-flight", executor })
        yield* service.record(plan)
        const running = yield* Effect.provide(
          service.run(plan),
          harness({ runId: "run-merge-mid-flight", executor })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(unrelatedStarted)
        yield* awaitNodeSettlement("run-merge-mid-flight", "lane-a")
        yield* Latch.open(conflictGate)
        const merge = yield* awaitNodeSettlement("run-merge-mid-flight", "lane-b+merge")
        const beforeRelease = yield* JournalRecords.entries("run-merge-mid-flight", undefined, 512)
        yield* Latch.open(unrelatedGate)
        return {
          merge,
          report: yield* Fiber.join(running),
          unrelatedHadSettled: beforeRelease.entries.some((entry) =>
            entry.eventType === "flows.engine.node-settled" &&
            (entry.payload as { readonly nodeId?: string }).nodeId === "unrelated"
          )
        }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(observed.merge).toMatchObject({ nodeId: "lane-b+merge", outcome: "built" })
    expect(observed.unrelatedHadSettled).toBe(false)
    expect(observed.report.appended).toEqual(["lane-b+merge"])
    expect(outcomes(observed.report)).toEqual({
      "lane-a": "built",
      "lane-b": "skipped",
      unrelated: "built",
      "lane-b+merge": "built"
    })
  })
})

describe("PlanScheduler reconciliation", () => {
  const deviating = (paths: ReadonlyArray<string>) =>
    StepBoundary.layerTest({ deviation: { _tag: "ExpectedSetDeviation", paths, diffIdentity: "test-diff" } })

  it("attributes an identical-key deviation to the node that executed", async () => {
    const shared = {
      body: { action: "install" },
      writes: ["installed.out"],
      boundaryMode: "expected" as const
    }
    const plan = await runPromise(compile([
      draft("install-first", shared),
      draft("install-twin", shared)
    ]))
    const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("installed") }
    const seen: Array<Reconciliation.Deviation> = []
    const recorder = Reconciliation.layer({
      onDeviation: (deviation) =>
        Effect.sync(() => {
          seen.push(deviation)
          return { _tag: "FactorOut", paths: deviation.paths, reason: "observed" } as const
        }),
      /* v8 ignore next -- identical successful dispatches never enter conflict reconciliation */
      onConflict: () => Effect.succeed({ _tag: "Fail", reason: "unused" } as const)
    })
    const { replayed, report } = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-identical-deviation")
        const service = scheduler({ runId: "run-identical-deviation", executor })
        const report = yield* service.run(plan)
        const replayed = yield* service.run(plan)
        return { replayed, report }
      }).pipe(
        Effect.provide(harness({
          runId: "run-identical-deviation",
          executor,
          boundary: deviating(["node_modules/.bin/tool"]),
          reconciliation: recorder
        })),
        Effect.provide(TestStores.layer())
      )
    )
    const built = report.settlements.find((settlement) => settlement.outcome === "built")!
    const clean = report.settlements.find((settlement) => settlement.outcome === "clean")!
    expect(replayed.settlements.every((settlement) => settlement.outcome === "clean")).toBe(true)
    expect(new Set(seen.map((deviation) => deviation.nodeId))).toEqual(new Set([built.nodeId]))
    expect(seen.map((deviation) => deviation.nodeId)).not.toContain(clean.nodeId)
  })

  it("gives the expected-set-deviation event its first consumer", async () => {
    const plan = await runPromise(compile([draft("loose", { writes: ["declared.out"], boundaryMode: "expected" })]))
    const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("done") }
    const seen: Array<Reconciliation.Deviation> = []
    const recorder = Reconciliation.layer({
      onDeviation: (deviation) =>
        Effect.sync(() => {
          seen.push(deviation)
          return { _tag: "FactorOut", paths: deviation.paths, reason: "observed" } as const
        }),
      /* v8 ignore next */
      onConflict: () => Effect.succeed({ _tag: "Fail", reason: "unused" } as const)
    })
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-deviation")
        return yield* Effect.provide(
          scheduler({ runId: "run-deviation", executor }).run(plan),
          harness({
            runId: "run-deviation",
            executor,
            boundary: deviating(["node_modules/.bin/x"]),
            reconciliation: recorder
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ nodeId: "loose", paths: ["node_modules/.bin/x"] })
    expect(report.verdicts[0]?.verdict._tag).toBe("FactorOut")
  })

  it("the default reorders when the deviation names another node's declared write", async () => {
    const plan = await runPromise(compile([
      draft("writer", { writes: ["shared.out"] }),
      draft("deviator", { writes: ["own.out"], boundaryMode: "expected" }),
      draft("later", { inputs: [{ _tag: "Pending", from: "writer" }], writes: ["later.out"] })
    ]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-reorder")
        return yield* Effect.provide(
          scheduler({ runId: "run-reorder", executor, options: { concurrency: { steps: 1 } } }).run(plan),
          harness({
            runId: "run-reorder",
            executor,
            boundary: deviating(["shared.out"]),
            reconciliation: Reconciliation.layerDefault
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    const reorder = report.verdicts.find((entry) => entry.verdict._tag === "Reorder")
    expect(reorder?.verdict).toMatchObject({ _tag: "Reorder", dependsOn: ["writer"] })
  })

  it("the default fails a deviation before journaling exactly one final settlement", async () => {
    const plan = await runPromise(compile([draft("mystery", { boundaryMode: "expected" })]))
    const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("done") }
    const { events, report } = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-mystery")
        const report = yield* Effect.provide(
          scheduler({ runId: "run-mystery", executor }).run(plan),
          harness({
            runId: "run-mystery",
            executor,
            boundary: deviating(["/tmp/whatever"]),
            reconciliation: Reconciliation.layerDefault
          })
        )
        const events = yield* JournalRecords.entries("run-mystery", undefined, 512)
        return { events, report }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.verdicts[0]?.verdict._tag).toBe("Fail")
    expect(outcomes(report)).toEqual({ mystery: "failed" })
    const settlements = events.entries.filter((entry) =>
      entry.eventType === "flows.engine.node-settled" &&
      (entry.payload as { readonly nodeId?: string }).nodeId === "mystery"
    )
    expect(settlements).toHaveLength(1)
    expect(settlements[0]?.payload).toMatchObject({ nodeId: "mystery", outcome: "failed" })
  })

  it("does not conflate distinct path sets whose old space-joined signatures collided", async () => {
    const plan = await runPromise(compile([
      draft("first", { writes: ["first.out"], boundaryMode: "expected" }),
      draft("second", { writes: ["second.out"], boundaryMode: "expected" })
    ]))
    const boundary = Layer.succeed(
      StepBoundary.StepBoundary,
      StepBoundary.make({
        prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
        settle: (prepared) => {
          const first = prepared.descriptor.writeSet.includes("first.out")
          const paths = first ? ["a b", "c"] : ["a", "b c"]
          const diffIdentity = first ? "first-diff" : "second-diff"
          return Effect.succeed({
            declaredOutputs: {},
            diffIdentity,
            wholeTreeWritesVerified: true as const,
            hermeticReadsVerified: true as const,
            deviation: { _tag: "ExpectedSetDeviation" as const, paths, diffIdentity }
          })
        },
        replayOutputs: () => Effect.void
      })
    )
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-signature-collision")
        return yield* scheduler({ runId: "run-signature-collision", executor }).run(plan)
      }).pipe(
        Effect.provide(harness({
          runId: "run-signature-collision",
          executor,
          boundary,
          reconciliation: Reconciliation.layerDefault
        })),
        Effect.provide(TestStores.layer())
      )
    )

    expect(report.verdicts).toHaveLength(2)
    expect(report.verdicts.map((entry) => entry.verdict._tag)).toEqual(["Fail", "Fail"])
    expect(outcomes(report)).toEqual({ first: "failed", second: "failed" })
  })

  it("deduplicates one discovered owner across several deviated paths", async () => {
    const verdict = await runPromise(
      Reconciliation.makeDefault().onDeviation({
        nodeId: "deviator",
        keyDigest: "digest",
        attempt: 0,
        paths: ["a", "b", "a"],
        diffIdentity: "diff",
        declaredBy: { a: "owner", b: "owner" },
        alsoDeviatedBy: []
      })
    )
    expect(verdict).toMatchObject({ _tag: "Reorder", dependsOn: ["owner"] })
  })

  it("the default factors out two nodes that deviated identically", async () => {
    const plan = await runPromise(compile([
      draft("install-a", { boundaryMode: "expected" }),
      draft("install-b", { boundaryMode: "expected" })
    ]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-factor")
        const journal = yield* Journal.Journal
        const together = {
          ...journal,
          entries: (options: Parameters<typeof journal.entries>[0]) =>
            Effect.gen(function*() {
              let page = yield* journal.entries(options)
              if (page.entries.some((entry) => entry.eventType === "flows.engine.expected-set-deviation")) {
                yield* TestDatabase.until(Effect.gen(function*() {
                  page = yield* journal.entries(options)
                  return page.entries.filter((entry) => entry.eventType === "flows.engine.expected-set-deviation")
                    .length >= 2
                }))
              }
              return page
            })
        }
        return yield* Effect.provide(
          scheduler({ runId: "run-factor", executor }).run(plan).pipe(Effect.provideService(Journal.Journal, together)),
          harness({
            runId: "run-factor",
            executor,
            boundary: deviating(["node_modules/left-pad"]),
            reconciliation: Reconciliation.layerDefault
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    // BOTH sides, not just whichever the journal happened to list second.
    // Two steps that produced the same undeclared paths are one symmetric
    // fact, and neither of them is the anomaly the `Fail` default is for.
    expect(report.verdicts.map((entry) => entry.verdict._tag)).toEqual(["FactorOut", "FactorOut"])
    expect(report.verdicts.map((entry) => entry.nodeId).sort()).toEqual(["install-a", "install-b"])
    expect(outcomes(report)).toEqual({ "install-a": "built", "install-b": "built" })
  })

  it("drains deviations past the first page of the journal", async () => {
    // The reconciliation seam reads the journal a page at a time. Concurrent
    // dispatches can journal more records than one page holds, and the final
    // completion has no successor to pick up the remainder — so a deviation
    // beyond the cursor would never reach the seam at all. Filler records push
    // the only real deviation off the first page.
    const plan = await runPromise(compile([draft("late", { boundaryMode: "expected" })]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-paged")
        const journal = yield* Journal.Journal
        yield* Effect.forEach(
          Array.from({ length: 600 }, (_, index) => index),
          (index) =>
            journal.emitDurable(
              JournalRecords.runDecision(
                { runId: "run-paged", lineageId: "run-paged/root", sourceId: `filler/${index}` },
                { index }
              ),
              owner
            ),
          { discard: true }
        )
        return yield* Effect.provide(
          scheduler({ runId: "run-paged", executor }).run(plan),
          harness({
            runId: "run-paged",
            executor,
            boundary: deviating(["node_modules/late"]),
            reconciliation: Reconciliation.layerDefault
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.verdicts.map((entry) => entry.nodeId)).toEqual(["late"])
    expect(report.verdicts[0]?.verdict._tag).toBe("Fail")
  })
})

describe("PlanScheduler elaboration", () => {
  it("rolls a recorded plan back when its durable lifecycle event refuses", async () => {
    const plan = await runPromise(compile([draft("root")], "plan-atomic-record"))
    const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("unused") }
    const observed = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-atomic-record")
        const sql = yield* SqlClient.SqlClient
        const plans = yield* PlanStore.PlanStore
        yield* Dialect.trigger(sql, {
          name: `refuse_plan_record_event`,
          table: `flows_journal_events`,
          event: `BEFORE INSERT`,
          when: `NEW.event_type = 'flows.engine.plan-recorded'`,
          reject: "refused"
        })
        const exit = yield* scheduler({ runId: "run-atomic-record", executor }).record(plan).pipe(Effect.exit)
        return { exit, stored: yield* plans.get(plan.planId) }
      }).pipe(
        Effect.provide(harness({ runId: "run-atomic-record", executor })),
        Effect.provide(TestStores.layerAt(":memory:"))
      )
    )

    expect(observed.exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { code: "store_failed" } }] }
    })
    expect(Option.isNone(observed.stored)).toBe(true)
  })

  it("rolls an appended generation back when its durable lifecycle event refuses", async () => {
    const base = await runPromise(compile([draft("root")], "plan-atomic-append"))
    const grown = await runPromise(Plan.append(base, [
      draft("child", { inputs: [{ _tag: "Pending", from: "root" }] })
    ]))
    const executor: PlanScheduler.Executor = { execute: () => Effect.succeed("unused") }
    const observed = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-atomic-append")
        const sql = yield* SqlClient.SqlClient
        const plans = yield* PlanStore.PlanStore
        const service = scheduler({ runId: "run-atomic-append", executor })
        yield* service.record(base)
        yield* Dialect.trigger(sql, {
          name: `refuse_plan_append_event`,
          table: `flows_journal_events`,
          event: `BEFORE INSERT`,
          when: `NEW.event_type = 'flows.engine.subgraph-appended'`,
          reject: "refused"
        })
        const exit = yield* service.append(grown).pipe(Effect.exit)
        return { exit, stored: Option.getOrThrow(yield* plans.get(base.planId)) }
      }).pipe(
        Effect.provide(harness({ runId: "run-atomic-append", executor })),
        Effect.provide(TestStores.layerAt(":memory:"))
      )
    )

    expect(observed.exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ error: { code: "store_failed" } }] }
    })
    expect(observed.stored).toMatchObject({
      planId: base.planId,
      generation: 0,
      digest: base.digest,
      nodes: [{ id: "root" }]
    })
  })

  it("appends a subgraph to the same plan and journals it", async () => {
    const base = await runPromise(compile([draft("root")]))
    const grown = await runPromise(Plan.append(base, [draft("child", { inputs: [{ _tag: "Pending", from: "root" }] })]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const { events, report } = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-elaborate")
        const service = scheduler({ runId: "run-elaborate", executor })
        yield* service.record(base)
        yield* service.append(grown)
        const report = yield* service.run(grown)
        const events = yield* JournalRecords.entries("run-elaborate", undefined, 512)
        return { events, report }
      }).pipe(Effect.provide(harness({ runId: "run-elaborate", executor })), Effect.provide(TestStores.layer()))
    )
    expect(outcomes(report)).toEqual({ root: "built", child: "built" })
    const appendedEvent = events.entries.find((entry) => entry.eventType === "flows.engine.subgraph-appended")
    expect(appendedEvent?.payload).toMatchObject({ generation: 1, nodeIds: ["child"] })
  })

  it("reports a store refusal as a typed scheduler error", async () => {
    const plan = await runPromise(compile([draft("root")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-store-failure")
        const service = scheduler({ runId: "run-store-failure", executor })
        yield* service.record(plan)
        return yield* Effect.flip(service.append(plan))
      }).pipe(Effect.provide(harness({ runId: "run-store-failure", executor })), Effect.provide(TestStores.layer()))
    )
    expect(failure).toMatchObject({ code: "store_failed" })
  })

  it("self-interrupts when the run was reclaimed under it", async () => {
    const plan = await runPromise(compile([draft("root")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const exit = await runPromise(
      Effect.exit(scheduler({ runId: "run-zombie", executor }).record(plan)).pipe(
        Effect.provide(harness({ runId: "run-zombie", executor })),
        Effect.provide(TestStores.layer())
      )
    )
    // The run row was never claimed by this owner, so the fenced emit reports
    // `fence_lost` and the scheduler stops rather than driving a plan it no
    // longer owns.
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  it("interrupts the run when an in-flight dispatch loses its fence", async () => {
    const plan = await runPromise(compile([draft("running")]))
    const observed = await runPromise(
      Effect.gen(function*() {
        const gate = yield* Latch.make()
        const started = yield* Latch.make()
        const executor: PlanScheduler.Executor = {
          execute: ({ node }) =>
            Latch.open(started).pipe(
              Effect.andThen(Latch.await(gate)),
              Effect.as(node.id)
            )
        }
        yield* activate("run-fence-mid-flight")
        const running = yield* Effect.provide(
          scheduler({ runId: "run-fence-mid-flight", executor }).run(plan),
          harness({ runId: "run-fence-mid-flight", executor })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(started)
        const runs = yield* RunStore.RunStore
        const fenced = yield* runs.transitionOwned("run-fence-mid-flight", owner, "failed")
        yield* Latch.open(gate)
        return { exit: yield* Fiber.await(running), fenced }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(observed.fenced).toEqual({ _tag: "Transitioned" })
    expect(Exit.isFailure(observed.exit) && Cause.hasInterruptsOnly(observed.exit.cause)).toBe(true)
  })

  it("surfaces a host that cannot measure the plan's inputs", async () => {
    const plan = await runPromise(compile([draft("reader", { reads: ["absent.txt"] })]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-unmeasurable")
        return yield* Effect.provide(
          Effect.flip(scheduler({ runId: "run-unmeasurable", executor }).run(plan)),
          harness({ runId: "run-unmeasurable", executor, boundary: StepBoundary.layerTest({ supported: false }) })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(failure).toMatchObject({ code: "boundary_unavailable" })
  })

  it("fails fast on a dispatch SchedulerError and interrupts in-flight siblings", async () => {
    const plan = await runPromise(compile([
      draft("producer", { writes: ["unmeasurable.out"] }),
      draft("slow"),
      draft("unmeasurable", { reads: ["unmeasurable.out"], writes: [] })
    ]))
    const observed = await runPromise(
      Effect.gen(function*() {
        const slowStarted = yield* Latch.make()
        const slowInterrupted = yield* Latch.make()
        const boundary = Layer.succeed(
          StepBoundary.StepBoundary,
          StepBoundary.make({
            prepare: (descriptor) =>
              Effect.gen(function*() {
                if (StepBoundary.exactReads(descriptor).some((entry) => entry.path === "unmeasurable.out")) {
                  yield* Latch.await(slowStarted)
                  return yield* Effect.fail(
                    new StepBoundary.UnsupportedBoundary({
                      code: "unsupported_boundary",
                      message: "test measurement refusal"
                    })
                  )
                }
                return { descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }
              }),
            settle: (prepared) =>
              Effect.succeed({
                declaredOutputs: { paths: prepared.descriptor.writeSet },
                diffIdentity: "scheduler-error-test",
                wholeTreeWritesVerified: true,
                hermeticReadsVerified: true
              }),
            replayOutputs: () => Effect.void
          })
        )
        const executor: PlanScheduler.Executor = {
          execute: ({ node }) =>
            node.id === "producer" ? Effect.succeed("produced") : Latch.open(slowStarted).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Latch.open(slowInterrupted))
            )
        }
        yield* activate("run-dispatch-error")
        const running = yield* Effect.provide(
          scheduler({ runId: "run-dispatch-error", executor }).run(plan),
          harness({ runId: "run-dispatch-error", executor, boundary })
        ).pipe(Effect.forkChild({ startImmediately: true }))
        const exit = yield* Fiber.await(running)
        yield* Latch.await(slowInterrupted)
        return exit
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(Exit.isFailure(observed) ? Cause.squash(observed.cause) : undefined).toMatchObject({
      code: "boundary_unavailable"
    })
  })
})

describe("PlanScheduler invalidation and journal plumbing", () => {
  /** A host whose measurement moves under the run, one prepare at a time. */
  const shifting = () => {
    let counter = 0
    return Layer.succeed(
      StepBoundary.StepBoundary,
      StepBoundary.make({
        prepare: Effect.fn("prepare")(function*(descriptor) {
          counter = counter + 1
          const digest = `measured-${counter}`
          return {
            descriptor,
            readSnapshot: StepBoundary.exactReads(descriptor).map((entry) => ({ path: entry.path, digest }))
          }
        }),
        settle: Effect.fn("settle")(function*(prepared) {
          return {
            declaredOutputs: { paths: prepared.descriptor.writeSet },
            diffIdentity: "shifting",
            wholeTreeWritesVerified: true as const
          }
        }),
        replayOutputs: Effect.fn("replayOutputs")(function*() {})
      })
    )
  }

  it("journals a re-key when the measured inputs move under a rebase", async () => {
    // A preceding producer makes this an output version, not a source. A
    // read of only the node's own future write must instead stay pinned.
    const plan = await runPromise(compile([
      draft("producer", { writes: ["shared.out"] }),
      draft("racer", { reads: ["shared.out"] })
    ]))
    const { events, report } = await runPromise(
      Effect.gen(function*() {
        const seen = yield* Ref.make(0)
        const executor: PlanScheduler.Executor = {
          execute: ({ node }) =>
            node.id === "producer" ? Effect.succeed("produced") : Effect.flatMap(
              Ref.updateAndGet(seen, (count) => count + 1),
              (count) => count === 1 ? Effect.fail(conflict()) : Effect.succeed("landed")
            )
        }
        yield* activate("run-invalidated")
        const report = yield* Effect.provide(
          scheduler({ runId: "run-invalidated", executor }).run(plan),
          harness({ runId: "run-invalidated", executor, boundary: shifting() })
        )
        const events = yield* JournalRecords.entries("run-invalidated", undefined, 512)
        return { events, report }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.settlements.find((node) => node.nodeId === "racer")).toMatchObject({ outcome: "built", rebases: 1 })
    const invalidated = events.entries.filter((entry) => entry.eventType === "flows.engine.node-invalidated")
    expect(invalidated).toHaveLength(1)
    expect(invalidated[0]?.payload).toMatchObject({ nodeId: "racer", reason: "measured-inputs-changed" })
  })

  it("keeps a read of its own future write pinned across a rebase", async () => {
    const plan = await runPromise(compile([draft("update", { reads: ["config"], writes: ["config"] })]))
    const seen: Array<ReadonlyArray<{ readonly path: string; readonly digest: string }>> = []
    const executor: PlanScheduler.Executor = {
      execute: ({ boundary }) =>
        Effect.suspend(() => {
          seen.push(StepBoundary.exactReads(boundary))
          return seen.length === 1 ? Effect.fail(conflict()) : Effect.succeed("landed")
        })
    }
    const { events, report } = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-pinned-update")
        const report = yield* Effect.provide(
          scheduler({ runId: "run-pinned-update", executor }).run(plan),
          harness({ runId: "run-pinned-update", executor, boundary: shifting() })
        )
        return { report, events: yield* JournalRecords.entries("run-pinned-update", undefined, 512) }
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.settlements[0]).toMatchObject({ outcome: "built", rebases: 1 })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual([{ path: "config", digest: "measured-1" }])
    expect(seen[1]).toEqual(seen[0])
    expect(events.entries.filter((entry) => entry.eventType === "flows.engine.node-invalidated")).toEqual([])
  })

  it("reorders onto a writer that has not dispatched yet", async () => {
    const plan = await runPromise(compile([
      draft("deviator", { writes: ["own.out"], boundaryMode: "expected" }),
      draft("writer", { writes: ["shared.out"] })
    ]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-reorder-ahead")
        return yield* Effect.provide(
          scheduler({ runId: "run-reorder-ahead", executor, options: { concurrency: { steps: 1 } } }).run(plan),
          harness({
            runId: "run-reorder-ahead",
            executor,
            boundary: admissionBoundary,
            reconciliation: Reconciliation.layer(Reconciliation.make(Reconciliation.makeDefault()))
          })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.verdicts[0]?.verdict).toMatchObject({ _tag: "Reorder", dependsOn: ["writer"] })
    // The ordering edge bound work that had not dispatched: `writer` still ran.
    expect(outcomes(report)).toEqual({ deviator: "built", writer: "built" })
  })

  it("ignores journalled deviations it cannot attribute to a node of this plan", async () => {
    const plan = await runPromise(compile([draft("solo")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-foreign")
        const journal = yield* Journal.Journal
        yield* journal.emitDurable(
          JournalRecords.expectedSetDeviation({
            runId: "run-foreign",
            lineageId: "run-foreign/root",
            sourceId: "foreign/malformed"
          }, {}),
          owner
        )
        yield* journal.emitDurable(
          JournalRecords.expectedSetDeviation({
            runId: "run-foreign",
            lineageId: "run-foreign/root",
            sourceId: "foreign/unknown"
          }, {
            stepKeyDigest: "not-a-node-of-this-plan",
            attempt: 1,
            paths: ["x"],
            diffIdentity: "d"
          }),
          owner
        )
        return yield* Effect.provide(
          scheduler({ runId: "run-foreign", executor }).run(plan),
          harness({ runId: "run-foreign", executor, reconciliation: Reconciliation.layerDefault })
        )
      }).pipe(Effect.provide(TestStores.layer()))
    )
    expect(report.verdicts).toEqual([])
    expect(outcomes(report)).toEqual({ solo: "built" })
  })

  it("reports a journal failure that is not merely a lost fence as a store failure", async () => {
    const plan = await runPromise(compile([draft("solo")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-journal-broken")
        return yield* Effect.flip(scheduler({ runId: "run-journal-broken", executor }).record(plan)).pipe(
          // A CLOSED journal, not a reclaimed run: the scheduler reports it
          // instead of self-interrupting, because nothing took the run away.
          Effect.provide(Layer.succeed(Journal.Journal, Journal.makeNoop()))
        )
      }).pipe(Effect.provide(harness({ runId: "run-journal-broken", executor })), Effect.provide(TestStores.layer()))
    )
    expect(failure).toMatchObject({ code: "store_failed" })
  })

  it("normalizes a transaction-level journal refusal as a store failure", async () => {
    const plan = await runPromise(compile([draft("solo")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const refusal = new Journal.JournalError({ code: "unknown", message: "transaction refused" })
    const closed = Journal.makeNoop({
      transact: (() => Effect.fail(refusal)) as Journal.Service["transact"]
    })
    const failure = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-transaction-broken")
        return yield* Effect.flip(scheduler({ runId: "run-transaction-broken", executor }).record(plan)).pipe(
          Effect.provideService(Journal.Journal, closed)
        )
      }).pipe(
        Effect.provide(harness({ runId: "run-transaction-broken", executor })),
        Effect.provide(TestStores.layer())
      )
    )
    expect(failure).toMatchObject({ code: "store_failed", cause: refusal })
  })

  it("is reachable as a layer", async () => {
    const plan = await runPromise(compile([draft("solo")]))
    const executor: PlanScheduler.Executor = { execute: ({ node }) => Effect.succeed(node.id) }
    const report = await runPromise(
      Effect.gen(function*() {
        yield* activate("run-layer")
        const service = yield* PlanScheduler.PlanScheduler
        return yield* service.run(plan)
      }).pipe(
        Effect.provide(PlanScheduler.layer({ runId: "run-layer", owner, sourceId: "scheduler/run-layer" })),
        Effect.provide(harness({ runId: "run-layer", executor })),
        Effect.provide(TestStores.layer())
      )
    )
    expect(outcomes(report)).toEqual({ solo: "built" })
  })
})
