/**
 * The PostgreSQL arm of the durable run inventory, against a real server this
 * suite starts and stops itself. SQLite cannot reach the `jsonb` run-id
 * selection, so this is the only place that branch is exercised.
 */
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ControlRuntime, type RunQuery } from "../src/ControlRuntime.ts"
import { durable, fileBundle } from "./DurableStack.ts"

const binary = (name: string): string => {
  const candidates = [
    process.env.PG_BIN === undefined ? undefined : join(process.env.PG_BIN, name),
    join("/opt/homebrew/opt/postgresql@18/bin", name),
    join("/usr/lib/postgresql/18/bin", name)
  ]
  return candidates.find((path): path is string => path !== undefined && existsSync(path)) ?? name
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

describe("run inventory on PostgreSQL", () => {
  let directory = ""
  let url = ""

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "control-pg-"))
    const port = await freePort()
    const data = join(directory, "data")
    execFileSync(binary("initdb"), ["-D", data, "-U", "smithers", "--auth=trust", "-E", "UTF8"], { stdio: "pipe" })
    execFileSync(
      binary("pg_ctl"),
      ["-D", data, "-w", "-l", join(directory, "log"), "-o", `-p ${port} -h 127.0.0.1 -k ${directory}`, "start"],
      { stdio: "pipe" }
    )
    url = `postgres://smithers@127.0.0.1:${port}/postgres`
  }, 120_000)

  afterAll(() => {
    try {
      execFileSync(binary("pg_ctl"), ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"], {
        stdio: "pipe"
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)

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
        Effect.provide(durable({ database: fileBundle(url) })),
        Effect.scoped,
        Effect.orDie
      )
    )
  }, 60_000)
})
