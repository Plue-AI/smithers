import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Clock, Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"

const layer = RunStore.layer.pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

/**
 * Observes every top-level statement the store issues; it changes nothing.
 * Composed fragments (a parenthesised predicate) are not statements.
 */
const observed = (queries: Array<string>) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      return new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          if (typeof statement.compile === "function") {
            const [query] = statement.compile()
            if (/^\s*(?:SELECT|UPDATE|INSERT|DELETE)/i.test(query)) queries.push(query)
          }
          return statement
        }
      }) as SqlClient.SqlClient
    })
  )

const observedLayer = (queries: Array<string>) =>
  RunStore.layer.pipe(
    Layer.provideMerge(Layer.provideMerge(observed(queries), Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
  )

/** Creates `rounds` rounds of `lineageId`, settling every round but the last. */
const settledHistory = (store: RunStore.Service, sql: SqlClient.SqlClient, lineageId: string, rounds: number) =>
  Effect.gen(function*() {
    const state = JSON.stringify({ text: "x".repeat(4096) })
    for (let ordinal = 0; ordinal < rounds; ordinal++) {
      yield* store.create(`${lineageId}-${ordinal}`, state, { lineageId, roundOrdinal: ordinal })
    }
    yield* sql`
      UPDATE flows_runs SET status = 'completed', started_at_ms = created_at_ms, finished_at_ms = created_at_ms
      WHERE lineage_id = ${lineageId} AND round_ordinal < ${rounds - 1}
    `
  })

describe("logical run rounds", () => {
  it.effect("rolls back earlier round requests when a later SQL update fails, then retries", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* store.create("root", "{}", { lineageId: "root", roundOrdinal: 0 })
      yield* store.create("next", "{}", { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
      yield* Dialect.trigger(sql, {
        name: `fail_lineage_cancel`,
        table: `flows_runs`,
        event: `BEFORE UPDATE OF cancel_requested_at_ms`,
        when: `NEW.run_id = 'next'`,
        reject: "synthetic cancellation failure"
      })
      const error = yield* Effect.flip(store.requestCancelLineage("root", 100))
      expect(error.code).toBe("constraint")
      expect((yield* store.get("root")).cancelRequestedAtMs).toBeNull()
      expect((yield* store.get("next")).cancelRequestedAtMs).toBeNull()
      yield* TestDatabase.dropTrigger(sql, "fail_lineage_cancel")
      expect(yield* store.requestCancelLineage("root", 200)).toEqual({ _tag: "CancelRequested", requestedAtMs: 200 })
      expect((yield* store.lineage("root")).map((row) => row.cancelRequestedAtMs)).toEqual([200, 200])
    }).pipe(Effect.provide(layer)))

  it.effect("validates logical read and cancellation inputs before mutating any row", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("root", "{}")
      for (const value of ["", "\ud800", 1, null]) {
        expect((yield* Effect.flip(store.lineage(value as never))).code).toBe("invalid_run")
        expect((yield* Effect.flip(store.latestRound(value as never))).code).toBe("invalid_run")
        expect((yield* Effect.flip(store.requestCancelLineage(value as never, 100))).code).toBe("invalid_run")
      }
      for (const time of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect((yield* Effect.flip(store.requestCancelLineage("root", time))).code).toBe("invalid_run")
      }
      expect((yield* store.get("root")).cancelRequestedAtMs).toBeNull()
    }).pipe(Effect.provide(layer)))

  it.effect("a new request dominates an already-requested round without overwriting its time", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("root", "{}", { lineageId: "root", roundOrdinal: 0 })
      yield* store.create("next", "{}", { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
      yield* store.requestCancel("next", 100)
      expect(yield* store.requestCancelLineage("root", 200)).toEqual({ _tag: "CancelRequested", requestedAtMs: 200 })
      expect((yield* store.get("next")).cancelRequestedAtMs).toBe(100)
      expect((yield* store.get("root")).cancelRequestedAtMs).toBe(200)
    }).pipe(Effect.provide(layer)))

  it.effect("records a logical cancellation atomically without changing completed round history", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const owner = { hostId: "seed", pid: 1, nonce: "seed" }
      yield* store.create("root", "{}", { lineageId: "root", roundOrdinal: 0 })
      yield* store.claimAndOwn(
        "root",
        { status: "pending", owner: null, heartbeatAtMs: null },
        owner,
        yield* Clock.currentTimeMillis
      )
      yield* store.create("next", "{}", { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
      yield* store.transitionOwned("root", owner, "completed", "{}")
      expect(yield* store.requestCancelLineage("root", 100)).toEqual({ _tag: "CancelRequested", requestedAtMs: 100 })
      expect(yield* store.requestCancelLineage("next", 200)).toEqual({ _tag: "AlreadyRequested", requestedAtMs: 100 })
      expect((yield* store.get("root")).cancelRequestedAtMs).toBeNull()
      expect((yield* store.get("root")).status).toBe("completed")
      expect((yield* store.get("next")).cancelRequestedAtMs).toBe(100)
      expect(yield* store.requestCancelLineage("missing", 300)).toEqual({ _tag: "NotFound" })
    }).pipe(Effect.provide(layer)))

  it.effect("resolves every round from any round, excluding fork ancestry and other lineages", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("root", "{}") // A pre-lineage root is still round zero.
      yield* store.create("second", "{}", { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
      yield* store.create("third", "{}", { lineageId: "root", roundOrdinal: 2, parentRunId: "second" })
      yield* store.create("fork", "{}", { parentRunId: "root", lineageId: "fork", roundOrdinal: 0 })
      yield* store.create("other", "{}")
      for (const id of ["root", "second", "third"]) {
        expect((yield* store.lineage(id)).map((row) => row.runId)).toEqual(["root", "second", "third"])
        expect((yield* store.latestRound(id)).runId).toBe("third")
      }
      expect((yield* store.lineage("fork")).map((row) => row.runId)).toEqual(["fork"])
      expect((yield* store.lineage("other")).map((row) => row.runId)).toEqual(["other"])
      expect(yield* store.lineage("missing")).toEqual([])
      expect((yield* store.latestRound("other")).runId).toBe("other")
      expect((yield* Effect.flip(store.latestRound("missing"))).code).toBe("not_found_row")
    }).pipe(Effect.provide(layer)))

  it.effect("excludes a same-named run that belongs to an independent lineage", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("shared-name", "{}", { lineageId: "independent-lineage", roundOrdinal: 0 })
      yield* store.create("target", "{}", { lineageId: "shared-name", roundOrdinal: 0 })
      expect((yield* store.lineage("target")).map((row) => row.runId)).toEqual(["target"])
      expect((yield* store.lineage("shared-name")).map((row) => row.runId)).toEqual(["shared-name"])
      expect(yield* store.requestCancelLineage("target", 100)).toEqual({ _tag: "CancelRequested", requestedAtMs: 100 })
      expect((yield* store.get("target")).cancelRequestedAtMs).toBe(100)
      expect((yield* store.get("shared-name")).cancelRequestedAtMs).toBeNull()
    }).pipe(Effect.provide(layer)))

  it.effect("cancels one live round with statements and payload independent of settled history", () => {
    const queries: Array<string> = []
    return Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* settledHistory(store, sql, "short", 2)
      yield* settledHistory(store, sql, "long", 1_000)
      queries.length = 0
      expect(yield* store.requestCancelLineage("short-0", 100)).toEqual({ _tag: "CancelRequested", requestedAtMs: 100 })
      const shortStatements = queries.splice(0)
      expect(yield* store.requestCancelLineage("long-0", 100)).toEqual({ _tag: "CancelRequested", requestedAtMs: 100 })
      const longStatements = queries.splice(0)
      // One guarded set-based UPDATE, however many rounds already settled.
      expect(longStatements).toEqual(shortStatements)
      expect(longStatements).toHaveLength(1)
      // Membership is resolved from metadata only; no state payload is read.
      for (const query of longStatements) expect(query).not.toContain("state_json")
      expect((yield* store.get("long-999")).cancelRequestedAtMs).toBe(100)
      expect((yield* store.get("long-0")).cancelRequestedAtMs).toBeNull()
      // A repeat classifies the miss from one metadata read, still flat.
      queries.length = 0
      expect(yield* store.requestCancelLineage("long-0", 200)).toEqual({ _tag: "AlreadyRequested", requestedAtMs: 100 })
      const repeat = queries.splice(0)
      expect(repeat).toHaveLength(2)
      for (const query of repeat) expect(query).not.toContain("state_json")
    }).pipe(Effect.provide(observedLayer(queries)))
  })

  it.effect("reports the latest round's ending once every round settled", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* settledHistory(store, sql, "done", 3)
      yield* sql`
        UPDATE flows_runs SET status = 'failed', started_at_ms = created_at_ms, finished_at_ms = created_at_ms
        WHERE run_id = 'done-2'
      `
      expect(yield* store.requestCancelLineage("done-0", 100)).toEqual({ _tag: "Terminal", status: "failed" })
      expect(yield* store.requestCancelLineage("done-2", 100)).toEqual({ _tag: "Terminal", status: "failed" })
    }).pipe(Effect.provide(layer)))

  it.effect("an earlier live round's request dominates a later settled round", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* store.create("live-0", "{}", { lineageId: "live", roundOrdinal: 0 })
      yield* store.create("live-1", "{}", { lineageId: "live", roundOrdinal: 1, parentRunId: "live-0" })
      expect(yield* store.requestCancel("live-0", 50)).toEqual({ _tag: "CancelRequested", requestedAtMs: 50 })
      yield* sql`
        UPDATE flows_runs SET status = 'cancelled', started_at_ms = created_at_ms, finished_at_ms = created_at_ms
        WHERE run_id = 'live-1'
      `
      expect(yield* store.requestCancelLineage("live-1", 100)).toEqual({ _tag: "AlreadyRequested", requestedAtMs: 50 })
    }).pipe(Effect.provide(layer)))

  it.effect("fails persistence_failed when the lineage update silently misses a live unrequested round", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* settledHistory(store, sql, "stuck", 2)
      yield* Dialect.trigger(sql, {
        name: `ignore_lineage_cancel`,
        table: `flows_runs`,
        event: `BEFORE UPDATE OF cancel_requested_at_ms`,
        ignore: true
      })
      const error = yield* Effect.flip(store.requestCancelLineage("stuck-0", 100))
      expect(error).toMatchObject({
        method: "requestCancelLineage",
        code: "persistence_failed",
        cause: { runId: "stuck-0", stage: "write-invariant" }
      })
    }).pipe(Effect.provide(layer)))

  it.effect("fails decode_failed when a lineage member carries an unknown status", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      yield* settledHistory(store, sql, "odd", 2)
      yield* TestDatabase.checks(sql, false)
      yield* sql`UPDATE flows_runs SET status = 'not-a-status', cancel_requested_at_ms = 1 WHERE run_id = 'odd-1'`
      yield* TestDatabase.checks(sql, true)
      const error = yield* Effect.flip(store.requestCancelLineage("odd-0", 100))
      expect(error).toMatchObject({ method: "requestCancelLineage", code: "decode_failed" })
    }).pipe(Effect.provide(layer)))
})
