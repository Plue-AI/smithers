/** PostgreSQL run inventory; requires the package-owned postgresInventory target. */
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { ControlRuntime, type RunQuery } from "../src/ControlRuntime.ts"
import { durable, fileBundle } from "./DurableStack.ts"

const url = process.env.SMITHERS_TEST_PG_URL

// The default unit suite needs no PostgreSQL service.
describe.skipIf(!url)("run inventory on PostgreSQL (requires SMITHERS_TEST_PG_URL)", () => {
  it("selects runs by run ids through one JSON parameter, ignoring duplicates and absent ids", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const sql = yield* SqlClient.SqlClient
        for (const [runId, createdAt] of [["z", 10], ["c", 30], ["a", 20], ["d", 30], ["b", 40]] as const) {
          yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES (${runId}, 'pending', ${createdAt}, ${JSON.stringify({ flowName: "window/test" })})`
        }
        const walk = (request: Omit<RunQuery, "cursor" | "limit">) =>
          Effect.gen(function*() {
            const seen: Array<string> = []
            let cursor: RunQuery["cursor"]
            do {
              const page = yield* runtime.queryRuns({ ...request, limit: 1, cursor })
              seen.push(...page.items.map((run) => run.runId))
              cursor = page.nextCursor
            } while (cursor !== undefined && seen.length < 10)
            return seen
          })
        expect(yield* walk({ order: "newest", filters: { runIds: ["a", "b", "missing"] } })).toEqual(["b", "a"])
        expect(yield* walk({ filters: { runIds: [] } })).toEqual([])
        const many = [...Array.from({ length: 40_000 }, (_, index) => `absent-${index}`), "d", "d", "z"]
        expect(yield* walk({ order: "oldest", filters: { runIds: many } })).toEqual(["z", "d"])
        expect(yield* walk({ order: "oldest", filters: { runIds: ["c", "d"], since: 30, until: 31 } })).toEqual([
          "c",
          "d"
        ])
      }).pipe(
        Effect.provide(durable({ database: fileBundle(url!) })),
        Effect.scoped,
        Effect.orDie
      )
    )
  }, 60_000)
})
