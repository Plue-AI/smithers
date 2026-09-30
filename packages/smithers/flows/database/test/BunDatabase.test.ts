import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
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
import * as Dialect from "../src/Dialect.ts"

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

  it("creates the database and its WAL sidecars owner-only under a permissive umask", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-bun-mode-"))
    const filename = join(root, "private.sqlite")
    const previousMask = process.umask(0o022)
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY)`
            return [filename, `${filename}-wal`, `${filename}-shm`].map((path) => statSync(path).mode & 0o777)
          }).pipe(Effect.provide(BunDatabase.layer({ filename })))
        )
      )
      expect(exit).toEqual(Exit.succeed([0o600, 0o600, 0o600]))
    } finally {
      process.umask(previousMask)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("observes an existing store read-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-bun-observe-"))
    const filename = join(root, "store.sqlite")
    try {
      const db = new DatabaseSync(filename)
      db.exec("CREATE TABLE flows_migrations (id INTEGER)")
      db.close()
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const write = yield* Effect.exit(sql`INSERT INTO flows_migrations VALUES (1)`)
            return { readOnly: Dialect.isReadOnly(sql), written: Exit.isSuccess(write) }
          }).pipe(Effect.provide(BunDatabase.layer({ filename, readOnly: true })))
        )
      )
      expect(exit).toEqual(Exit.succeed({ readOnly: true, written: false }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves a missing file uncreated for a read-only open", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-bun-readonly-"))
    const filename = join(root, "missing.sqlite")
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(Effect.provide(Effect.void, BunDatabase.layer({ filename, sqlite: { readonly: true } })))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(existsSync(filename)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The Node shim ignores Bun's create and readwrite flags and creates the file
  // under the umask, which shows the adapter left creation to the driver.
  it.each([{ create: false }, { readwrite: false }])(
    "does not pre-create the file when $0 disables creation",
    async (sqlite) => {
      const root = mkdtempSync(join(tmpdir(), "flows-bun-nocreate-"))
      const filename = join(root, "driver.sqlite")
      const previousMask = process.umask(0o022)
      try {
        await Effect.runPromiseExit(Effect.scoped(Effect.provide(Effect.void, BunDatabase.layer({ filename, sqlite }))))
        expect(statSync(filename).mode & 0o777).toBe(0o644)
      } finally {
        process.umask(previousMask)
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

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
