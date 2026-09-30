import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan, StepKey } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import * as Crypto from "effect/Crypto"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanMergeStore from "../src/PlanMergeStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { runPromise } from "./Sha256.ts"

const owner = { hostId: "merge-recovery", pid: 17, nonce: "merge-recovery" }
const runId = "merge-run"
const service = () => PlanScheduler.make({ runId, owner, sourceId: "merge-recovery" })
const draft = (id: string, kind: KeyMaterial.KeyMaterial["kind"] = "sealed"): Plan.NodeDraft => ({
  id,
  material: { version: KeyMaterial.version, kind, body: id, inputs: [], layers: [], capabilities: [] },
  effects: { reads: [], writes: ["shared"], boundaryMode: "hard" },
  conflictStrategy: "lane",
  runtimeStrategy: "stop-merge"
})
const activate = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  yield* runs.create(runId, "{}")
  const row = yield* runs.get(runId)
  yield* runs.claimAndOwn(runId, { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }, owner, 1)
})
type Execute = (input: PlanScheduler.NodeInput) => Effect.Effect<unknown, unknown, Journal.Journal>
const host = (execute: Execute) =>
  Layer.mergeAll(
    StepBoundary.layerTest(),
    Layer.effect(PlanScheduler.NodeExecutor)(Effect.gen(function*() {
      const journal = yield* Journal.Journal
      return {
        execute: (input: PlanScheduler.NodeInput) =>
          execute(input).pipe(Effect.provideService(Journal.Journal, journal))
      }
    })),
    Layer.succeed(
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
  )
const open = <A, E>(
  database: string,
  execute: Execute,
  effect: Effect.Effect<A, E, PlanScheduler.Requirements | SqlClient.SqlClient>
) => runPromise(effect.pipe(Effect.provide(host(execute)), Effect.provide(TestStores.layerAt(database))))
const outcomes = (report: PlanScheduler.Report) =>
  Object.fromEntries(report.settlements.map((node) => [node.nodeId, node.outcome]))
const conflict = () =>
  Effect.fail(new WorkspaceSandbox.MaterializationConflict({ paths: ["shared"], message: "competing landing" }))
const waitForWinner = Effect.gen(function*() {
  while (true) {
    const page = yield* JournalRecords.entries(runId, undefined, 512)
    if (
      page.entries.some((entry) =>
        entry.eventType === "flows.engine.node-settled" &&
        (entry.payload as { nodeId?: string }).nodeId === "a"
      )
    ) return
    yield* Effect.yieldNow
  }
})

describe("merge recovery across independent SQLite openings", () => {
  it("interrupts if cancellation lands between merge recovery and input admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-merge-input-fence-"))
    const calls: Array<string> = []
    try {
      const base = await runPromise(Plan.compile({ planId: "merge-plan", flow: "test/Merge", nodes: [draft("a")] }))
      await open(
        join(root, "state.sqlite"),
        ({ node }) => Effect.sync(() => calls.push(node.id)),
        Effect.gen(function*() {
          yield* activate
          yield* service().record(base)
          const runs = yield* RunStore.RunStore
          const real = yield* PlanMergeStore.PlanMergeStore
          const result = yield* service().run(base).pipe(
            Effect.provideService(PlanMergeStore.PlanMergeStore, {
              ...real,
              list: (identity, expectedOwner) =>
                real.list(identity, expectedOwner).pipe(Effect.tap(() => runs.requestCancel(runId, 2)))
            }),
            Effect.exit
          )
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expect(Cause.hasInterruptsOnly(result.cause)).toBe(true)
          expect(calls).toEqual([])
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql`SELECT * FROM flows_plan_input_heads`).toEqual([])
        })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retains the intent when merge key derivation fails and recovers on a healthy host", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-merge-key-refusal-"))
    const database = join(root, "state.sqlite")
    const calls: Array<string> = []
    const execute: Execute = ({ node }) =>
      Effect.gen(function*() {
        calls.push(node.id)
        if (node.id === "b") {
          yield* waitForWinner
          return yield* conflict()
        }
        return node.id
      })
    try {
      const base = await runPromise(
        Plan.compile({ planId: "merge-plan", flow: "test/Merge", nodes: [draft("a"), draft("b")] })
      )
      await open(
        database,
        execute,
        Effect.gen(function*() {
          yield* activate
          yield* service().record(base)
          const real = yield* Crypto.Crypto
          const refusing: Crypto.Crypto = {
            ...real,
            digest: (algorithm, bytes) =>
              new TextDecoder().decode(bytes).includes("stopped")
                ? Effect.succeed(new Uint8Array(0))
                : real.digest(algorithm, bytes)
          }
          expect(yield* Effect.flip(service().run(base).pipe(Effect.provideService(Crypto.Crypto, refusing))))
            .toMatchObject({ code: "elaboration_failed" })
          const sql = yield* SqlClient.SqlClient
          expect(yield* sql`SELECT generation FROM flows_plans`).toEqual([{ generation: 0 }])
          expect((yield* sql`SELECT * FROM flows_plan_merge_intents`).length).toBe(1)
          expect(yield* sql`SELECT * FROM flows_plan_merge_completions`).toEqual([])
        })
      )
      const resumed = await open(database, execute, service().run(base))
      expect(outcomes(resumed)).toEqual({ a: "clean", b: "skipped", "b+merge": "built" })
      expect(calls).toEqual(["a", "b", "b+merge"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const kind of ["sealed", "compensable"] as const) {
    it(`preserves ${kind} stopped outcomes, multiple merges, and ordinary user merge-like names`, async () => {
      const root = await mkdtemp(join(tmpdir(), "smithers-merge-recovery-"))
      const database = join(root, "state.sqlite")
      const calls: Array<string> = []
      const execute: Execute = ({ node }) =>
        Effect.gen(function*() {
          calls.push(node.id)
          if (["b", "c"].includes(node.id)) return yield* conflict()
          return node.id
        })
      try {
        const base = await runPromise(Plan.compile({
          planId: "merge-plan",
          flow: "test/Merge",
          nodes: [
            draft("a", kind),
            draft("b", kind),
            draft("c", kind),
            ...["b+merge", "b+merge#1"].map((id) => ({
              ...draft(id, kind),
              effects: { reads: [], writes: [], boundaryMode: "hard" as const }
            }))
          ]
        }))
        const first = await open(
          database,
          execute,
          Effect.gen(function*() {
            yield* activate
            yield* service().record(base)
            return yield* service().run(base)
          })
        )
        // `b` and `c` settle concurrently and each stopped node's merge is
        // appended in settlement order, which the scheduler does not fix. The
        // claim is one merge per stopped node, beside the user's merge-like names.
        expect([...first.appended].sort()).toEqual(["b+merge#2", "c+merge"])
        expect(outcomes(first)).toEqual({
          a: "built",
          b: "skipped",
          c: "skipped",
          "b+merge": "built",
          "b+merge#1": "built",
          "b+merge#2": "built",
          "c+merge": "built"
        })
        const before = [...calls]
        for (const stale of [false, true, false]) {
          const resumed = await open(
            database,
            execute,
            Effect.gen(function*() {
              const plans = yield* PlanStore.PlanStore
              const loaded = Option.getOrThrow(yield* plans.get(base.planId))
              return yield* service().run(stale ? base : loaded)
            })
          )
          expect(resumed.digest).toBe(first.digest)
          expect(resumed.appended).toEqual([])
          expect(outcomes(resumed)).toEqual(
            Object.fromEntries(
              Object.entries(outcomes(first)).map(([id, outcome]) => [id, outcome === "built" ? "clean" : outcome])
            )
          )
          expect(resumed.settlements.filter((node) => ["b", "c"].includes(node.nodeId)))
            .toEqual(first.settlements.filter((node) => ["b", "c"].includes(node.nodeId)))
        }
        expect(calls).toEqual(before)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  for (const frontier of ["intent", "input", "plan", "journal", "completion"] as const) {
    it(`rolls back an injected ${frontier} failure and resumes without repeating stopped work`, async () => {
      const root = await mkdtemp(join(tmpdir(), "smithers-merge-rollback-"))
      const database = join(root, "state.sqlite")
      const calls: Array<string> = []
      const execute: Execute = ({ node }) =>
        Effect.gen(function*() {
          calls.push(node.id)
          if (node.id === "b") {
            yield* waitForWinner
            return yield* conflict()
          }
          return node.id
        })
      try {
        const base = await runPromise(
          Plan.compile({ planId: "merge-plan", flow: "test/Merge", nodes: [draft("a"), draft("b")] })
        )
        await open(
          database,
          execute,
          Effect.gen(function*() {
            yield* activate
            yield* service().record(base)
            const sql = yield* SqlClient.SqlClient
            const target = {
              intent: "BEFORE INSERT ON flows_plan_merge_intents",
              input: "BEFORE INSERT ON flows_plan_input_generations WHEN NEW.generation = 1",
              plan: "BEFORE UPDATE ON flows_plans WHEN NEW.generation = 1",
              journal: "BEFORE INSERT ON flows_journal_events WHEN NEW.event_type = 'flows.engine.subgraph-appended'",
              completion: "BEFORE INSERT ON flows_plan_merge_completions"
            }[frontier]
            yield* sql.unsafe(
              `CREATE TRIGGER fail_merge ${target} BEGIN SELECT RAISE(ABORT, 'injected merge failure'); END`
            )
            expect(yield* Effect.flip(service().run(base))).toMatchObject({ code: "store_failed" })
            expect(yield* sql`SELECT generation FROM flows_plans`).toEqual([{ generation: 0 }])
            expect(yield* sql`SELECT generation FROM flows_plan_input_generations`).toEqual([{ generation: 0 }])
            expect(yield* sql`SELECT * FROM flows_plan_merge_completions`).toEqual([])
            expect((yield* sql`SELECT * FROM flows_plan_merge_intents`).length).toBe(frontier === "intent" ? 0 : 1)
            expect(yield* sql`SELECT * FROM flows_journal_events WHERE event_type = 'flows.engine.subgraph-appended'`)
              .toEqual([])
            yield* TestDatabase.dropTrigger(sql, "fail_merge")
          })
        )
        expect(calls).toEqual(["a", "b"])
        const resumed = await open(database, execute, service().run(base))
        expect(outcomes(resumed)).toEqual({ a: "clean", b: "skipped", "b+merge": "built" })
        expect(resumed.appended).toEqual(["b+merge"])
        expect(calls).toEqual(["a", "b", "b+merge"])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it("finishes a pending merge when its last peer is passively skipped during recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-merge-passive-"))
    const database = join(root, "state.sqlite")
    const calls: Array<string> = []
    try {
      const b = draft("b")
      const a = draft("a")
      const base = await runPromise(Plan.compile({
        planId: "merge-plan",
        flow: "test/Merge",
        nodes: [
          { ...draft("upstream"), effects: { reads: [], writes: [], boundaryMode: "hard" } },
          b,
          { ...a, material: { ...a.material, inputs: [{ _tag: "Pending", from: "upstream" }] } }
        ]
      }))
      await open(
        database,
        () => Effect.void,
        Effect.gen(function*() {
          yield* activate
          yield* service().record(base)
          const inputs = yield* PlanInputStore.PlanInputStore
          const identity = {
            runId,
            planId: base.planId,
            baseDigest: base.digest,
            environmentDigest: yield* StepKey.environmentIdentity()
          }
          yield* inputs.record({ ...identity, generation: 0 }, {
            version: 1,
            generation: 0,
            nodes: base.nodes.map((node) => ({ id: node.id, key: node.key, reads: [] })),
            pins: []
          }, owner)
          const merges = yield* PlanMergeStore.PlanMergeStore
          yield* merges.intend(identity, {
            version: 1,
            nodeId: "b",
            nodeKey: base.nodes.find((node) => node.id === "b")!.key,
            dispatchKey: "dispatch",
            attempts: 1,
            rebases: 0,
            peers: ["a"]
          }, owner)
        })
      )
      const report = await open(database, ({ node }) =>
        Effect.gen(function*() {
          calls.push(node.id)
          if (node.id === "upstream") return yield* Effect.fail("upstream failure")
          return node.id
        }), service().run(base))
      expect(report.appended).toEqual(["b+merge"])
      expect(outcomes(report)).toEqual({ upstream: "failed", b: "skipped", a: "skipped", "b+merge": "built" })
      expect(calls).toEqual(["upstream", "b+merge"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
