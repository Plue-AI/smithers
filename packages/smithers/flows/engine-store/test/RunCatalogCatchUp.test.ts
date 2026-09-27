/**
 * The catch-up read behind a workspace follower's run catalog.
 *
 * `@smthrs/sync` serves a workspace subscription over whatever `RunCatalog`
 * the composition supplies, and every implementation of it was static or
 * in-process: a follower learned about the runs its own process registered and
 * about nothing a second engine wrote to the same workspace. This module is
 * the durable half of the fix: the read that says which runs the workspace
 * has right now. These cases drive it across two independent compositions
 * over one database file, which is what a second engine actually looks like.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as RunCatalogOps from "../src/internal/RunCatalogOps.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const runState = JSON.stringify({ version: 1, flowName: "RunCatalog/Test", payload: {} })

type Services = SqlClient.SqlClient | RunStore.RunStore

/** Opens an independent composition over one database file. */
const onFile = (filename: string) => <A, E>(body: Effect.Effect<A, E, Services | Scope.Scope>) =>
  withCrypto(
    Effect.scoped(body).pipe(Effect.provide(TestStores.layerAt(filename))) as Effect.Effect<A, E, Crypto.Crypto>
  )

const temporaryFile = Effect.gen(function*() {
  const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "run-catalog-")))
  return join(directory, "engine.db")
})

const create = (runId: string) => Effect.flatMap(RunStore.RunStore, (runs) => runs.create(runId, runState))

describe("run catalog catch-up", () => {
  it.effect("catches up to runs a second engine created over the same database", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile
      const engine = onFile(filename)

      // The follower's composition, opened first and kept open across the
      // whole case: whatever it reads, it reads from disk.
      const seen = yield* engine(Effect.gen(function*() {
        const catalog = yield* RunCatalogOps.make()

        // A run the follower's own composition wrote, so an empty read here
        // would be a broken read rather than a missed announcement.
        yield* create("run-local")
        const start = yield* catalog.listRunIds()

        // A second engine, sharing nothing but the file, starts two runs.
        yield* onFile(filename)(Effect.andThen(create("run-remote-1"), create("run-remote-2")))
        const caughtUp = yield* catalog.listRunIds()

        return { start, caughtUp }
      }))

      expect(seen.start).toEqual(["run-local"])
      // Oldest first, so a follower opening streams in list order follows the
      // workspace in the order it happened.
      expect(seen.caughtUp).toEqual(["run-local", "run-remote-1", "run-remote-2"])
    }))

  it.effect("keeps the newest runs when the workspace is larger than the bound", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile

      const listed = yield* onFile(filename)(Effect.gen(function*() {
        const catalog = yield* RunCatalogOps.make()
        for (const index of [0, 1, 2, 3]) yield* create(`run-${index}`)
        return {
          bounded: yield* catalog.listRunIds({ limit: 2 }),
          whole: yield* catalog.listRunIds()
        }
      }))

      // A bounded read is the tail of the whole one: a workspace past the
      // bound follows its most recent runs, not an arbitrary window of them.
      expect(listed.bounded).toEqual(["run-2", "run-3"])
      expect(listed.whole).toEqual(["run-0", "run-1", "run-2", "run-3"])
    }))

  it.effect("defines zero as empty and rejects every other invalid bound before SQL", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile
      const observed = yield* onFile(filename)(Effect.gen(function*() {
        const catalog = yield* RunCatalogOps.make()
        yield* create("run-present")
        const invalid = []
        for (
          const limit of [
            -1,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.MAX_SAFE_INTEGER + 1
          ]
        ) {
          invalid.push(yield* catalog.listRunIds({ limit }).pipe(Effect.exit))
        }
        return { zero: yield* catalog.listRunIds({ limit: 0 }), invalid }
      }))

      expect(observed.zero).toEqual([])
      for (const exit of observed.invalid) {
        expect(exit).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { code: "invalid_options" } }] }
        })
      }
    }))

  it.effect("bounds the default read to its newest ten thousand rows", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile
      const listed = yield* onFile(filename)(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const catalog = yield* RunCatalogOps.make()
        for (let offset = 0; offset < RunCatalogOps.defaultLimit + 1; offset += 250) {
          const rows = Array.from(
            { length: Math.min(250, RunCatalogOps.defaultLimit + 1 - offset) },
            (_, index) => ({
              run_id: `run-${String(offset + index).padStart(5, "0")}`,
              status: "pending",
              created_at_ms: offset + index,
              state_json: runState
            })
          )
          yield* sql`INSERT INTO flows_runs ${sql.insert(rows)}`
        }
        return yield* catalog.listRunIds()
      }))

      expect(listed).toHaveLength(RunCatalogOps.defaultLimit)
      expect(listed[0]).toBe("run-00001")
      expect(listed.at(-1)).toBe("run-10000")
    }))

  it.effect("keeps the newest runs across the hot-backup restore path", () =>
    Effect.gen(function*() {
      const source = yield* temporaryFile
      const backup = join(yield* Effect.promise(() => mkdtemp(join(tmpdir(), "run-catalog-backup-"))), "engine.db")

      // The read orders by the run table's physical row order, which is the
      // order the workspace gained its runs. `VACUUM INTO` is the backup this
      // release ships (the release policy) and a restore is a copy of its
      // output, so the tail a follower sees has to survive one — including
      // after retention has deleted rows out of the middle and the end, which
      // is when SQLite reuses row identifiers.
      yield* onFile(source)(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        for (const index of [0, 1, 2, 3, 4]) yield* create(`run-${index}`)
        yield* sql`DELETE FROM flows_runs WHERE ${sql.in("run_id", ["run-1", "run-4"])}`.pipe(Effect.orDie)
        yield* create("run-5")
        yield* sql`VACUUM INTO ${backup}`.pipe(Effect.orDie)
      }))

      const restored = yield* onFile(backup)(Effect.gen(function*() {
        const catalog = yield* RunCatalogOps.make()
        return {
          bounded: yield* catalog.listRunIds({ limit: 2 }),
          whole: yield* catalog.listRunIds()
        }
      }))

      expect(restored.whole).toEqual(["run-0", "run-2", "run-3", "run-5"])
      expect(restored.bounded).toEqual(["run-3", "run-5"])
    }))

  it.effect("fails typed when the run table is not there", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile

      const exit = yield* onFile(filename)(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const catalog = yield* RunCatalogOps.make()
        yield* sql`DROP TABLE flows_runs ${sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))}`
          .pipe(Effect.orDie)
        return yield* Effect.exit(catalog.listRunIds())
      }))

      expect(exit._tag).toBe("Failure")
      if (exit._tag !== "Failure") return
      expect(exit.cause.reasons[0]).toMatchObject({ error: { code: "list_failed" } })
    }))

  it.effect("provides the read as a layer", () =>
    Effect.gen(function*() {
      const filename = yield* temporaryFile

      const listed = yield* onFile(filename)(
        Effect.gen(function*() {
          yield* create("run-layered")
          const catalog = yield* RunCatalogOps.RunCatalogRead
          return yield* catalog.listRunIds()
        }).pipe(Effect.provide(RunCatalogOps.layer))
      )

      expect(listed).toEqual(["run-layered"])
    }))
})
