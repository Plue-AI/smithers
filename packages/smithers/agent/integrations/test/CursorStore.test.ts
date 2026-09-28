import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { CursorStore, layerMemory, layerSql } from "../src/core/CursorStore.ts"
import * as Migrations from "../src/core/Migrations.ts"

const sqlLayer = Layer.provideMerge(layerSql, Layer.provideMerge(Migrations.layer, TestDatabase.layer))

const contract = (name: string, layer: Layer.Layer<CursorStore, never, never>) => {
  const run = <A, E>(effect: Effect.Effect<A, E, CursorStore>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped))

  describe(name, () => {
    it("reads null for a source that has never polled", async () => {
      const cursor = await run(Effect.flatMap(CursorStore, (store) => store.get("telegram")))
      expect(cursor).toBeNull()
    })

    it("round-trips a cursor and overwrites it on the next commit", async () => {
      const cursors = await run(Effect.gen(function*() {
        const store = yield* CursorStore
        yield* store.set("telegram", "42")
        const first = yield* store.get("telegram")
        yield* store.set("telegram", "43")
        return [first, yield* store.get("telegram")]
      }))
      expect(cursors).toEqual(["42", "43"])
    })

    it("keeps sources apart", async () => {
      const cursors = await run(Effect.gen(function*() {
        const store = yield* CursorStore
        yield* store.set("telegram", "42")
        yield* store.set("telegram-secondary", "7")
        return [yield* store.get("telegram"), yield* store.get("telegram-secondary")]
      }))
      expect(cursors).toEqual(["42", "7"])
    })

    it("stores a null cursor as a real value", async () => {
      const cursor = await run(Effect.gen(function*() {
        const store = yield* CursorStore
        yield* store.set("telegram", "42")
        yield* store.set("telegram", null)
        return yield* store.get("telegram")
      }))
      expect(cursor).toBeNull()
    })
  })
}

contract("CursorStore (memory)", layerMemory)
// The durable store runs against a real SQLite database with the real
// migration applied, because "survives a restart" is the only reason it
// exists.
contract("CursorStore (SQLite)", sqlLayer as Layer.Layer<CursorStore, never, never>)

// "Survives a restart" is the only reason the SQLite store exists, so the
// durability case uses a database on disk and builds the whole layer stack
// twice. Two `yield* CursorStore` inside one `Effect.provide` would resolve
// the same memoized service over the same open connection and would pass even
// if nothing were ever written to the file.
describe("CursorStore (SQLite) durability", () => {
  const directories: Array<string> = []

  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  })

  /** A database file no other case writes, so each case seeds its own state. */
  const database = () => {
    const directory = mkdtempSync(join(tmpdir(), "integrations-cursor-"))
    directories.push(directory)
    return join(directory, "cursors.db")
  }

  /** One process's whole stack: its own connection, its own CursorStore. */
  const open =
    (filename: string) => <A>(effect: Effect.Effect<A, unknown, CursorStore | SqlClient.SqlClient>): Promise<A> =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.provideMerge(
              layerSql,
              Layer.provideMerge(
                Migrations.layer,
                Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
              )
            )
          ),
          Effect.scoped,
          Effect.orDie
        )
      )

  it("keeps the cursor across a second store opened on the same file", async () => {
    const process = open(database())
    await process(Effect.flatMap(CursorStore, (store) => store.set("telegram", "99")))
    // A second stack over the same file is what a restarted process sees.
    const cursor = await process(Effect.flatMap(CursorStore, (store) => store.get("telegram")))
    expect(cursor).toBe("99")
  })

  it("re-runs the migration against the existing file without losing the row", async () => {
    // Seeded here rather than inherited from the case above, so running this
    // case alone still exercises a file the migration has already installed.
    const process = open(database())
    await process(Effect.flatMap(CursorStore, (store) => store.set("telegram", "99")))
    const [cursor, applied] = await process(Effect.gen(function*() {
      const store = yield* CursorStore
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly name: string }>`SELECT name FROM flows_migrations`
      return [yield* store.get("telegram"), rows.map((row) => row.name)] as const
    }))
    expect(cursor).toBe("99")
    // The second open re-ran the set against an installed file: the migration
    // is recorded once, not applied again.
    expect(applied.filter((name) => name.includes("integration_cursors"))).toHaveLength(1)
  })
})

describe("CursorStore (SQLite) failures", () => {
  // The SQL layer can be built before the package migration is installed. A
  // missing table must stay in the typed channel and name the operation whose
  // cursor did not move.
  it("classifies read and write failures from an unmigrated database", async () => {
    const unmigrated = Layer.provideMerge(layerSql, TestDatabase.layer)
    const [read, write] = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* CursorStore
        return [
          yield* Effect.flip(store.get("missing-read")),
          yield* Effect.flip(store.set("missing-write", "42"))
        ] as const
      }).pipe(Effect.provide(unmigrated), Effect.scoped)
    )
    expect(read.reason).toBe("delivery-failed")
    expect(read.message).toContain("source \"missing-read\"")
    expect(read.details).toMatchObject({ sourceId: "missing-read", operation: "read" })
    expect(write.reason).toBe("delivery-failed")
    expect(write.message).toContain("source \"missing-write\"")
    expect(write.details).toMatchObject({ sourceId: "missing-write", operation: "write" })
  })
})
