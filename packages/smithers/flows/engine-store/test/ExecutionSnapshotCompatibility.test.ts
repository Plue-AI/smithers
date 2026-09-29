import { describe, expect, it } from "@effect/vitest"
import * as Sha256 from "@smthrs/crypto/Sha256"
import * as RunMigrations from "@smthrs/run-store/Migrations"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Retention from "../src/Retention.ts"
import * as RunCatalogRead from "../src/RunCatalogRead.ts"
import { fixture, onFile, state } from "./ExecutionSnapshotFixture.ts"

describe("execution observation compatibility", () => {
  it.effect("retains the standalone run-store deletion path without an engine spawn-edge table", () =>
    fixture((file) =>
      Effect.gen(function*() {
        const legacyFile = `${file}.standalone`
        yield* onFile(
          legacyFile,
          Effect.gen(function*() {
            yield* RunMigrations.run
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, finished_at_ms, state_json)
          VALUES ('old', 'completed', 0, 1, ${state})`
          })
        )
        yield* onFile(
          legacyFile,
          Effect.gen(function*() {
            expect((yield* Retention.collect({ olderThanMs: 2 })).runs).toEqual(["old"])
            const sql = yield* SqlClient.SqlClient
            expect(yield* sql`SELECT run_id, deleted FROM flows_run_changes`).toEqual([{ run_id: "old", deleted: 1 }])
          })
        )
      })
    ))

  it.effect("preserves opaque waits admitted by the existing engine writer after reopening", () =>
    fixture((file) =>
      Effect.gen(function*() {
        const reason = "reason".repeat(300)
        const token = "token".repeat(500)
        yield* onFile(
          file,
          Effect.gen(function*() {
            const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
            const engine = yield* DurableEngineState.make
            const owner = { hostId: "host", pid: 1, nonce: "owner" }
            yield* runs.create("long-wait", state)
            yield* runs.claimAndOwn("long-wait", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1)
            expect((yield* engine.park("long-wait", { reason, token }, owner))._tag).toBe("Parked")
          })
        )
        yield* onFile(
          file,
          Effect.gen(function*() {
            const reader = yield* ExecutionSnapshot.make()
            const catalog = yield* RunCatalogRead.make()
            const expected = { kind: "other", reason, tokenDigest: Sha256.digestSync(token), wakeAtMs: null }
            expect((yield* reader.read(["long-wait"])).snapshots[0]).toMatchObject({ waiting: expected })
            expect((yield* catalog.listRuns()).runs[0]!.waiting).toEqual(expected)
            // The raw token resolves the wait; no read surface may carry it.
            expect(JSON.stringify(yield* reader.read(["long-wait"]))).not.toContain(token)
            expect(JSON.stringify(yield* catalog.listRuns())).not.toContain(token)
          })
        )
      })
    ))

  it.effect("accepts its own cursor when all admitted identity fields need JSON escaping", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.gen(function*() {
          const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
          const sql = yield* SqlClient.SqlClient
          const parentRunId = "\u0003".repeat(1024)
          const lineageId = "\u0002".repeat(1024)
          const flowName = "\u0004".repeat(1024)
          const waitingReason = "\u0005".repeat(1024)
          const ids = ["\u0001".repeat(1023) + "a", "\u0001".repeat(1023) + "b"]
          yield* runs.create(parentRunId, state)
          for (const [roundOrdinal, id] of ids.entries()) {
            yield* runs.create(id, JSON.stringify({ version: 1, flowName, payload: {} }), {
              parentRunId,
              lineageId,
              roundOrdinal
            })
            yield* sql`UPDATE flows_runs SET waiting_reason = ${waitingReason} WHERE run_id = ${id}`
          }
          const catalog = yield* RunCatalogRead.make()
          const filters = { status: "pending" as const, flowName, parentRunId, lineageId, waitingReason }
          const first = yield* catalog.listRuns({ filters, limit: 1 })
          expect(first.runs.map((run) => run.runId)).toEqual([ids[0]])
          expect(first.cursor!.length).toBeGreaterThan(32768)
          const second = yield* catalog.listRuns({ filters, limit: 1, cursor: first.cursor! })
          expect(second.runs.map((run) => run.runId)).toEqual([ids[1]])
          expect(second.cursor).toBeNull()
        })
      )
    ))
})
