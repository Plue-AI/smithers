import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { vi } from "vitest"

// Exercise the adapter's composition and guard in the Node coverage lane.
// Native Bun behavior is independently exercised by NativeRuntimeParity's
// real Bun processes and the Bun client's affected rows by
// agent/memory NativeBunAffectedRows.test.ts. Neither uses this shim.
const probe = vi.hoisted(() => ({ fail: false }))
vi.mock("bun:sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  return {
    Database: class {
      private readonly database: DatabaseSync
      constructor(filename: string, options: { readonly readonly: boolean; readonly create: boolean }) {
        expect(options).toEqual({ readonly: true, create: false })
        if (probe.fail) {
          probe.fail = false
          throw new Error("database is locked")
        }
        this.database = new DatabaseSync(filename, { readOnly: options.readonly })
      }
      query(sql: string) {
        return this.database.prepare(sql)
      }
      close() {
        this.database.close()
      }
    }
  }
})
vi.mock("../src/internal/BunSqliteClient.ts", () => import("@effect/sql-sqlite-node/SqliteClient"))

import * as BunDatabase from "../src/bun/BunDatabase.ts"

const read = (filename: string) =>
  Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT 1 AS value`
      }).pipe(Effect.provide(BunDatabase.layer({ filename })))
    )
  )

describe("Bun database adapter", () => {
  it("opens new files and memory databases through the selected SQL driver", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-bun-adapter-"))
    try {
      expect(await read(":memory:")).toEqual(Exit.succeed([{ value: 1 }]))
      expect(await read(join(root, "new.sqlite"))).toEqual(Exit.succeed([{ value: 1 }]))
      expect(Exit.isFailure(await read(root))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses legacy tables, accepts a migrated file, and retries a locked probe", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-bun-guard-"))
    const filename = join(root, "runtime.sqlite")
    try {
      const db = new DatabaseSync(filename)
      db.exec("CREATE TABLE legacy (id INTEGER)")
      db.close()
      const refused = await read(filename)
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) expect(Cause.pretty(refused.cause)).toContain("not a Smithers 1.0 database")
      const migrated = new DatabaseSync(filename)
      migrated.exec("CREATE TABLE flows_migrations (id INTEGER)")
      migrated.close()
      probe.fail = true
      expect(await read(filename)).toEqual(Exit.succeed([{ value: 1 }]))
      expect(await read(`file:${filename}`)).toEqual(Exit.succeed([{ value: 1 }]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("preserves the driver's refusal of a corrupt file", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-bun-corrupt-"))
    try {
      const filename = join(root, "corrupt.sqlite")
      writeFileSync(filename, "not sqlite")
      expect(Exit.isFailure(await read(filename))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
