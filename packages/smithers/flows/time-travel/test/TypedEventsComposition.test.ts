import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as RunMigrations from "@smthrs/run-store/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

describe("history authority in a minimal composition", () => {
  it.effect("forks real SQLite history without requiring the engine spawn-edge extension", () =>
    Effect.gen(function*() {
      yield* DatabaseMigrations.run([JournalMigrations.set, RunMigrations.set])
      const sql = yield* SqlClient.SqlClient
      const store = yield* SqlTimeTravelStore.make
      expect(yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name = 'flows_run_parents'`).toEqual([])
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('parent', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})`
      const fork = yield* store.createFork("parent", { lineageId: "parent/root", seq: 0 })
      expect(fork.runId).toBe("parent:fork:0:1")
      expect(
        yield* sql`SELECT run_id, status, parent_run_id, lineage_id, round_ordinal
        FROM flows_runs WHERE run_id = 'parent:fork:0:1'`
      ).toEqual([{
        run_id: "parent:fork:0:1",
        status: "pending",
        parent_run_id: "parent",
        lineage_id: "parent:fork:0:1",
        round_ordinal: 0
      }])
    }).pipe(Effect.provide(TestDatabase.layer)))
})
