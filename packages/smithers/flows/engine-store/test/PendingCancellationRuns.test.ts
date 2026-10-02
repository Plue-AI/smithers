import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as TestStores from "../src/test/TestStores.ts"

const views = new Map<string, DurableEngineState.MemoryRunView>([
  ["z", { status: "pending", owner: null, createdAtMs: 1, cancelRequestedAtMs: 0 }],
  ["a", { status: "pending", owner: null, createdAtMs: 2, cancelRequestedAtMs: 1 }],
  ["b", { status: "pending", owner: null, createdAtMs: 2, cancelRequestedAtMs: 2 }],
  ["unrequested", { status: "pending", owner: null, createdAtMs: 0, cancelRequestedAtMs: null }],
  ["running", {
    status: "running",
    owner: { hostId: "running", pid: 1, nonce: "live" },
    heartbeatAtMs: 0,
    createdAtMs: 0,
    cancelRequestedAtMs: 0
  }],
  ["suspended", { status: "suspended", owner: null, createdAtMs: 0, cancelRequestedAtMs: 0 }],
  ["completed", { status: "completed", owner: null, createdAtMs: 0, cancelRequestedAtMs: 0 }],
  ["failed", { status: "failed", owner: null, createdAtMs: 0, cancelRequestedAtMs: 0 }],
  ["cancelled", { status: "cancelled", owner: null, createdAtMs: 0, cancelRequestedAtMs: 0 }]
])
const assertQuery = (state: DurableEngineState.Service) =>
  Effect.gen(function*() {
    const z = { runId: "z", createdAtMs: 1 }
    const a = { runId: "a", createdAtMs: 2 }
    const b = { runId: "b", createdAtMs: 2 }
    expect(yield* state.pendingCancellationRuns(64)).toEqual([z, a, b])
    expect(yield* state.pendingCancellationRuns(2)).toEqual([z, a])
    expect(yield* state.pendingCancellationRuns(0)).toEqual([])
    expect(yield* state.pendingCancellationRuns(2, z)).toEqual([a, b])
    expect(yield* state.pendingCancellationRuns(2, a)).toEqual([b])
    expect(yield* state.pendingCancellationRuns(2, b)).toEqual([])
    expect(yield* state.pendingCancellationRuns(2, undefined, z)).toEqual([z])
    expect(yield* state.pendingCancellationRuns(2, z, a)).toEqual([a])
    expect(yield* state.pendingCancellationRuns(2, a, a)).toEqual([])
    expect(Option.getOrThrow(yield* state.pendingCancellationTail())).toEqual(b)
    for (const limit of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const exit = yield* Effect.exit(state.pendingCancellationRuns(limit))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          name: "RangeError",
          message: "Pending cancellation limit must be a non-negative safe integer"
        })
      }
    }
  })

describe("indexed pending cancellation discovery", () => {
  it.effect("matches memory rows, timestamp-zero requests and cursor boundaries", () =>
    assertQuery(DurableEngineState.makeMemory({ listRuns: () => views.entries() })))

  it.effect("keeps absent legacy intent out and orders legacy creation timestamps at zero", () =>
    Effect.gen(function*() {
      const rows = new Map<string, DurableEngineState.MemoryRunView>([
        ["absent-intent", { status: "pending", owner: null }],
        ["b", { status: "pending", owner: null, cancelRequestedAtMs: 0 }],
        ["a", { status: "pending", owner: null, cancelRequestedAtMs: 0 }]
      ])
      const state = DurableEngineState.makeMemory({ listRuns: () => rows.entries() })
      expect(yield* state.pendingCancellationRuns(64)).toEqual([
        { runId: "a", createdAtMs: 0 },
        { runId: "b", createdAtMs: 0 }
      ])
      expect(Option.getOrThrow(yield* state.pendingCancellationTail())).toEqual({ runId: "b", createdAtMs: 0 })
      expect(yield* DurableEngineState.makeMemory().pendingCancellationRuns(64)).toEqual([])
      expect(yield* DurableEngineState.makeMemory().pendingCancellationTail()).toEqual(Option.none())
    }))

  it.effect("matches real database rows and excludes completed/deleted requests", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      const state = yield* DurableEngineState.DurableEngineState
      for (const [runId, view] of views) {
        yield* sql`INSERT INTO flows_runs ${
          sql.insert({
            run_id: runId,
            status: view.status,
            created_at_ms: view.createdAtMs!,
            state_json: JSON.stringify({ version: 1, flowName: `absent/${runId}`, payload: {} }),
            cancel_requested_at_ms: view.cancelRequestedAtMs!,
            heartbeat_at_ms: view.heartbeatAtMs ?? null,
            owner_host_id: view.owner?.hostId ?? null,
            owner_pid: view.owner?.pid ?? null,
            owner_nonce: view.owner?.nonce ?? null
          })
        }`
      }
      yield* assertQuery(state)
      yield* sql`DELETE FROM flows_runs WHERE run_id = 'b'`
      expect(Option.getOrThrow(yield* state.pendingCancellationTail())).toEqual({ runId: "a", createdAtMs: 2 })
      yield* sql`UPDATE flows_runs SET status = 'cancelled' WHERE run_id IN ('a', 'z')`
      expect(yield* state.pendingCancellationRuns(64)).toEqual([])
      expect(yield* state.pendingCancellationTail()).toEqual(Option.none())
    }).pipe(Effect.provide(Layer.provideMerge(DurableEngineState.layer, TestStores.database)), Effect.scoped))

  it.effect("uses a creation-order partial index rather than scanning settled history", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient
      for (let offset = 0; offset < 5_000; offset += 500) {
        yield* sql`INSERT INTO flows_runs ${
          sql.insert(Array.from({ length: 500 }, (_, index) => ({
            run_id: `history-${offset + index}`,
            status: "cancelled",
            created_at_ms: 0,
            state_json: JSON.stringify({ version: 1, flowName: "history", payload: {} }),
            cancel_requested_at_ms: 0
          })))
        }`
      }
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, cancel_requested_at_ms)
      VALUES ('requested', 'pending', 2, ${JSON.stringify({ version: 1, flowName: "absent", payload: {} })}, 0)`
      yield* sql`ANALYZE flows_runs`
      const select = sql`SELECT run_id, created_at_ms FROM flows_runs
      ${Dialect.isPostgres(sql) ? sql`` : sql`INDEXED BY flows_runs_pending_cancel_idx`}
      WHERE status = 'pending' AND cancel_requested_at_ms IS NOT NULL
        AND (created_at_ms, run_id) > (1, 'a') AND (created_at_ms, run_id) <= (2, 'z')
      ORDER BY created_at_ms, run_id LIMIT 64`
      if (Dialect.isPostgres(sql)) {
        const plan = yield* sql`EXPLAIN (FORMAT JSON) ${select}`
        const evidence = JSON.stringify(plan)
        expect(evidence).toContain("flows_runs_pending_cancel_idx")
        expect(evidence).not.toContain("Seq Scan")
        console.log("pending-cancel PostgreSQL plan", evidence)
      } else {
        const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN ${select}`
        const evidence = plan.map((row) => row.detail).join(" ")
        expect(evidence).toContain("SEARCH flows_runs USING INDEX flows_runs_pending_cancel_idx")
        expect(evidence).not.toContain("TEMP B-TREE")
        console.log("pending-cancel SQLite plan", evidence)
      }
    }).pipe(Effect.provide(TestStores.database), Effect.scoped))
})
