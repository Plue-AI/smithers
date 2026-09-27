/**
 * The durable Node host adapter for credential persistence, over the
 * production SQLite driver in `@smthrs/database`.
 */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Deferred, Effect, Exit, Layer, Option, Redacted } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import * as Credential from "../src/Credential.ts"
import type * as CredentialStore from "../src/CredentialStore.ts"
import * as ControlMigrations from "../src/Migrations.ts"
import * as SqlCredentialStore from "../src/SqlCredentialStore.ts"
import * as WebCryptoCipher from "../src/WebCryptoCipher.ts"

const hostKey = Redacted.make(btoa("0123456789abcdef0123456789abcdef"))

const withStore = <A, E>(
  use: (store: CredentialStore.Service) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    Effect.flatMap(SqlCredentialStore.make, use).pipe(
      Effect.provide(TestDatabase.layer),
      Effect.scoped,
      Effect.orDie
    )
  )

/** The typed error an exit failed with, asserted field by field. */
const squash = <A, E>(exit: Exit.Exit<A, E>): Record<string, unknown> => {
  if (Exit.isSuccess(exit)) throw new Error("expected a typed failure")
  return Cause.squash(exit.cause) as Record<string, unknown>
}

/**
 * A database on disk, so a session can close every layer and a later one can
 * open the same bytes. The migration ledger is written the way a host writes
 * it, because the driver refuses to reopen a file that has tables without one.
 */
const durableDatabase = (filename: string) =>
  Layer.provideMerge(
    ControlMigrations.layer,
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  )

/** A fresh database path whose directory is removed when the test ends. */
const databaseFile = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "control-credentials-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, "control.db")
}

const record = (overrides: Partial<CredentialStore.SealedRecord> = {}): CredentialStore.SealedRecord => ({
  id: "exa",
  name: "Exa search",
  ciphertext: "Y2lwaGVy",
  nonce: "bm9uY2U=",
  version: 1,
  updatedAtMs: 1_000,
  ...overrides
})

describe("SqlCredentialStore", () => {
  it("writes, reads, lists, and removes a sealed record", async () => {
    const observed = await withStore((store) =>
      Effect.gen(function*() {
        yield* store.write(record())
        yield* store.write(record({ id: "openai", name: "OpenAI" }))
        const read = yield* store.read("exa")
        const listed = yield* store.list()
        yield* store.remove("openai")
        const afterRemove = yield* store.list()
        return {
          read: Option.getOrThrow(read),
          names: listed.map((entry) => entry.name),
          remaining: afterRemove.map((entry) => entry.id)
        }
      })
    )

    expect(observed.read).toEqual(record())
    expect(observed.names).toEqual(["Exa search", "OpenAI"])
    expect(observed.remaining).toEqual(["exa"])
  })

  it("reports a missing id as none", async () => {
    const read = await withStore((store) => store.read("absent"))
    expect(Option.isNone(read)).toBe(true)
  })

  it("refuses a write whose expected version has moved on", async () => {
    const error = await withStore((store) =>
      Effect.map(
        Effect.exit(Effect.gen(function*() {
          yield* store.write(record())
          yield* store.write(record({ version: 2, ciphertext: "c2Vjb25k" }))
          // Derived from version 1, but the row is already at 2.
          yield* store.write(record({ version: 2, ciphertext: "bG9zZXI=" }))
        })),
        squash
      )
    )

    expect(error._tag).toBe("/control/CredentialConflict")
    expect(error.expectedVersion).toBe(1)
    expect(error.actualVersion).toBe(2)
  })

  it("refuses a first write that does not start at version 1", async () => {
    const error = await withStore((store) => Effect.map(Effect.exit(store.write(record({ version: 3 }))), squash))
    expect(error._tag).toBe("/control/CredentialConflict")
    expect(error.expectedVersion).toBe(2)
    expect(error.actualVersion).toBe(0)
  })

  it("removes an absent id without failing", async () => {
    await withStore((store) => store.remove("absent"))
  })

  it("carries the whole credential contract on the durable adapter", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* SqlCredentialStore.make
        const cipher = yield* WebCryptoCipher.make({ key: hostKey })
        const credentials = Credential.make({ store, cipher })
        const reference = yield* credentials.create({
          id: "exa",
          name: "Exa search",
          secret: Redacted.make("sk-live-durable")
        })
        yield* credentials.rotate(reference, Redacted.make("sk-live-rotated"))
        const resolved = yield* credentials.resolve(reference)
        const persisted = Option.getOrThrow(yield* store.read("exa"))
        yield* credentials.revoke(reference)
        const afterRevoke = yield* store.read("exa")
        return {
          secret: Redacted.value(resolved),
          persisted,
          revoked: Option.isNone(afterRevoke)
        }
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped, Effect.orDie)
    )

    expect(observed.secret).toBe("sk-live-rotated")
    expect(observed.persisted.version).toBe(2)
    // What is on disk is ciphertext, not the rotated secret.
    expect(JSON.stringify(observed.persisted)).not.toContain("sk-live-rotated")
    expect(observed.revoked).toBe(true)
  })

  it("resolves and revokes a rotated credential after every layer is closed", async () => {
    // The in-memory database dies with its scope, so it can only show that a
    // secret survives one process. This walks the real promise: what is on
    // disk after a rotation is what a later host opens and decrypts.
    const filename = databaseFile()
    const session = <A, E>(
      body: (
        host: {
          readonly store: CredentialStore.Service
          readonly credentials: Credential.Credential
        }
      ) => Effect.Effect<A, E>
    ): Promise<A> =>
      Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* SqlCredentialStore.make
          const cipher = yield* WebCryptoCipher.make({ key: hostKey })
          return yield* body({ store, credentials: Credential.make({ store, cipher }) })
        }).pipe(Effect.provide(durableDatabase(filename)), Effect.scoped, Effect.orDie)
      )

    const reference = await session(({ credentials }) =>
      Effect.gen(function*() {
        const created = yield* credentials.create({
          id: "exa",
          name: "Exa search",
          secret: Redacted.make("sk-live-first")
        })
        yield* credentials.rotate(created, Redacted.make("sk-live-rotated"))
        return created
      })
    )

    const reopened = await session(({ credentials, store }) =>
      Effect.gen(function*() {
        const resolved = yield* credentials.resolve(reference)
        const persisted = Option.getOrThrow(yield* store.read("exa"))
        return {
          secret: Redacted.value(resolved),
          version: persisted.version,
          names: (yield* credentials.list()).map((entry) => entry.name)
        }
      })
    )

    expect(reopened).toEqual({ secret: "sk-live-rotated", version: 2, names: ["Exa search"] })

    await session(({ credentials }) => credentials.revoke(reference))
    const afterRevoke = await session(({ store }) => store.read("exa"))
    expect(Option.isNone(afterRevoke)).toBe(true)
  })

  it("refuses the loser when two independently opened stores rotate at one version", async () => {
    // Two connections on one file, each with its own writer, as two host
    // processes sharing a database. The SQLite driver is synchronous, so one
    // runtime never suspends inside a write and the overlap has to be
    // arranged: the second store starts its rotation while the first holds an
    // uncommitted one open, which is the only state the transaction exists to
    // survive. Both writers derived version 2 from the same version 1.
    const filename = databaseFile()
    const opened = Deferred.makeUnsafe<void>()
    const holding = Deferred.makeUnsafe<void>()

    const winner = Effect.gen(function*() {
      const store = yield* SqlCredentialStore.make
      const writer = yield* DurableWriter.DurableWriter
      yield* Deferred.await(opened)
      yield* store.write(record())
      yield* writer.write(Effect.gen(function*() {
        yield* store.write(record({ version: 2, ciphertext: "Zmlyc3Q=" }))
        yield* Deferred.succeed(holding, undefined)
        // Hold the row while the other connection attempts its rotation. The
        // waiter cannot signal this fiber to finish: resuming it would commit
        // before the second store had begun, which is the interleaving under
        // test.
        yield* Effect.sleep("100 millis")
      }))
    }).pipe(Effect.provide(durableDatabase(filename)), Effect.scoped, Effect.orDie)

    const loser = Effect.gen(function*() {
      const store = yield* SqlCredentialStore.make
      yield* Deferred.succeed(opened, undefined)
      yield* Deferred.await(holding)
      return yield* Effect.exit(store.write(record({ version: 2, ciphertext: "c2Vjb25k" })))
    }).pipe(Effect.provide(durableDatabase(filename)), Effect.scoped, Effect.orDie)

    const [, refused] = await Effect.runPromise(Effect.all([winner, loser], { concurrency: "unbounded" }))

    const conflict = squash(refused)
    expect(conflict._tag).toBe("/control/CredentialConflict")
    expect(conflict.expectedVersion).toBe(1)
    expect(conflict.actualVersion).toBe(2)

    // A third connection reads what a later host would open: the loser never
    // overwrote the winner.
    const persisted = await Effect.runPromise(
      Effect.flatMap(SqlCredentialStore.make, (store) => store.read("exa")).pipe(
        Effect.provide(durableDatabase(filename)),
        Effect.scoped,
        Effect.orDie
      )
    )
    expect(Option.getOrThrow(persisted).ciphertext).toBe("Zmlyc3Q=")
    expect(Option.getOrThrow(persisted).version).toBe(2)
  })

  it("reports every operation as unavailable storage when the table is gone", async () => {
    // A dropped table is what a half-migrated database, a restored backup, or
    // a wrong `SMITHERS_HOME` looks like from here. Each operation names
    // itself, so an operator reads which call could not reach storage rather
    // than a driver sentence about SQL.
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const store = yield* SqlCredentialStore.make
        yield* sql`DROP TABLE control_credentials ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`.pipe(Effect.orDie)
        return yield* Effect.forEach(
          [
            store.read("exa"),
            store.write(record()),
            store.list(),
            store.remove("exa")
          ],
          (operation) => Effect.map(Effect.exit(operation), squash)
        )
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped, Effect.orDie)
    )

    expect(failures.map((failure) => failure.feature)).toEqual([
      "credential storage (read)",
      "credential storage (write)",
      "credential storage (list)",
      "credential storage (remove)"
    ])
    for (const failure of failures) {
      expect(failure._tag).toBe("/control/Unavailable")
      expect(failure.ticket).toBe("control-credential-storage")
    }
  })

  it("provides the durable store as a layer", async () => {
    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* SqlCredentialStore.make
        return yield* store.list()
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped, Effect.orDie)
    )

    expect(listed).toEqual([])
  })
})
