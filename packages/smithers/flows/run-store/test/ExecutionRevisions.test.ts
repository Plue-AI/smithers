import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import type * as Consensus from "@smthrs/journal/Consensus"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { Effect, Layer, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Migrations from "../src/Migrations.ts"
import { initial } from "../src/migrations/0001_initial.ts"
import { lineage } from "../src/migrations/0002_lineage.ts"
import * as RunStore from "../src/RunStore.ts"

const owner = { hostId: "driver", pid: 42, nonce: "one" }
const onFile = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient | DurableWriter.DurableWriter | Consensus.Consensus>
) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(SqlConsensus.layer),
      Effect.provide(Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename })))
    )
  )

describe("durable execution revisions", () => {
  it.effect("upgrades the current head, reopens, fences acknowledgement and retains cross-process tombstones", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "execution-revisions-")))
      const filename = join(directory, "engine.db")
      try {
        yield* onFile(
          filename,
          Effect.gen(function*() {
            yield* DatabaseMigrations.run([JournalMigrations.set, {
              ...Migrations.set,
              migrations: { "0001_initial": initial, "0002_lineage": lineage }
            }])
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('a', 'pending', 1, '{}'), ('b', 'pending', 1, '{}')`
          })
        )
        const source = yield* onFile(
          filename,
          Effect.gen(function*() {
            expect(yield* Migrations.run).toEqual([[1003, "run-store_execution_revisions"], [
              1004,
              "run-store_waiting_request"
            ]])
            const sql = yield* SqlClient.SqlClient
            expect(yield* sql`SELECT run_id, revision, deleted FROM flows_run_changes ORDER BY revision`).toEqual([
              { run_id: "a", revision: 1, deleted: 0 },
              { run_id: "b", revision: 2, deleted: 0 }
            ])
            const rows = yield* sql<{ source: string; revision: number }>`SELECT source, revision FROM flows_run_source`
            expect(rows[0]!.source).toMatch(/^[0-9a-f]{32}$/)
            expect(rows[0]!.revision).toBe(2)
            const runs = yield* RunStore.make
            expect(yield* runs.acknowledgeCancel("a", owner, 2)).toBe(false)
            yield* runs.claimAndOwn("a", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 2)
            expect(yield* runs.acknowledgeCancel("a", owner, 2)).toBe(false)
            yield* runs.requestCancel("a", 3)
            expect(yield* runs.acknowledgeCancel("a", { ...owner, nonce: "stale" }, 4)).toBe(false)
            expect(yield* runs.acknowledgeCancel("a", owner, 4)).toBe(true)
            expect(yield* runs.acknowledgeCancel("a", owner, 5)).toBe(true)
            yield* runs.transitionOwned("a", owner, "cancelled", "{}")
            expect(yield* runs.acknowledgeCancel("a", owner, 6)).toBe(false)
            const row = yield* sql<
              { cancel_acknowledgement_json: string }
            >`SELECT cancel_acknowledgement_json FROM flows_runs WHERE run_id = 'a'`
            expect(JSON.parse(row[0]!.cancel_acknowledgement_json)).toEqual({ observedAtMs: 4, owner })
            expect(yield* RunStore.makeNoop().acknowledgeCancel("a", owner, 1)).toBe(false)
            const invalid = yield* Effect.result(runs.acknowledgeCancel("", owner, 1))
            expect(Result.isFailure(invalid)).toBe(true)
            const before = yield* sql`SELECT * FROM flows_run_source`
            expect(
              Result.isFailure(yield* Effect.result(sql`UPDATE flows_runs SET run_id = 'renamed' WHERE run_id = 'b'`))
            ).toBe(true)
            expect(yield* sql`SELECT * FROM flows_run_source`).toEqual(before)
            return rows[0]!.source
          })
        )
        yield* Effect.sync(() =>
          execFileSync(process.execPath, [
            "--input-type=module",
            "-e",
            `
          import { DatabaseSync } from 'node:sqlite';
          const db = new DatabaseSync(process.argv[1]);
          db.exec("DELETE FROM flows_runs WHERE run_id = 'a'");
          db.close();
        `,
            filename
          ], { env: { PATH: process.env.PATH }, stdio: "pipe" })
        )
        yield* onFile(
          filename,
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const at = yield* sql<{ source: string; revision: number }>`SELECT source, revision FROM flows_run_source`
            expect(at[0]).toEqual({ source, revision: 8 })
            expect(yield* sql`SELECT run_id, revision, deleted FROM flows_run_changes ORDER BY revision`).toEqual([
              { run_id: "b", revision: 2, deleted: 0 },
              { run_id: "a", revision: 8, deleted: 1 }
            ])
            yield* sql`UPDATE flows_run_source SET revision = 9007199254740991`
            const runs = yield* RunStore.make
            const overflow = yield* Effect.result(runs.create("overflow", "{}"))
            expect(Result.isFailure(overflow)).toBe(true)
            expect(yield* sql`SELECT run_id FROM flows_runs WHERE run_id = 'overflow'`).toEqual([])
            expect(yield* sql`SELECT deleted FROM flows_run_changes WHERE run_id = 'a'`).toEqual([{ deleted: 1 }])
            yield* sql`DELETE FROM flows_run_source`
            const mutations: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
              runs.create("missing-source", "{}"),
              sql`UPDATE flows_runs SET state_json = '{"new":true}' WHERE run_id = 'b'`,
              sql`DELETE FROM flows_runs WHERE run_id = 'b'`
            ]
            for (const mutation of mutations) expect(Result.isFailure(yield* Effect.result(mutation))).toBe(true)
            expect(yield* sql`SELECT state_json FROM flows_runs WHERE run_id = 'b'`).toEqual([{ state_json: "{}" }])
          })
        )
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))
})
