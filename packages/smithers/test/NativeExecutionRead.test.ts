/** Malformed ancestry cannot be authored through the valid native writer;
 * a snapshot-port fixture qualifies this boundary's fail-closed behavior.
 * NativeRunActivityCancellation independently exercises the real stores. */
import { PersistenceError } from "@smthrs/control/ControlError"
import * as Sha256 from "@smthrs/crypto/Sha256"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import type * as Snapshot from "@smthrs/engine-store/ExecutionSnapshot"
import * as ExecutionSnapshot from "@smthrs/engine-store/ExecutionSnapshot"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as RunStore from "@smthrs/run-store/RunStore"
import { RunStoreError } from "@smthrs/run-store/RunStore"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import * as NativeExecutionRead from "../src/internal/NativeExecutionRead.ts"

const source = "a".repeat(32)
const tokenDigest = Sha256.digestSync("wait-token")
const observed = (runId: string, parentRunId: string | null = null, lineageId = runId): Snapshot.Observed => ({
  _tag: "Observed",
  runId,
  source,
  revision: 1,
  flowName: "work",
  status: "running",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  parentRunId,
  lineageId,
  roundOrdinal: lineageId === runId ? 0 : 1,
  cancellation: { requestedAtMs: null, acknowledgement: null },
  waiting: null
})
const missing = (runId: string, deleted = false): Snapshot.Missing => ({
  _tag: "Missing",
  runId,
  source,
  revision: 1,
  deleted
})
const port = (rows: ReadonlyArray<Snapshot.Snapshot>) => {
  const graph = new Map(rows.map((row) => [row.runId, row]))
  const requests: Array<ReadonlyArray<string>> = []
  const read: Snapshot.Service["read"] = (ids) =>
    Effect.sync(() => {
      requests.push(ids)
      return { source, revision: 1, snapshots: ids.map((id) => graph.get(id) ?? missing(id)) }
    })
  return { read, requests }
}

describe("native execution read confinement", () => {
  it.each(["absent", "present"] as const)(
    "decodes public wait observations with %s redacted request metadata",
    async (mode) => {
      const native = port([{
        ...observed("root"),
        waiting: {
          kind: "approval",
          reason: "approval",
          wakeAtMs: 123,
          tokenDigest,
          ...(mode === "absent" ? {} : { request: { title: "Approve", token: "credential-value" } })
        }
      }])
      const batch = await Effect.runPromise(NativeExecutionRead.make(native)({ runId: "root", executionIds: ["root"] }))
      expect(batch.snapshots[0]).toMatchObject({
        _tag: "Observed",
        observation: {
          waiting: {
            reason: "approval",
            wakeAtMs: 123,
            tokenDigest,
            ...(mode === "absent" ? {} : { request: { title: "Approve", token: "[REDACTED]" } })
          }
        }
      })
      expect(JSON.stringify(batch)).not.toContain("credential-value")
      if (batch.snapshots[0]!._tag === "Observed") {
        expect(batch.snapshots[0]!.observation.waiting).not.toHaveProperty("kind")
        if (mode === "absent") expect(batch.snapshots[0]!.observation.waiting).not.toHaveProperty("request")
      }
    }
  )

  it("refuses malformed public semantic observations instead of casting branded identities", async () => {
    const native = port([{ ...observed("root"), flowName: "" }])
    const error = await Effect.runPromise(
      NativeExecutionRead.make(native)({ runId: "root", executionIds: ["root"] })
        .pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(PersistenceError)
    expect(error.cause).toMatchObject({ _tag: "SchemaError" })
  })

  it("reads through a read-only SQLite adapter while another connection holds writer admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-execution-read-"))
    const filename = join(directory, "engine.db")
    const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const store = yield* RunStore.RunStore
          const state = JSON.stringify({ version: 1, flowName: "work", payload: {} })
          yield* store.create("root", state)
          yield* store.create("child", state, { parentRunId: "root" })
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const writer = yield* Effect.forkChild(sql.withTransaction(Effect.gen(function*() {
            yield* store.create("uncommitted", state)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          })))
          yield* Deferred.await(entered)
          const result = yield* Effect.gen(function*() {
            const read = yield* NativeExecutionRead.makeFromSql()
            return yield* read({ runId: "root", executionIds: ["child", "uncommitted"] })
          }).pipe(
            Effect.provide(NodeDatabase.layer({ filename, readOnly: true })),
            Effect.timeout("5 seconds"),
            Effect.ensuring(Deferred.succeed(release, undefined))
          )
          yield* Fiber.join(writer)
          expect(result.snapshots[0]).toMatchObject({ _tag: "Observed", observation: { parentRunId: "root" } })
          expect(result.snapshots[1]).toEqual({
            _tag: "Unavailable",
            executionId: "uncommitted",
            reason: "ancestry-unavailable"
          })
          expect((yield* store.get("uncommitted")).status).toBe("pending")
        }).pipe(
          Effect.provide(RunStore.layer),
          Effect.provide(Migrations.layer),
          Effect.provide(database),
          Effect.scoped
        )
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  // The `smithers` test target sets SMITHERS_HISTORY_TEST_PG_URL beside its
  // PostgreSQL service. `TestDatabase` selects PostgreSQL from
  // SMITHERS_TEST_PG_URL, which that target must not export; see
  // scripts/test-pins.md.
  it.skipIf(process.env.SMITHERS_HISTORY_TEST_PG_URL === undefined)(
    "PostgreSQL retains one native ancestry snapshot across a committed writer on a separate connection",
    async () => {
      vi.stubEnv("SMITHERS_TEST_PG_URL", process.env.SMITHERS_HISTORY_TEST_PG_URL!)
      onTestFinished(() => {
        vi.unstubAllEnvs()
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const store = yield* RunStore.RunStore
          const state = JSON.stringify({ version: 1, flowName: "work", payload: {} })
          yield* store.create("root", state)
          yield* store.create("child", state, { parentRunId: "root" })
          const entered = yield* Deferred.make<void>()
          const committed = yield* Deferred.make<void>()
          const writer = yield* Effect.forkChild(Effect.gen(function*() {
            yield* Deferred.await(entered)
            yield* store.requestCancel("root", 123)
            yield* Deferred.succeed(committed, undefined)
          }))
          const reader = yield* ExecutionSnapshot.make()
          let reads = 0
          const readBatches: Array<Snapshot.Batch> = []
          const native = NativeExecutionRead.make({
            read: (ids) =>
              reader.read(ids).pipe(Effect.tap((value) => {
                readBatches.push(value)
                return ++reads === 1
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(committed)))
                  : Effect.void
              }))
          })
          const batch = yield* ExecutionSnapshot.withReadTransaction(
            sql,
            native({ runId: "root", executionIds: ["child"] })
          ).pipe(Effect.timeout("5 seconds"))
          yield* Fiber.join(writer)
          expect(batch.snapshots[0]).toMatchObject({ _tag: "Observed", observation: { parentRunId: "root" } })
          expect(reads).toBe(2)
          expect(readBatches[1]).toMatchObject({ source: batch.source, revision: batch.revision })
          expect(readBatches[1]!.snapshots[0]).toMatchObject({ cancellation: { requestedAtMs: null } })
          const fresh = yield* reader.read(["root"])
          expect(fresh.revision).toBeGreaterThan(batch.revision!)
          expect(fresh.snapshots[0]).toMatchObject({ cancellation: { requestedAtMs: 123 } })
        }).pipe(
          Effect.provide(RunStore.layer),
          Effect.provide(Migrations.layer),
          Effect.provide(TestDatabase.layer),
          Effect.scoped
        )
      )
    }
  )

  it("observes real writer-created children, rounds and cancellation intent at one source watermark", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = JSON.stringify({ version: 1, flowName: "work", payload: {} })
        yield* store.create("root", state)
        yield* store.create("middle", state, { parentRunId: "root" })
        yield* store.create("child", state, { parentRunId: "middle" })
        yield* store.create("round", state, { lineageId: "root", roundOrdinal: 1 })
        yield* store.create("foreign", state)
        const read = yield* NativeExecutionRead.makeFromSql()
        const before = yield* read({ runId: "root", executionIds: ["child", "round", "foreign", "absent"] })
        expect(before.snapshots.map((row) => row._tag)).toEqual([
          "Observed",
          "Observed",
          "Unavailable",
          "Unavailable"
        ])
        expect(before.snapshots[0]).toMatchObject({ observation: { parentRunId: "middle", status: "pending" } })
        yield* store.requestCancel("child", 123)
        const after = yield* read({ runId: "root", executionIds: ["root", "child", "child"] })
        expect(after.source).toBe(before.source)
        expect(after.revision).toBeGreaterThan(before.revision!)
        expect(after.snapshots[1]).toMatchObject({ observation: { cancelRequestedAtMs: 123 } })
        expect(after.snapshots[1]).toEqual(after.snapshots[2])
        expect(after.snapshots[0]).toMatchObject({ observation: { cancelRequestedAtMs: null } })
        expect(
          after.snapshots.every((row) =>
            row._tag !== "Unavailable" && row.source === after.source && row.revision <= after.revision!
          )
        ).toBe(true)
      }).pipe(
        Effect.provide(RunStore.layer),
        Effect.provide(Migrations.layer),
        Effect.provide(TestDatabase.layer),
        Effect.scoped
      )
    )
  })

  it("reports a real missing-schema read failure through the persistence boundary", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const read = yield* NativeExecutionRead.makeFromSql()
        return yield* read({ runId: "root", executionIds: ["root"] }).pipe(Effect.flip)
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
    )
    expect(error).toBeInstanceOf(PersistenceError)
    expect(error.cause).toBeInstanceOf(RunStoreError)
  })

  it("retains a transaction admission failure before any snapshot body can start", async () => {
    const failure = new SqlError.SqlError({ reason: new SqlError.ConnectionError({ cause: "connection lost" }) })
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        // A real database supplies every service except this deterministic
        // failure at transaction admission, before the read acquires a connection.
        const refused = new Proxy(sql, {
          get: (target, key, receiver) => key === "reserve" ? Effect.fail(failure) : Reflect.get(target, key, receiver)
        })
        const read = yield* NativeExecutionRead.makeFromSql().pipe(Effect.provideService(SqlClient.SqlClient, refused))
        return yield* read({ runId: "root", executionIds: ["root"] }).pipe(Effect.flip)
      }).pipe(Effect.provide(TestDatabase.layer), Effect.scoped)
    )
    expect(error).toBeInstanceOf(PersistenceError)
    expect(error.cause).toBe(failure)
  })

  it("returns exact root, parent-linked children and verified rounds in request order", async () => {
    const native = port([
      observed("root"),
      observed("child", "root"),
      observed("round", null, "root"),
      observed("unrelated")
    ])
    const batch = await Effect.runPromise(
      NativeExecutionRead.make(native)({
        runId: "root",
        executionIds: ["root", "child", "round", "child", "unrelated"]
      })
    )
    expect(batch.snapshots.map((row) => [row.executionId, row._tag])).toEqual([
      ["root", "Observed"],
      ["child", "Observed"],
      ["round", "Observed"],
      ["child", "Observed"],
      ["unrelated", "Unavailable"]
    ])
    expect(batch.snapshots[4]).toEqual({ _tag: "Unavailable", executionId: "unrelated", reason: "outside-run" })
    expect(native.requests).toHaveLength(1)
    expect(batch.source).toBe(source)
    expect(batch.revision).toBe(1)
  })

  it("memoizes ancestors and never treats a name prefix as membership", async () => {
    const native = port([
      observed("root"),
      observed("middle", "root"),
      observed("one", "middle"),
      observed("two", "middle"),
      observed("root/lookalike")
    ])
    const batch = await Effect.runPromise(
      NativeExecutionRead.make(native)({
        runId: "root",
        executionIds: ["one", "two", "root/lookalike"]
      })
    )
    expect(batch.snapshots.slice(0, 2).map((row) => row._tag)).toEqual(["Observed", "Observed"])
    expect(batch.snapshots[2]).toEqual({ _tag: "Unavailable", executionId: "root/lookalike", reason: "outside-run" })
    expect(native.requests).toEqual([["one", "two", "root/lookalike"], ["middle"], ["root"]])
  })

  it("keeps missing roots explicit and refuses absent, deleted or cyclic ancestry", async () => {
    const native = port([
      missing("root", true),
      missing("deleted-child", true),
      observed("child", "gone"),
      observed("missing-root-child", "root"),
      observed("cycle-a", "cycle-b"),
      observed("cycle-b", "cycle-a"),
      observed("round", null, "root")
    ])
    const batch = await Effect.runPromise(
      NativeExecutionRead.make(native)({
        runId: "root",
        executionIds: ["root", "deleted-child", "child", "missing-root-child", "cycle-a", "round"]
      })
    )
    expect(batch.snapshots[0]).toEqual({ _tag: "Missing", executionId: "root", source, revision: 1, deleted: true })
    for (const snapshot of batch.snapshots.slice(1)) {
      expect(snapshot).toEqual({
        _tag: "Unavailable",
        executionId: snapshot.executionId,
        reason: "ancestry-unavailable"
      })
    }
  })

  it("requires ancestry even when a foreign parent or cycle claims the authorized lineage", async () => {
    const native = port([
      observed("root"),
      observed("foreign"),
      observed("forged-round", "foreign", "root"),
      observed("cycle", "cycle", "root"),
      { ...observed("false-round", null, "root"), roundOrdinal: 0 }
    ])
    const batch = await Effect.runPromise(
      NativeExecutionRead.make(native)({
        runId: "root",
        executionIds: ["forged-round", "cycle", "false-round"]
      })
    )
    expect(batch.snapshots).toEqual([
      { _tag: "Unavailable", executionId: "forged-round", reason: "outside-run" },
      { _tag: "Unavailable", executionId: "cycle", reason: "ancestry-unavailable" },
      { _tag: "Unavailable", executionId: "false-round", reason: "outside-run" }
    ])
  })

  it("refuses a round whose lineage root is itself assigned to another lineage", async () => {
    const native = port([observed("root", null, "other"), observed("round", null, "root")])
    const batch = await Effect.runPromise(NativeExecutionRead.make(native)({ runId: "root", executionIds: ["round"] }))
    expect(batch.snapshots).toEqual([
      { _tag: "Unavailable", executionId: "round", reason: "ancestry-unavailable" }
    ])
  })

  it("keeps an empty coherent read and an existing boundary refusal intact", async () => {
    const native = port([])
    expect(await Effect.runPromise(NativeExecutionRead.make(native)({ runId: "root", executionIds: [] })))
      .toEqual({ source, revision: 1, snapshots: [] })
    const failure = new PersistenceError({ operation: "snapshot", message: "refused" })
    expect(
      await Effect.runPromise(
        NativeExecutionRead.make({ read: () => Effect.fail(failure) } as unknown as Pick<
          Snapshot.Service,
          "read"
        >)({ runId: "root", executionIds: [] }).pipe(Effect.flip)
      )
    ).toBe(failure)
  })

  it.each([127, 128])("bounds ancestry at the root boundary: %i links", async (links) => {
    const rows = Array.from(
      { length: links },
      (_, index) => observed(`node-${index}`, index + 1 === links ? "root" : `node-${index + 1}`)
    )
    const native = port([observed("root"), ...rows])
    const batch = await Effect.runPromise(NativeExecutionRead.make(native)({ runId: "root", executionIds: ["node-0"] }))
    expect(batch.snapshots[0]?._tag).toBe(links === 127 ? "Observed" : "Unavailable")
    if (links === 128) {
      expect(batch.snapshots[0]).toEqual({
        _tag: "Unavailable",
        executionId: "node-0",
        reason: "ancestry-unavailable"
      })
    }
    expect(native.requests.length).toBeLessThanOrEqual(129)
  })

  it.each(["source", "revision"] as const)("refuses an ancestor whose %s changed", async (changed) => {
    let reads = 0
    const native: Pick<Snapshot.Service, "read"> = {
      read: () =>
        Effect.sync(() => {
          reads++
          return reads === 1
            ? { source, revision: 1, snapshots: [observed("child", "root")] }
            : {
              source: changed === "source" ? "b".repeat(32) : source,
              revision: changed === "revision" ? 2 : 1,
              snapshots: [observed("root")]
            }
        })
    }
    const error = await Effect.runPromise(
      NativeExecutionRead.make(native)({
        runId: "root",
        executionIds: ["child"]
      }).pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(PersistenceError)
    expect(error.message).toContain("source changed")
  })

  it("preserves a read failure instead of returning guessed lifecycle", async () => {
    const cause = new RunStoreError({
      code: "persistence_failed",
      method: "ExecutionSnapshot.read",
      message: "adapter unavailable",
      cause: undefined
    })
    const error = await Effect.runPromise(
      NativeExecutionRead.make({ read: () => Effect.fail(cause) })({
        runId: "root",
        executionIds: ["child"]
      }).pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(PersistenceError)
    expect(error.cause).toBe(cause)
  })
})
