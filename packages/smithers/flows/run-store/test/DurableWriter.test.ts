import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import type * as Consensus from "@smthrs/journal/Consensus"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import { Clock, Effect, Exit, Metric, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"

const owner = { hostId: "host", pid: 1, nonce: "owner" }
const retryOptions = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }
const secret = "private SQL text and bound payload"
const busy = () =>
  new SqlError.SqlError({
    reason: new SqlError.LockTimeoutError({ cause: { code: "SQLITE_BUSY", message: secret } })
  })

const migrated = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | DurableWriter.DurableWriter | Consensus.Consensus>
) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(SqlConsensus.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provideService(Metric.MetricRegistry, new Map())
  ))

const activate = (runs: RunStore.Service) =>
  Effect.gen(function*() {
    yield* runs.create("run", "{}")
    const now = yield* Clock.currentTimeMillis
    expect(yield* runs.claimAndOwn("run", { status: "pending", owner: null, heartbeatAtMs: null }, owner, now))
      .toMatchObject({ _tag: "Activated" })
  })

const throughput = Effect.map(Metric.value(ObservabilityMetric.runThroughput), (state) => state.count)

describe("nested store writes", () => {
  // Port of review robustness-2: inject the same structured busy failure at
  // the statement boundary, now with a real writer and SQLite savepoints.
  for (const kind of ["run", "attempt"] as const) {
    it(`replays the whole outer transaction after a nested ${kind} conflict`, () =>
      migrated(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const writer = DurableWriter.make(sql, retryOptions)
        const runs = yield* RunStore.make
        yield* activate(runs)
        yield* sql`CREATE TABLE replay_witness (value INTEGER NOT NULL)`
        let statements = 0
        const injected = new Proxy(sql, {
          apply(target, thisArg, args) {
            const statement = Reflect.apply(target, thisArg, args)
            if (
              Array.isArray(args[0]) &&
              args[0].join("").includes(`INSERT INTO flows_${kind === "run" ? "runs" : "attempts"}`)
            ) {
              return Effect.suspend(() => ++statements === 1 ? Effect.fail(busy()) : statement)
            }
            return statement
          }
        })
        const stores = yield* Effect.all({ runs: RunStore.make, attempts: AttemptStore.make }).pipe(
          Effect.provideService(SqlClient.SqlClient, injected),
          Effect.provideService(DurableWriter.DurableWriter, writer)
        )
        let outerBodies = 0
        const exit = yield* Effect.exit(writer.write(Effect.gen(function*() {
          outerBodies += 1
          yield* sql`INSERT INTO replay_witness VALUES (${outerBodies})`
          if (kind === "run") {
            yield* stores.runs.create("nested", "{}")
          } else {
            expect(
              yield* stores.attempts.put({
                runId: "run",
                stepKeyDigest: "step",
                attempt: 0,
                state: "running",
                startedAtMs: 0,
                meta: {}
              }, owner)
            ).toEqual({ _tag: "Inserted" })
          }
        })))
        expect(outerBodies).toBe(2)
        expect(statements).toBe(2)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(yield* sql`SELECT value FROM replay_witness`).toEqual([{ value: 2 }])
        if (kind === "run") {
          expect((yield* stores.runs.get("nested")).status).toBe("pending")
        } else {
          expect(Option.getOrThrow(yield* stores.attempts.get({ runId: "run", stepKeyDigest: "step", attempt: 0 })))
            .toMatchObject({ state: "running" })
        }
      })))

    it(`preserves redacted ${kind} persistence classification`, () =>
      migrated(Effect.gen(function*() {
        for (const code of ["busy", "io"] as const) {
          const writer = DurableWriter.DurableWriter.of({
            write: () => Effect.fail(new DurableWriter.DatabaseError({ code, cause: { message: secret } }))
          })
          const stores = yield* Effect.all({ runs: RunStore.make, attempts: AttemptStore.make }).pipe(
            Effect.provideService(DurableWriter.DurableWriter, writer)
          )
          const operation: Effect.Effect<void, RunStore.RunStoreError | AttemptStore.AttemptStoreError> = kind === "run"
            ? stores.runs.create("nested", "{}")
            : stores.attempts.put({
              runId: "run",
              stepKeyDigest: "step",
              attempt: 0,
              state: "running",
              startedAtMs: 0,
              meta: {}
            }, owner).pipe(Effect.asVoid)
          const failure = yield* Effect.flip(operation)
          expect(failure.cause).toMatchObject({ cause: { _tag: "@smthrs/database/DatabaseError", code } })
          expect(JSON.stringify(failure)).not.toContain(secret)
        }
      })))
  }

  it("does not count a terminal transition when the outer transaction rolls back", () =>
    migrated(Effect.gen(function*() {
      const runs = yield* RunStore.make
      const writer = yield* DurableWriter.DurableWriter
      yield* activate(runs)
      const before = yield* throughput
      const failure = yield* Effect.flip(writer.write(Effect.gen(function*() {
        expect(yield* runs.transitionOwned("run", owner, "completed")).toEqual({ _tag: "Transitioned" })
        return yield* Effect.fail("rollback")
      })))
      expect(failure).toBe("rollback")
      expect((yield* runs.get("run")).status).toBe("running")
      expect((yield* throughput) - before).toBe(0)
    })))

  it("counts a terminal transition once after the final outer commit", () =>
    migrated(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql, retryOptions)
      // The strategy writes through the same injected writer as the store, so
      // the lease statements see the same injected failures.
      const runs = yield* RunStore.make.pipe(
        Effect.provide(SqlConsensus.layer),
        Effect.provideService(DurableWriter.DurableWriter, writer)
      )
      yield* activate(runs)
      const before = yield* throughput
      let outerBodies = 0
      const during: Array<number> = []
      yield* writer.write(Effect.gen(function*() {
        outerBodies += 1
        expect(yield* runs.transitionOwned("run", owner, "completed")).toEqual({ _tag: "Transitioned" })
        during.push(yield* throughput)
        if (outerBodies === 1) return yield* Effect.fail(busy())
      }))
      expect(outerBodies).toBe(2)
      expect((yield* runs.get("run")).status).toBe("completed")
      expect((yield* throughput) - before).toBe(1)
      expect(during).toEqual([before, before])
    })))
})
