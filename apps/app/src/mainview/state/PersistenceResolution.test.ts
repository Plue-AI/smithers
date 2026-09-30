import type { StorageApi } from "@tanstack/db"
import { Database } from "bun:sqlite"
import { describe, expect, spyOn, test } from "bun:test"
import { APP_SCHEMA_VERSION, PERSISTENCE_BACKEND_STORAGE_KEY } from "../chain/SchemaVersion"
import { METADATA_TABLE_NAME, openSqliteRowStorage, ROW_TABLE_NAME } from "../chain/SqliteRowStorage"
import type { SqliteRowDatabase } from "../chain/SqliteRowStorage"
import { createAppStore, resolvePersistence } from "./AppStore"

const memory = (): StorageApi & {
  readonly bytes: Map<string, string>
  readonly length: number
  readonly key: (index: number) => string | null
} => {
  const bytes = new Map<string, string>()
  return {
    bytes,
    get length() {
      return bytes.size
    },
    key: (index) => [...bytes.keys()][index] ?? null,
    getItem: (key) => bytes.get(key) ?? null,
    setItem: (key, value) => {
      bytes.set(key, value)
    },
    removeItem: (key) => {
      bytes.delete(key)
    }
  }
}

describe("the browser's persistence resolver", () => {
  test("appearance mirrors alone do not create a false second-store ambiguity", async () => {
    const record = memory()
    record.setItem("smithers-mvp.theme", "dark")
    record.setItem("smithers-mvp.palette", "original")
    let opens = 0
    const resolved = await resolvePersistence({
      bootRecord: () => record,
      databaseExists: async () => true,
      openDatabase: async () => {
        opens++
        return { execute: async () => [] }
      }
    })
    expect(resolved.mode).toBe("opfs")
    expect(opens).toBe(1)
    if (resolved.backend.kind === "opfs") await resolved.backend.close()
  })

  test("an enumerated historical collection remains a source even if the current schema no longer lists it", async () => {
    const record = memory()
    record.setItem("smithers-mvp.old-authored-documents", "original")
    let opens = 0
    const resolved = await resolvePersistence({
      bootRecord: () => record,
      databaseExists: async () => false,
      openDatabase: async () => {
        opens++
        throw new Error("must not open")
      }
    })
    expect(resolved.mode).toBe("localStorage")
    expect(opens).toBe(0)
    expect(record.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)).toBeNull()
  })

  for (const sqliteExists of [false, true, undefined]) {
    test(`unstamped legacy data is not hidden by a new or ambiguous OPFS selection (SQLite exists: ${sqliteExists})`, async () => {
      const record = memory()
      const raw = "legacy original transcript"
      record.setItem("smithers-mvp.app-messages", raw)
      let opened = 0
      const database = new Database(":memory:")
      try {
        const resolving = resolvePersistence({
          bootRecord: () => record,
          openDatabase: async () => {
            opened++
            return {
              execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
                const statement = database.query(sql)
                if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
                statement.run(...params as [])
                return []
              }
            }
          },
          ...(sqliteExists === undefined ? {} : { databaseExists: async () => sqliteExists })
        })
        if (sqliteExists === false) {
          expect((await resolving).mode).toBe("localStorage")
        } else {
          await expect(resolving).rejects.toThrow("backend")
        }
        expect(opened).toBe(0)
        expect([...record.bytes]).toEqual([["smithers-mvp.app-messages", raw]])
      } finally {
        database.close()
      }
    })
  }

  test("a recorded localStorage backend never probes OPFS", async () => {
    const record = memory()
    record.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "localStorage")
    const resolved = await resolvePersistence({
      bootRecord: () => record,
      openDatabase: async () => {
        throw new Error("must not open")
      }
    })
    expect(resolved).toMatchObject({
      backend: { kind: "localStorage", storage: record },
      mode: "localStorage",
      degraded: false
    })
  })

  for (const recorded of [undefined, "opfs"] as const) {
    test(`${recorded ?? "unstamped"}: only database acquisition failure permits fallback`, async () => {
      const record = memory()
      if (recorded !== undefined) record.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, recorded)
      record.setItem("outside-app.private-original", "preserve")
      let attempts = 0
      const resolved = await resolvePersistence({
        bootRecord: () => record,
        openDatabase: async (count) => {
          attempts = count
          throw new Error("unavailable")
        }
      })
      expect(attempts).toBe(recorded === "opfs" ? 5 : 1)
      expect(resolved.mode).toBe(recorded === "opfs" ? "memory" : "localStorage")
      expect(resolved.degraded).toBe(recorded === "opfs")
      expect(resolved.savedStoreUnavailable === true).toBe(recorded === "opfs")
      expect(record.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)).toBe(recorded ?? "localStorage")
      if (recorded === "opfs") {
        expect(resolved.backend.storage).not.toBe(record)
        resolved.backend.storage!.setItem("new-session", "not durable")
        expect(record.getItem("new-session")).toBeNull()
      }
      expect(record.getItem("outside-app.private-original")).toBe("preserve")
    })
  }

  test("an unstamped boot never stamps localStorage over an existing OPFS database that will not open", async () => {
    const record = memory()
    let attempts = 0
    const resolved = await resolvePersistence({
      bootRecord: () => record,
      databaseExists: async () => true,
      openDatabase: async (count) => {
        attempts = count
        throw new Error("NoModificationAllowedError: access handles still held")
      }
    })
    expect(attempts).toBe(5)
    expect(resolved.mode).toBe("memory")
    expect(resolved.degraded).toBe(true)
    expect(resolved.savedStoreUnavailable).toBe(true)
    expect(record.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)).toBeNull()
  })

  test("an unstamped boot whose OPFS existence probe fails treats the database as present", async () => {
    const record = memory()
    let attempts = 0
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const resolved = await resolvePersistence({
        bootRecord: () => record,
        databaseExists: async () => {
          throw new DOMException("private row or path", "SecurityError")
        },
        openDatabase: async (count) => {
          attempts = count
          throw new Error("NoModificationAllowedError: access handles still held")
        }
      })
      expect(attempts).toBe(5)
      expect(resolved.mode).toBe("memory")
      expect(resolved.degraded).toBe(true)
      expect(resolved.savedStoreUnavailable).toBe(true)
      expect(record.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)).toBeNull()
      expect(warning.mock.calls).toEqual([[
        expect.any(String),
        { code: "opfs_presence_probe_failed", fault: "permission" }
      ]])
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private row or path")
    } finally {
      warning.mockRestore()
    }
  })

  test("no browser stores creates an isolated degraded memory session", async () => {
    const resolved = await resolvePersistence({
      bootRecord: () => undefined,
      openDatabase: async () => {
        throw new Error("unavailable")
      }
    })
    expect(resolved.mode).toBe("memory")
    expect(resolved.degraded).toBe(true)
    expect(resolved.savedStoreUnavailable).not.toBe(true)
    resolved.backend.storage!.setItem("key", "memory only")
    expect(resolved.backend.storage!.getItem("key")).toBe("memory only")
  })

  test("a no-storage memory boot keeps its failure notice through the boot sweep and calls an archive temporary", async () => {
    const resolved = await resolvePersistence({
      bootRecord: () => undefined,
      openDatabase: async () => {
        throw new Error("access handles still held")
      }
    })
    const store = await createAppStore(resolved)
    expect(store.persistenceMode).toBe("memory")
    expect(store.persistenceDegraded).toBe(true)
    expect(store.savedStoreUnavailable).toBe(false)
    expect(store.collections.toasts.get("toast-store.degraded")).toMatchObject({
      status: "failed",
      title: "This session will not be saved"
    })
    await store.dispatch({ type: "conversation.cleared", actor: "user", branchId: "after-degraded-boot", notes: [] })
      .isPersisted.promise
    const notice = [...store.collections.messages.values()].find((message) => message.id.endsWith("-cleared"))
    expect(notice?.text).toContain("This archive is only available until this session closes")
    await store.dispose?.()
  })

  test("a recorded saved store that fails to reopen keeps its bytes and shows no temporary-session toast", async () => {
    const record = memory()
    record.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, "opfs")
    record.setItem("outside-app.private-original", "preserve")
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    try {
      const resolved = await resolvePersistence({
        bootRecord: () => record,
        openDatabase: async () => { throw new Error("private SQL row contents") }
      })
      const store = await createAppStore(resolved)
      try {
        expect(store.savedStoreUnavailable).toBe(true)
        expect(store.collections.toasts.get("toast-store.degraded")).toBeUndefined()
        expect([...record.bytes]).toEqual([
          [PERSISTENCE_BACKEND_STORAGE_KEY, "opfs"],
          ["outside-app.private-original", "preserve"]
        ])
        expect(errorLog.mock.calls).toEqual([[
          expect.any(String),
          { code: "opfs_open_failed", fault: "other", attempts: 5, budgetMs: 4000 }
        ]])
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private SQL row contents")
      } finally {
        await store.dispose?.()
      }
    } finally {
      errorLog.mockRestore()
    }
  })

  for (const cleanupFails of [false, true]) {
    test(`post-open I/O failure refuses boot and preserves the original error (cleanup fails: ${cleanupFails})`, async () => {
      const record = memory()
      const original = new Error("database read failed")
      let closed = 0
      await expect(resolvePersistence({
        bootRecord: () => record,
        openDatabase: async () => ({
          execute: async () => {
            throw original
          },
          close: async () => {
            closed += 1
            if (cleanupFails) throw new Error("close failed")
          }
        })
      })).rejects.toBe(original)
      expect(closed).toBe(1)
      expect([...record.bytes]).toEqual([])
    })
  }

  test("successful initialization stamps OPFS only after commit and returns a caller-owned handle", async () => {
    const record = memory()
    const database = new Database(":memory:")
    let closed = 0
    let committed = false
    try {
      const resolved = await resolvePersistence({
        bootRecord: () => record,
        openDatabase: async () => ({
          execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
            expect(record.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)).toBeNull()
            const statement = database.query(sql)
            if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
            statement.run(...params as [])
            if (sql === "COMMIT") committed = true
            return []
          },
          close: () => {
            closed += 1
          }
        })
      })
      expect(committed).toBe(true)
      expect(resolved.mode).toBe("opfs")
      expect(resolved.degraded).toBe(false)
      expect(record.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)).toBe("opfs")
      expect(closed).toBe(0)
      if (resolved.backend.kind !== "opfs") throw new Error("wrong backend")
      await resolved.backend.close()
      expect(closed).toBe(1)
    } finally {
      database.close()
    }
  })

  for (const stamp of ["", "indexeddb", "OPFS"]) {
    test(`an unknown backend stamp ${JSON.stringify(stamp)} cannot select or overwrite another store`, async () => {
      const record = memory()
      record.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, stamp)
      let opens = 0
      await expect(resolvePersistence({
        bootRecord: () => record,
        openDatabase: async () => {
          opens += 1
          throw new Error("must not open")
        }
      })).rejects.toThrow("backend")
      expect(opens).toBe(0)
      expect(record.getItem(PERSISTENCE_BACKEND_STORAGE_KEY)).toBe(stamp)
    })
  }

  for (const recorded of [undefined, "opfs"] as const) {
    for (
      const corrupt of ["future-schema", "invalid-schema", "import-marker", "event-head", "event"] as const
    ) {
      test(`${recorded ?? "unstamped"} / ${corrupt}: an opened database refuses unsafe state without selecting a new store`, async () => {
        const record = memory()
        if (recorded !== undefined) record.setItem(PERSISTENCE_BACKEND_STORAGE_KEY, recorded)
        const database = new Database(":memory:")
        let closed = 0
        const host: SqliteRowDatabase = {
          execute: async <TRow>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<TRow>> => {
            const statement = database.query(sql)
            if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return statement.all(...params as []) as ReadonlyArray<TRow>
            statement.run(...params as [])
            return []
          },
          close: () => {
            closed += 1
          }
        }
        try {
          await openSqliteRowStorage(host, { collections: [], schemaVersion: APP_SCHEMA_VERSION })
          if (corrupt === "future-schema" || corrupt === "invalid-schema") {
            database.query(`UPDATE ${METADATA_TABLE_NAME} SET value = ? WHERE key = 'schema-version'`).run(
              corrupt === "future-schema" ? String(APP_SCHEMA_VERSION + 1) : "NaN"
            )
          } else if (corrupt === "import-marker") {
            database.run(`UPDATE ${METADATA_TABLE_NAME} SET value = '0' WHERE key = 'legacy-import-complete'`)
          } else {
            database.query(`INSERT INTO ${ROW_TABLE_NAME} VALUES (?, ?, ?, ?)`).run(
              corrupt === "event-head" ? "app-event-heads" : "app-events",
              "s:private",
              "v1",
              "private original"
            )
          }
          const before = database.query(`SELECT * FROM ${METADATA_TABLE_NAME} ORDER BY key`).all()
          const rows = database.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()
          const recordBefore = [...record.bytes]
          await expect(resolvePersistence({ bootRecord: () => record, openDatabase: async () => host })).rejects
            .toBeInstanceOf(Error)
          expect(closed).toBe(1)
          expect([...record.bytes]).toEqual(recordBefore)
          expect(database.query(`SELECT * FROM ${METADATA_TABLE_NAME} ORDER BY key`).all()).toEqual(before)
          expect(database.query(`SELECT * FROM ${ROW_TABLE_NAME}`).all()).toEqual(rows)
        } finally {
          database.close()
        }
      })
    }
  }
})
