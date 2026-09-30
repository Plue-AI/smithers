import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const views = new Map<string, DurableEngineState.MemoryRunView>([
  ["z", { status: "pending", owner: null, flowName: "child", createdAtMs: 1 }],
  ["a", { status: "pending", owner: null, flowName: "child", createdAtMs: 2 }],
  ["b", { status: "pending", owner: null, flowName: "child", createdAtMs: 2 }],
  ["other", { status: "pending", owner: null, flowName: "other", createdAtMs: 0 }],
  ["completed", { status: "completed", owner: null, flowName: "child", createdAtMs: 0 }]
])
const assertQuery = (state: DurableEngineState.Service) =>
  Effect.gen(function*() {
    expect(yield* state.pendingRuns("child")).toEqual([{ runId: "z", createdAtMs: 1 }, { runId: "a", createdAtMs: 2 }, {
      runId: "b",
      createdAtMs: 2
    }])
    expect(yield* state.pendingRuns("child", 2)).toEqual([{ runId: "z", createdAtMs: 1 }, {
      runId: "a",
      createdAtMs: 2
    }])
    expect(yield* state.pendingRuns("child", 2, { createdAtMs: 1, runId: "z" })).toEqual([{
      runId: "a",
      createdAtMs: 2
    }, {
      runId: "b",
      createdAtMs: 2
    }])
    expect(yield* state.pendingRuns("child", 2, { createdAtMs: 2, runId: "a" })).toEqual([{
      runId: "b",
      createdAtMs: 2
    }])
    expect(yield* state.pendingRuns("child", 2, { createdAtMs: 2, runId: "b" })).toEqual([])
    expect(yield* state.pendingRuns("child", 0)).toEqual([])
    expect(yield* state.pendingRuns("absent", 2)).toEqual([])
    expect(yield* state.pendingRuns("child", 2, undefined, { createdAtMs: 1, runId: "z" })).toEqual([{
      runId: "z",
      createdAtMs: 1
    }])
    expect(yield* state.pendingRuns("child", 3, { createdAtMs: 1, runId: "z" }, { createdAtMs: 2, runId: "a" }))
      .toEqual([{ runId: "a", createdAtMs: 2 }])
    expect(Option.getOrThrow(yield* state.pendingRunTail("child"))).toEqual({ runId: "b", createdAtMs: 2 })
    expect(yield* state.pendingRuns("child", undefined, undefined, undefined, 2)).toEqual([{
      runId: "z",
      createdAtMs: 1
    }])
    expect(yield* state.pendingRuns("child", undefined, undefined, undefined, 1)).toEqual([])
    expect(Option.getOrThrow(yield* state.pendingRunTail("child", 2))).toEqual({ runId: "z", createdAtMs: 1 })
    expect((yield* state.pendingRunTail("child", 1))._tag).toBe("None")
    expect(yield* state.staleRunningRuns(10)).toEqual([])
    expect((yield* state.pendingRunTail("absent"))._tag).toBe("None")
  })
describe("pending admission query", () => {
  it.effect("orders and caps memory rows while filtering flow and status", () =>
    assertQuery(DurableEngineState.makeMemory({ listRuns: () => views.entries() })))
  it.effect("orders legacy memory views without creation timestamps at zero", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory({
        listRuns: () =>
          new Map<string, DurableEngineState.MemoryRunView>([
            ["b", { status: "pending", owner: null, flowName: "child" }],
            ["a", { status: "pending", owner: null, flowName: "child" }]
          ]).entries()
      })
      expect(yield* state.pendingRuns("child", undefined, undefined, undefined, 1)).toEqual([{
        runId: "a",
        createdAtMs: 0
      }, { runId: "b", createdAtMs: 0 }])
    }))
  it.effect("uses the existing flow listing index for bounded pending recovery", () =>
    withCrypto(
      Effect.gen(function*() {
        const sql = yield* SqlClient
        const plan = yield* sql<
          { detail: string }
        >`EXPLAIN QUERY PLAN SELECT run_id, created_at_ms FROM flows_runs INDEXED BY flows_runs_listing_3
      WHERE status = 'pending' AND execution_flow = 'child' AND created_at_ms < 30
      AND (created_at_ms > 1 OR (created_at_ms = 1 AND run_id > 'a'))
      AND (created_at_ms < 20 OR (created_at_ms = 20 AND run_id <= 'z'))
      ORDER BY created_at_ms, run_id LIMIT 64`
        expect(plan.map((row) => row.detail).join(" ")).toContain("SEARCH flows_runs USING INDEX flows_runs_listing_3")
        expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
      }).pipe(Effect.provide(TestStores.layerAt(":memory:")), Effect.scoped)
    ))
  it.effect("returns nothing without a memory enumerator", () =>
    Effect.gen(function*() {
      expect(yield* DurableEngineState.makeMemory().pendingRuns("child", 5)).toEqual([])
    }))
  it.effect("orders and caps real database rows while filtering flow and status", () =>
    withCrypto(
      Effect.gen(function*() {
        const sql = yield* SqlClient
        for (const [runId, view] of views) {
          yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, lineage_id, round_ordinal)
          VALUES (${runId}, ${view.status}, ${view.createdAtMs!},
            ${JSON.stringify({ version: 1, flowName: view.flowName, payload: {} })}, ${runId}, 0)`
        }
        yield* assertQuery(yield* DurableEngineState.DurableEngineState)
      }).pipe(Effect.provide(Layer.provideMerge(DurableEngineState.layer, TestStores.database)), Effect.scoped)
    ))
})
