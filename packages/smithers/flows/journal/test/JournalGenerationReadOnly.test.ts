import { expect, it } from "@effect/vitest"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as JournalGeneration from "../src/JournalGeneration.ts"

it("installs nothing over a read-only client", async () => {
  const root = mkdtempSync(join(tmpdir(), "journal-generation-readonly-"))
  const filename = join(root, "store.db")
  try {
    const db = new DatabaseSync(filename)
    db.exec("CREATE TABLE flows_migrations (id INTEGER)")
    db.close()
    const tables = await Effect.runPromise(
      Effect.gen(function*() {
        yield* JournalGeneration.initialize
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`
      }).pipe(Effect.provide(NodeDatabase.layer({ filename, readOnly: true })))
    )
    expect(tables).toEqual([{ name: "flows_migrations" }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
