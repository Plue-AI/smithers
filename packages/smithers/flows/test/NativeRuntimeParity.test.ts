import { expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/native-runtime.ts", import.meta.url))

// SandboxedFlow's bun cases skip the same way on a machine without bun.
const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

it.skipIf(!bunInstalled).each([["node", "bun"], ["bun", "node"]] as const)(
  "resumes a %s-created durable run in %s without repeating its completed action",
  async (first, second) => {
    const directory = mkdtempSync(join(tmpdir(), "flows-native-parity-"))
    const postgres = process.env.SMITHERS_TEST_PG_URL
    const prefix = `test_runtime_${randomUUID().replaceAll("-", "")}`
    const run = (runtime: string, phase: string) =>
      JSON.parse(
        execFileSync(
          runtime === "node" ? process.execPath : "bun",
          [fixture, runtime, directory, phase],
          // Each cold child compiles the entire native composition. Bound it
          // independently: Vitest cannot interrupt execFileSync while it runs.
          {
            encoding: "utf8",
            timeout: 60_000,
            killSignal: "SIGKILL",
            env: {
              ...process.env,
              SMITHERS_BACKEND: postgres ? "postgres" : "sqlite",
              SMITHERS_POSTGRES_URL: postgres ?? "",
              DATABASE_URL: "",
              SMITHERS_POSTGRES_SCHEMA: prefix
            }
          }
        ).trim().split("\n").at(-1)!
      )
    try {
      expect(run(first, "park")).toMatchObject({ status: "suspended", owner: null, dispatches: 1 })
      expect(run(second, "resume")).toMatchObject({
        status: "completed",
        dispatches: 1,
        result: "original result:approved"
      })
      expect(run(first, "reopen")).toMatchObject({
        status: "completed",
        dispatches: 1,
        result: "original result:approved"
      })
    } finally {
      if (postgres) {
        const PostgresDatabase = await import("@smthrs/database/postgres/PostgresDatabase")
        const schema = `${prefix}_engine_sqlite`
        await Effect.runPromise(
          Effect.gen(function*() {
            const sql = yield* SqlClient
            yield* TestDatabase.dropSchema(sql, schema)
          }).pipe(Effect.provide(PostgresDatabase.layer({ url: postgres, schema })))
        )
      }
      rmSync(directory, { recursive: true, force: true })
    }
  },
  190_000
)
