import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Statement from "effect/unstable/sql/Statement"
import { DatabaseSync } from "node:sqlite"
import * as RunCatalogRead from "../src/RunCatalogRead.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { fixture, onFile, state } from "./ExecutionSnapshotFixture.ts"

const statuses = ["pending", "running", "suspended", "completed", "failed", "cancelled"] as const
const reasons = [null, "timer", "event", "approval", "quota", "human", "custom"] as const
const model = (size: number) =>
  Array.from({ length: size }, (_, index) => ({
    runId: `r${index.toString().padStart(5, "0")}`,
    createdAtMs: Math.floor(index / 4),
    status: statuses[index % statuses.length]!,
    flowName: `flow${Math.floor(index / 5) % 3}`,
    parentRunId: index % 4 === 0 ? null : "r00000",
    lineageId: `r${(index % 5).toString().padStart(5, "0")}`,
    waitingReason: reasons[Math.floor(index / 15) % reasons.length]!,
    roundOrdinal: Math.floor(index / 5)
  }))

type Model = ReturnType<typeof model>[number]
const matches = (row: Model, filter: RunCatalogRead.Filters) =>
  (filter.status === undefined || row.status === filter.status) &&
  (filter.flowName === undefined || row.flowName === filter.flowName) &&
  (filter.parentRunId === undefined || row.parentRunId === filter.parentRunId) &&
  (filter.lineageId === undefined || row.lineageId === filter.lineageId) &&
  (filter.waitingReason === undefined || row.waitingReason === filter.waitingReason) &&
  (filter.createdAfterMs === undefined || row.createdAtMs >= filter.createdAfterMs) &&
  (filter.createdBeforeMs === undefined || row.createdAtMs <= filter.createdBeforeMs)

describe("bounded run listing", () => {
  for (const size of [100, 1000, 5000]) {
    it.effect(
      `exhausts filtered cursor pages against an independent ${size}-run reference with bounded decoding and SQL`,
      () =>
        fixture((file) =>
          Effect.gen(function*() {
            const reference = model(size)
            yield* onFile(
              file,
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                yield* sql.withTransaction(Effect.forEach(reference, (row) =>
                  sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, parent_run_id, lineage_id, round_ordinal, waiting_reason,
              owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
            VALUES (${row.runId}, ${row.status}, ${row.createdAtMs}, ${
                    JSON.stringify({ version: 1, flowName: row.flowName, payload: {} })
                  },
              ${row.parentRunId}, ${row.lineageId}, ${row.roundOrdinal}, ${row.waitingReason},
              ${row.status === "running" ? "host" : null}, ${row.status === "running" ? 1 : null},
              ${row.status === "running" ? "nonce" : null}, ${row.status === "running" ? 1 : null})`, {
                  discard: true
                }))
              })
            )
            // Reopen independently: no in-process catalog or write-time model is used by the reader.
            yield* onFile(
              file,
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                let statements = 0
                let decodedRows = 0
                const plans = new Map<string, ReadonlyArray<string>>()
                const measure = (query: Statement.Statement<object>) =>
                  query.pipe(Effect.map((rows) => {
                    statements++
                    return rows.map((row) => {
                      if (!("state_json" in row)) return row
                      return new Proxy(row, {
                        get(target, key, receiver) {
                          if (key === "state_json") decodedRows++
                          return Reflect.get(target, key, receiver)
                        }
                      })
                    })
                  }))
                const instrumented = new Proxy(sql, {
                  apply(target, thisArg, args) {
                    return measure(Reflect.apply(target, thisArg, args))
                  },
                  get(target, key, receiver) {
                    if (key === "reserve") {
                      return Effect.map(target.reserve, (connection) =>
                        new Proxy(connection, {
                          get(connection, key, receiver) {
                            if (key !== "executeUnprepared") return Reflect.get(connection, key, receiver)
                            return (...args: Parameters<typeof connection.executeUnprepared>) =>
                              connection.executeUnprepared(...args).pipe(Effect.tap(() => {
                                statements++
                                return Effect.void
                              }))
                          }
                        }))
                    }
                    if (key !== "unsafe") return Reflect.get(target, key, receiver)
                    return (...args: Parameters<typeof sql.unsafe>) => {
                      const query = target.unsafe(...args)
                      return Effect.gen(function*() {
                        if (args[0].includes("flows_runs_listing")) {
                          const mask = args[0].match(/flows_runs_listing_(\d+)/)![1]!
                          const key = `${mask}:${args[0].includes(" > (?, ?)")}:${args[0].includes(" >= ?")}:${
                            args[0].includes(" <= ?")
                          }`
                          if (!plans.has(key)) {
                            const plan = yield* target.unsafe<{ detail: string }>(
                              `EXPLAIN QUERY PLAN ${args[0]}`,
                              args[1]
                            )
                            const details = plan.map((row) => row.detail)
                            expect(details.some((detail) => detail.includes(`flows_runs_listing_${mask}`))).toBe(true)
                            expect(details.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false)
                            plans.set(key, details)
                          }
                        }
                        return yield* measure(query)
                      })
                    }
                  }
                })
                const catalog = yield* RunCatalogRead.make().pipe(
                  Effect.provideService(SqlClient.SqlClient, instrumented)
                )
                const filters: Array<RunCatalogRead.Filters> = []
                const sample = {
                  status: "suspended",
                  flowName: "flow1",
                  parentRunId: "r00000",
                  lineageId: "r00000",
                  waitingReason: "timer"
                } as const
                const keys = Object.keys(sample) as Array<keyof typeof sample>
                for (let mask = 0; mask < 32; mask++) {
                  const filter = Object.fromEntries(
                    keys.filter((_, index) => (mask & (1 << index)) !== 0).map((key) => [key, sample[key]])
                  )
                  filters.push(filter, { ...filter, createdAfterMs: 3, createdBeforeMs: 7 })
                }
                filters.push(
                  ...statuses.map((status) => ({ status })),
                  ...reasons.map((waitingReason) => ({ waitingReason })),
                  ...Array.from({ length: 5 }, (_, index) => ({ lineageId: `r${index.toString().padStart(5, "0")}` })),
                  { parentRunId: null },
                  { lineageId: "absent" },
                  { flowName: "absent" },
                  { createdAfterMs: 3 },
                  { createdBeforeMs: 7 },
                  { createdAfterMs: 3, createdBeforeMs: 7 },
                  { createdAfterMs: 10, createdBeforeMs: 3 }
                )
                let pages = 0
                for (const filter of filters) {
                  const expected = reference.filter((row) => matches(row, filter)).map((row) => row.runId)
                  for (const limit of [7, 23]) {
                    const seen: Array<string> = []
                    let queryPages = 0
                    let cursor: string | undefined
                    do {
                      // The independent model bounds traversal even if a
                      // broken cursor repeats pages without ever reaching EOF.
                      queryPages++
                      expect(queryPages).toBeLessThanOrEqual(Math.max(1, Math.ceil(expected.length / limit)))
                      statements = 0
                      decodedRows = 0
                      const page = yield* catalog.listRuns({
                        filters: filter,
                        limit,
                        ...(cursor === undefined ? {} : { cursor })
                      })
                      expect(statements).toBe(4)
                      expect(decodedRows).toBeLessThanOrEqual(limit + 1)
                      expect(decodedRows).toBe(page.runs.length + (page.cursor === null ? 0 : 1))
                      seen.push(...page.runs.map((row) => row.runId))
                      cursor = page.cursor ?? undefined
                      pages++
                    } while (cursor !== undefined)
                    expect(seen).toEqual(expected)
                    expect(new Set(seen).size).toBe(seen.length)
                  }
                }
                expect(plans.size).toBeGreaterThanOrEqual(64)
                process.stdout.write(
                  `${
                    JSON.stringify({
                      size,
                      pages,
                      queryPlans: plans.size,
                      statementsPerPage: 4,
                      decodedBound: "limit + 1",
                      temporarySorts: 0,
                      unfilteredPlan: plans.get("0:false:false:false"),
                      allFiltersPlan: plans.get("31:false:false:false"),
                      rangedPlan: plans.get("31:false:true:true")
                    })
                  }\n`
                )
              })
            )
          })
        ),
      // The 5000-run matrix traverses 7558 pages and more than 30,000 SQL
      // statements. On the loaded remediation host it exhausted 60 seconds
      // both in the full coverage run and alone without coverage (13.65 CPU
      // seconds across 105.34 wall seconds for the isolated file). This tests
      // row, query and decoding bounds, not elapsed time. Keep every case and
      // bound cursor progress above, with a finite budget for the large matrix.
      size === 5000 ? 180_000 : 60_000
    )
  }

  it.effect("defines live-cursor inserts, deletes, status changes, equal keys and independent source rejection", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          for (const id of ["a", "c", "e", "g"]) {
            yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (${id}, 'pending', 1, ${state})`
          }
          const catalog = yield* RunCatalogRead.make()
          const first = yield* catalog.listRuns({ filters: { status: "pending" }, limit: 2 })
          expect(first.runs.map((row) => row.runId)).toEqual(["a", "c"])
          expect(first.cursor).not.toBeNull()
          const peer = new DatabaseSync(file)
          try {
            peer.prepare(
              "INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (?, 'pending', 1, ?)"
            ).run("b", state)
            peer.prepare(
              "INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (?, 'pending', 1, ?)"
            ).run("d", state)
            peer.exec(
              "DELETE FROM flows_runs WHERE run_id = 'e'; UPDATE flows_runs SET status = 'completed' WHERE run_id IN ('a', 'g')"
            )
          } finally {
            peer.close()
          }
          const next = yield* catalog.listRuns({ filters: { status: "pending" }, cursor: first.cursor!, limit: 2 })
          expect(next.runs.map((row) => row.runId)).toEqual(["d"])
          expect(next.cursor).toBeNull()
          expect(next.revision).toBeGreaterThan(first.revision)
          const equivalent = yield* catalog.listRuns({
            filters: { status: "pending" },
            cursor: first.cursor!,
            limit: 1
          })
          expect(equivalent.runs.map((row) => row.runId)).toEqual(["d"])
          for (const size of [65535, 65536]) {
            const padded = first.cursor! + " ".repeat(size - first.cursor!.length)
            expect(
              (yield* catalog.listRuns({ filters: { status: "pending" }, cursor: padded })).runs.map((row) => row.runId)
            ).toEqual(["d"])
          }
          expect((yield* Effect.flip(catalog.listRuns({ cursor: " ".repeat(65537) }))).code).toBe("invalid_options")
          const canonical = yield* catalog.listRuns({ filters: { status: "pending", flowName: "test" }, limit: 1 })
          expect(
            (yield* catalog.listRuns({
              filters: { flowName: "test", status: "pending" },
              cursor: canonical.cursor!,
              limit: 1
            })).runs[0]!.runId
          ).toBe("c")
          expect((yield* Effect.flip(catalog.listRuns({ cursor: first.cursor! }))).code).toBe("invalid_cursor")
          for (const cursor of ["1", "broken", "{}", JSON.stringify({ ...JSON.parse(first.cursor!), version: 2 })]) {
            expect((yield* Effect.flip(catalog.listRuns({ cursor }))).code).toBe("invalid_cursor")
          }
          yield* fixture((other) =>
            onFile(
              other,
              Effect.gen(function*() {
                const otherCatalog = yield* RunCatalogRead.make()
                expect(
                  (yield* Effect.flip(otherCatalog.listRuns({ filters: { status: "pending" }, cursor: first.cursor! })))
                    .code
                ).toBe("source_changed")
              })
            )
          )
          expect((yield* catalog.listRuns()).runs.map((row) => row.runId)).toEqual(["a", "b", "c", "d", "g"])
          for (const limit of [199, 200]) expect((yield* catalog.listRuns({ limit })).runs).toHaveLength(5)
          for (
            const options of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { cursor: 1 }, { offset: 1 }, {
              filters: { unknown: "value" }
            }]
          ) {
            expect((yield* Effect.flip(catalog.listRuns(options as never))).code).toBe("invalid_options")
          }
        })
      )
    ))

  it.effect("surfaces malformed selected rows and preserves SQL defects and interruption without leaking transactions", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('a', 'pending', 1, ${state})`
          const original = new Error("page SQL failure")
          for (const injected of [Effect.interrupt, Effect.die(original), Effect.fail(original)]) {
            const wrapped = new Proxy(sql, {
              get(target, key, receiver) {
                return key === "unsafe"
                  ? () => injected
                  : Reflect.get(target, key, receiver)
              }
            })
            const broken = yield* RunCatalogRead.make().pipe(Effect.provideService(SqlClient.SqlClient, wrapped))
            const result = yield* Effect.exit(broken.listRuns())
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result)) {
              if (injected === Effect.interrupt) expect(Cause.hasInterruptsOnly(result.cause)).toBe(true)
              else expect(Cause.squash(result.cause)).toMatchObject({ code: "list_failed", cause: original })
            }
            const real = yield* RunCatalogRead.make()
            expect((yield* real.listRuns()).runs).toHaveLength(1)
          }
          yield* sql`UPDATE flows_runs SET state_json = '{}' WHERE run_id = 'a'`
          const real = yield* RunCatalogRead.make()
          expect(yield* Effect.flip(real.listRuns())).toMatchObject({
            code: "list_failed",
            cause: { code: "decode_failed", cause: { _tag: "SchemaError" } }
          })
        })
      )
    ))
})

it.effect("filters and paginates the injected database against an independent model", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const reference = model(100)
    yield* sql.withTransaction(Effect.forEach(reference, (row) =>
      sql`
      INSERT INTO flows_runs(run_id,status,created_at_ms,state_json,parent_run_id,lineage_id,round_ordinal,waiting_reason,owner_host_id,owner_pid,owner_nonce,heartbeat_at_ms)
      VALUES(${row.runId},${row.status},${row.createdAtMs},${
        JSON.stringify({ version: 1, flowName: row.flowName, payload: {} })
      },${row.parentRunId},${row.lineageId},${row.roundOrdinal},${row.waitingReason},${
        row.status === "running" ? "host" : null
      },${row.status === "running" ? 1 : null},${row.status === "running" ? "nonce" : null},${
        row.status === "running" ? 1 : null
      })`, { discard: true }))
    const catalog = yield* RunCatalogRead.make()
    for (let mask = 0; mask < 32; mask++) {
      const filters: RunCatalogRead.Filters = {
        ...(mask & 1 ? { status: "pending" as const } : {}),
        ...(mask & 2 ? { flowName: "flow0" } : {}),
        ...(mask & 4 ? { parentRunId: "r00000" } : {}),
        ...(mask & 8 ? { lineageId: "r00000" } : {}),
        ...(mask & 16 ? { waitingReason: "timer" } : {})
      }
      const collected: Array<string> = []
      let cursor: string | undefined
      do {
        const page = yield* catalog.listRuns({ filters, limit: 7, ...(cursor === undefined ? {} : { cursor }) })
        collected.push(...page.runs.map((row) => row.runId))
        expect(collected.length).toBeLessThanOrEqual(100)
        cursor = page.cursor ?? undefined
      } while (cursor !== undefined)
      expect(collected).toEqual(reference.filter((row) => matches(row, filters)).map((row) => row.runId))
    }
  }).pipe(Effect.provide(TestStores.database), Effect.scoped))
