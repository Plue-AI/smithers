import { afterEach, describe, expect, it } from "@effect/vitest"
import { Cause, Effect, type Exit, Layer, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { existsSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import * as ReleasePolicy from "../src/internal/ReleasePolicy.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import { holdWriteLock } from "./harness/holdWriteLock.ts"
import { tempDirectoryFixture } from "./harness/tempDirectoryFixture.ts"

/**
 * Negative gates for the two rc.0 exclusions the Node driver enforces:
 * X-13 (a 0.x `smithers.db` is never loaded) and X-18 (the durable engine
 * does not run under Bun). Both refusals are defects rather than typed
 * failures because `layer` keeps the error channel `never` that every
 * durable package composes against; the defect still carries the typed
 * `NodeDatabase.UnsupportedDatabase` value with its stable code.
 */

const { directory: tempDirectory, file: tempFile } = tempDirectoryFixture("flows-db-guard-", "guard.sqlite")

/** Writes a file that carries tables but no `flows_migrations`: a 0.x `smithers.db`. */
const seedZeroX = (filename: string): void => {
  const db = new DatabaseSync(filename)
  try {
    // Rollback journal, as 0.x leaves it: a writer's exclusive lock then
    // blocks the guard's read-only probe, which is the case below.
    db.exec("PRAGMA journal_mode = DELETE")
    db.exec("CREATE TABLE _smithers_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
    db.exec("INSERT INTO _smithers_runs (id, status) VALUES ('run-1', 'running')")
  } finally {
    db.close()
  }
}

/**
 * Writes the same 0.x file in WAL mode and closes it cleanly, so no `-shm`
 * sidecar is left beside it. A read-only open of such a file is the second
 * path a probe can fail on, and this fixture is what decides whether it does.
 */
const seedZeroXWal = (filename: string): void => {
  const db = new DatabaseSync(filename)
  try {
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("CREATE TABLE _smithers_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
    db.exec("INSERT INTO _smithers_runs (id, status) VALUES ('run-1', 'running')")
  } finally {
    db.close()
  }
}

/** Writes a file that carries the flows migration ledger: a Smithers 1.0 database. */
const seedFlows = (filename: string): void => {
  const db = new DatabaseSync(filename)
  try {
    db.exec("CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT)")
    db.exec("CREATE TABLE flows_runs (id TEXT PRIMARY KEY)")
  } finally {
    db.close()
  }
}

/** Reads a file's tables without going through the driver, to prove what an open did or did not write. */
const tableNames = (filename: string): ReadonlyArray<string> => {
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => String((row as { readonly name: unknown }).name))
  } finally {
    db.close()
  }
}

const build = (options: NodeDatabase.NodeDatabaseOptions) =>
  Effect.exit(Effect.scoped(Layer.build(NodeDatabase.layer(options))))

/** Reads the defect a failed layer build carries, so its type and message can be asserted. */
const defectOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") return undefined
  const found = Cause.findDefect(exit.cause)
  expect(Result.isSuccess(found)).toBe(true)
  return Result.isSuccess(found) ? found.success : undefined
}

describe("NodeDatabase file permissions", () => {
  it.effect.each([
    { label: "private default permissions", mode: undefined, mask: 0o022, expected: 0o600, existing: false },
    { label: "explicit group-readable permissions", mode: 0o640, mask: 0o022, expected: 0o640, existing: false },
    { label: "the process umask", mode: 0o666, mask: 0o077, expected: 0o600, existing: false },
    { label: "existing file permissions", mode: 0o600, mask: 0o022, expected: 0o640, existing: true }
  ])(
    "creates the database and WAL sidecars with $label",
    ({ mode, mask, expected, existing }) =>
      Effect.gen(function*() {
        const filename = tempFile()
        const previousMask = process.umask(mask)
        try {
          if (existing) writeFileSync(filename, "", { mode: expected })
          yield* Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY)`
            expect([filename, `${filename}-wal`, `${filename}-shm`].map((path) => statSync(path).mode & 0o777))
              .toEqual([expected, expected, expected])
          }).pipe(Effect.provide(NodeDatabase.layer({ filename, mode })))
        } finally {
          process.umask(previousMask)
        }
      })
  )

  it.effect("does not create a missing file for a read-only open", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      expect((yield* build({ filename, sqlite: { readonly: true } }))._tag).toBe("Failure")
      expect(existsSync(filename)).toBe(false)
    }))

  it.effect("does not create the parent directory", () =>
    Effect.gen(function*() {
      const filename = join(tempDirectory(), "missing", "flows.sqlite")
      expect((yield* build({ filename }))._tag).toBe("Failure")
      expect(existsSync(filename)).toBe(false)
    }))

  it.effect("leaves an empty temporary filename to SQLite", () =>
    Effect.gen(function*() {
      expect((yield* build({ filename: "", sqlite: { disableWAL: true } }))._tag).toBe("Success")
    }))
})

describe("NodeDatabase guard: 0.x database files (X-13)", () => {
  it.effect("refuses a file that has tables and no flows_migrations table", () =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroX(filename)

      const defect = defectOf(yield* build({ filename }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_database_file")
      expect(defect.message).toBe(
        `${filename} is not a Smithers 1.0 database (${ReleasePolicy.releaseVersion} does not load a 0.x smithers.db)`
      )
    }))

  it.effect("refuses a 0.x file opened through a file: URI", () =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroX(filename)
      const uri = `file:${filename}`

      const defect = defectOf(yield* build({ filename: uri }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_database_file")
      expect(defect.message).toBe(
        `${uri} is not a Smithers 1.0 database (${ReleasePolicy.releaseVersion} does not load a 0.x smithers.db)`
      )
    }))

  it.effect("refuses a 0.x file opened through an absolute file:// URI", () =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroX(filename)
      const uri = `file://${filename}`

      const defect = defectOf(yield* build({ filename: uri }))

      // This Node build accepts the triple-slash absolute form, so the guard
      // must inspect it rather than relying on the client to reject it.
      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_database_file")
      expect(defect.message).toBe(
        `${uri} is not a Smithers 1.0 database (${ReleasePolicy.releaseVersion} does not load a 0.x smithers.db)`
      )
    }))

  // The probe opens read-only, and SQLite refuses that outright when the URI
  // asks for write access: `?mode=rw` fails with `access mode not allowed: rw`
  // before a table is read. That failure used to read as "cannot inspect", so
  // the guard waved the URI through and the client — which opens read-write and
  // succeeds — loaded the 0.x database. The query says how to open the file,
  // never which tables it holds, so the probe drops it.
  it.effect.each([
    { label: "mode=rw", query: "?mode=rw" },
    { label: "mode=rwc", query: "?mode=rwc" },
    { label: "mode=rw beside another parameter", query: "?mode=rw&cache=private" },
    { label: "mode=rw with a fragment SQLite ignores", query: "?mode=rw#ignored" }
  ])("refuses a 0.x file opened through a file: URI carrying $label", ({ query }) =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroX(filename)
      const uri = `file://${filename}${query}`

      const defect = defectOf(yield* build({ filename: uri }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_database_file")
      // The refusal names the URI the caller gave, not the path it was probed by.
      expect(defect.message).toBe(
        `${uri} is not a Smithers 1.0 database (${ReleasePolicy.releaseVersion} does not load a 0.x smithers.db)`
      )
    }))

  // The mirror of the four above: dropping the query must not turn every
  // write-mode URI into a refusal. A file that carries the migration ledger is
  // a Smithers 1.0 database whatever mode the URI asks for, so whatever the
  // client then makes of the URI, the guard says nothing about it.
  it.effect("says nothing about a Smithers 1.0 database opened through a mode=rw URI", () =>
    Effect.gen(function*() {
      const filename = tempFile("flows.sqlite")
      seedFlows(filename)

      const exit = yield* build({ filename: `file://${filename}?mode=rw` })

      const defect = exit._tag === "Failure" ? Result.getOrUndefined(Cause.findDefect(exit.cause)) : undefined
      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(false)
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall the probe's ladder.
  it.live("refuses a 0.x file whose 0.x writer holds the lock", () =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroX(filename)
      const lock = holdWriteLock(filename)
      // Released only after the probe has already been refused its read, so
      // the guard has to outwait the lock rather than never meeting it. The
      // open ladder outwaits a lock this short, so a guard that gave up here
      // would open the very 0.x database the guard refuses.
      const timer = setTimeout(() => lock.release(), 300)

      try {
        const defect = defectOf(yield* build({ filename }))

        expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
        if (!NodeDatabase.isUnsupportedDatabase(defect)) return
        expect(defect.code).toBe("unsupported_database_file")
      } finally {
        clearTimeout(timer)
        lock.release()
      }
    }))

  // Real elapsed time: the ladder has to actually run out.
  it.live("refuses a 0.x file whose writer never releases the lock", () =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroX(filename)
      const lock = holdWriteLock(filename)

      try {
        const defect = defectOf(yield* build({ filename }))

        expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
        if (!NodeDatabase.isUnsupportedDatabase(defect)) return
        expect(defect.code).toBe("database_locked")
        expect(defect.message).toBe(`${filename} could not be inspected because another process holds it`)
      } finally {
        lock.release()
      }

      // Nothing was written: the file is still the 0.x file it was.
      expect(tableNames(filename)).toEqual(["_smithers_runs"])
    }), 60_000)

  /**
   * The path is caller input and the ladder's classifier reads text, so a file
   * whose own name spells SQLite's lock error is the one input that can make
   * the guard report the refusal it did not make.
   */
  // Real elapsed time: a misclassified refusal is retried, and the assertion
  // has to be reached rather than parked on a clock the ladder cannot advance.
  it.live("reports the refusal the guard made, not the one its path spells", () =>
    Effect.gen(function*() {
      const filename = tempFile("database is locked.db")
      seedZeroX(filename)

      const defect = defectOf(yield* build({ filename }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_database_file")
    }), 60_000)

  it.effect("refuses a 0.x file left in WAL mode with no -shm beside it", () =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroXWal(filename)

      const defect = defectOf(yield* build({ filename }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_database_file")
    }))

  it.effect("opens a database that carries the flows_migrations table", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      seedFlows(filename)

      expect((yield* build({ filename }))._tag).toBe("Success")
    }))

  it.effect("opens an empty file, which the ladder is about to populate", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      writeFileSync(filename, "")

      expect((yield* build({ filename }))._tag).toBe("Success")
    }))

  it.effect("opens a path that does not exist yet", () =>
    Effect.gen(function*() {
      expect((yield* build({ filename: tempFile() }))._tag).toBe("Success")
    }))

  it.effect("opens an in-memory database, which has no path to probe", () =>
    Effect.gen(function*() {
      expect((yield* build({ filename: ":memory:" }))._tag).toBe("Success")
    }))

  it.effect("opens a shared in-memory file: URI", () =>
    Effect.gen(function*() {
      expect((yield* build({ filename: "file::memory:?cache=shared" }))._tag).toBe("Success")
    }))

  it.effect("opens a mode=memory URI whose name collides with a 0.x file", () =>
    Effect.gen(function*() {
      const directory = tempDirectory()
      const basename = "smithers.db"
      seedZeroX(join(directory, basename))
      const previousDirectory = process.cwd()
      process.chdir(directory)
      try {
        const exit = yield* build({ filename: `file:${basename}?mode=memory&cache=shared` })
        expect(exit._tag).toBe("Success")
      } finally {
        process.chdir(previousDirectory)
      }
    }))

  // SQLite honors the LAST `mode` when the query repeats it, so only a URI
  // whose final mode is `memory` names an in-memory database. A crafted
  // `?mode=memory&mode=rw` opens the on-disk file read-write, and skipping the
  // probe for it would reopen the exact mode=rw bypass the guard closed.
  it.effect("refuses a 0.x file whose URI hides mode=rw behind an earlier mode=memory", () =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroX(filename)
      const uri = `file:${filename}?mode=memory&mode=rw`

      const defect = defectOf(yield* build({ filename: uri }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_database_file")
      expect(defect.message).toBe(
        `${uri} is not a Smithers 1.0 database (${ReleasePolicy.releaseVersion} does not load a 0.x smithers.db)`
      )
    }))

  it.effect("opens a URI whose last mode is memory beside an earlier mode=rw", () =>
    Effect.gen(function*() {
      const filename = tempFile("smithers.db")
      seedZeroX(filename)

      expect((yield* build({ filename: `file:${filename}?mode=rw&mode=memory` }))._tag).toBe("Success")
    }))

  it.effect("opens a file: URI whose path does not exist yet", () =>
    Effect.gen(function*() {
      expect((yield* build({ filename: `file:${tempFile()}` }))._tag).toBe("Success")
    }))

  it.effect("leaves a path that is not a regular file to the driver", () =>
    Effect.gen(function*() {
      // A directory cannot be probed and is not a 0.x database: the driver's
      // own open failure must surface, not the guard's refusal.
      const defect = defectOf(yield* build({ filename: tempDirectory() }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(false)
    }))

  it.effect("leaves a file that is not SQLite at all to the driver", () =>
    Effect.gen(function*() {
      const filename = tempFile("garbage.db")
      writeFileSync(filename, "this is not a SQLite database")

      const defect = defectOf(yield* build({ filename }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(false)
    }))
})

describe("NodeDatabase guard: Bun (X-18)", () => {
  afterEach(() => {
    delete (process.versions as { bun?: string }).bun
  })

  it.effect("refuses to open the durable database under Bun", () =>
    Effect.gen(function*() {
      const filename = tempFile()
      ;(process.versions as { bun?: string }).bun = "1.3.14"

      const defect = defectOf(yield* build({ filename }))

      expect(existsSync(filename)).toBe(false)
      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_runtime")
      expect(defect.message).toBe(
        "Use @smthrs/database/bun/BunDatabase under Bun; NodeDatabase requires Node.js >=26.4.0"
      )
    }))

  it.effect("refuses before it inspects the file, so an in-memory database is refused too", () =>
    Effect.gen(function*() {
      ;(process.versions as { bun?: string }).bun = "1.3.14"

      const defect = defectOf(yield* build({ filename: ":memory:" }))

      expect(NodeDatabase.isUnsupportedDatabase(defect)).toBe(true)
      if (!NodeDatabase.isUnsupportedDatabase(defect)) return
      expect(defect.code).toBe("unsupported_runtime")
    }))
})
