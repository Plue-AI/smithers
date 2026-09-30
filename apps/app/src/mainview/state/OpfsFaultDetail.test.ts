import { expect, test } from "bun:test"
import { OPFS_HANDLE_LOCK, opfsHandleContention, sqliteFault } from "./OpfsFaultDetail"
import type { OpfsLockQuery, SqliteFault } from "./OpfsFaultDetail"

test("only an exact generic SQLite result string names a result class", () => {
  const cases: ReadonlyArray<readonly [unknown, SqliteFault]> = [
    [new Error("disk I/O error"), "io"],
    [new Error("database is locked"), "busy"],
    [new Error("database or disk is full"), "full"],
    [new Error("unable to open database file"), "cantopen"],
    [new Error("database disk image is malformed"), "corrupt"],
    [new Error("attempt to write a readonly database"), "readonly"],
    [new Error("out of memory"), "nomem"],
    [new Error("cannot start a transaction within a transaction"), "nested-transaction"],
    [new Error("cannot commit - no transaction is active"), "no-transaction"],
    [new Error("cannot rollback - no transaction is active"), "no-transaction"],
    [{ message: "disk I/O error" }, "io"],
    // Detail beside a known result is statement or row content: never matched.
    [new Error("disk I/O error: /private/path"), "other"],
    [new Error("UNIQUE constraint failed: smithers_collection_rows.row_key"), "other"],
    [new Error("near \"PRIVATE\": syntax error"), "other"],
    [{ message: 42 }, "other"],
    ["disk I/O error", "other"],
    [null, "other"],
    [undefined, "other"]
  ]
  for (const [error, fault] of cases) expect(sqliteFault(error)).toBe(fault)
})

const manager = (snapshot: Awaited<ReturnType<OpfsLockQuery["query"]>>): OpfsLockQuery => ({ query: async () => snapshot })

test("handle contention counts only the database's access-handle lock, never client ids", async () => {
  const contention = await opfsHandleContention(manager({
    held: [
      { name: OPFS_HANDLE_LOCK, clientId: "private-client-a" } as { readonly name: string },
      { name: "smithers-mvp.store.writer", clientId: "private-client-b" } as { readonly name: string },
      { name: ".ahp-private" }
    ],
    pending: [{ name: OPFS_HANDLE_LOCK }, { name: OPFS_HANDLE_LOCK }, { name: "other" }]
  }))
  expect(contention).toEqual({ held: 1, waiting: 2 })
  expect(JSON.stringify(contention)).not.toContain("private")
  expect(await opfsHandleContention(manager({}))).toEqual({ held: 0, waiting: 0 })
  expect(await opfsHandleContention(manager({ held: [{}], pending: [{ name: "ahp:/other.sqlite" }] }))).toEqual({ held: 0, waiting: 0 })
})

test("an unavailable or failing lock manager reports unknown", async () => {
  expect(await opfsHandleContention(undefined)).toBe("unknown")
  expect(await opfsHandleContention({} as OpfsLockQuery)).toBe("unknown")
  expect(await opfsHandleContention({ query: async () => { throw new Error("private") } })).toBe("unknown")
  expect(await opfsHandleContention({ query: () => { throw new Error("private") } })).toBe("unknown")
})
