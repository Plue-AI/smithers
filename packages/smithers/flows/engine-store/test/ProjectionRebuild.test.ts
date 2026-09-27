import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { EngineEvent, Journal, JournalEvent } from "@smthrs/journal"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { Effect, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as AttemptLifecycle from "../src/internal/AttemptLifecycle.ts"
import * as TypedEvents from "../src/internal/TypedEvents.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const owner = { hostId: "a2", pid: 1, nonce: "projection" }
const runId = JournalEvent.RunId.make("projection-run")
const sourceId = JournalEvent.SourceId.make("projection-engine")
const lineageId = JournalEvent.LineageId.make("projection-lineage")
const consumer: EngineEvent.Consumer = {
  runId,
  lineageId,
  rootRunId: runId,
  round: 0,
  parentRunId: null,
  sources: [sourceId],
  unknown: "ignore"
}
const lineage = EngineEvent.Lineage.make({
  kind: "root",
  runId,
  lineageId,
  rootRunId: runId,
  round: 0,
  parentRunId: null
})
const typed = (index: number, lifecycle: EngineEvent.AttemptLifecycle) =>
  TypedEvents.attempt(
    {
      version: 2,
      lineage,
      executionId: runId,
      stepKeyDigest: JournalEvent.DispatchId.make(`step-${index}`),
      attempt: 1,
      lifecycle
    },
    sourceId,
    JournalEvent.SourceSeq.make(index * 2 + (lifecycle.state === "running" ? 0 : 1))
  )

const initializeRun = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  yield* runs.create(runId, "{}")
  const row = yield* runs.get(runId)
  const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
  const claim = yield* runs.claim(runId, snapshot, owner, 1)
  expect(claim._tag).toBe("Claimed")
  if (claim._tag !== "Claimed") return yield* Effect.die("fixture claim failed")
  yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
})

describe("attempt projection rebuild from retained typed SQLite history", () => {
  for (const count of [2, 70]) {
    for (const compacted of [false, true]) {
      it(`rebuilds ${count} attempts after SIGKILL between drop and rebuild (${compacted ? "checkpoint plus suffix" : "full history"})`, async () => {
        const directory = mkdtempSync(join(tmpdir(), "smithers-a2-projection-"))
        const filename = join(directory, "engine.db")
        try {
          const expected = await Effect.runPromise(
            Effect.gen(function*() {
              yield* initializeRun
              const attempts = yield* AttemptStore.AttemptStore
              const journal = yield* Journal.Journal
              const sql = yield* SqlClient.SqlClient
              const writer = yield* DurableWriter
              yield* writer.write(
                sql`CREATE TABLE a2_attempt_projection (id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`
              )
              for (let index = 0; index < count; index++) {
                const id = { runId, stepKeyDigest: `step-${index}`, attempt: 1 }
                const start = Schema.decodeUnknownSync(EngineEvent.AttemptLifecycle)({
                  state: "running",
                  startedAtMs: index + 10
                })
                yield* journal.transact(Effect.gen(function*() {
                  yield* attempts.put({ ...id, state: "running", startedAtMs: index + 10, meta: {} }, owner)
                  yield* journal.emitDurable(typed(index, start), owner)
                }))
                const failed = index % 2 === 1
                const lifecycle = Schema.decodeUnknownSync(EngineEvent.AttemptLifecycle)({
                  state: failed ? "failed" : "succeeded",
                  startedAtMs: index + 10,
                  finishedAtMs: index + 20,
                  result: failed ?
                    { _tag: "Failure", reason: "error", detail: { reason: "refused", index } }
                    : { _tag: "Success", value: { answer: index * 3 } }
                })
                yield* journal.transact(Effect.gen(function*() {
                  yield* attempts.finish({
                    ...id,
                    state: lifecycle.state,
                    finishedAtMs: index + 20,
                    ...(failed ? { error: { reason: "refused", index } } : { outcome: { answer: index * 3 } })
                  }, owner)
                  const receipt = yield* journal.emitDurable(typed(index, lifecycle), owner)
                  yield* writer.write(sql`INSERT INTO a2_attempt_projection (id, state_json)
                  VALUES (${id.stepKeyDigest}, ${
                    JSON.stringify({
                      executionId: runId,
                      stepKeyDigest: id.stepKeyDigest,
                      attempt: 1,
                      seq: receipt.seq,
                      lifecycle
                    })
                  })`)
                }))
              }
              const expected: Array<AttemptLifecycle.Row> = []
              for (let index = 0; index < count; index++) {
                const row = yield* attempts.get({ runId, stepKeyDigest: `step-${index}`, attempt: 1 })
                expect(Option.isSome(row)).toBe(true)
                const actual = Option.getOrThrow(row)
                // This oracle reads executable AttemptStore state, not projection output.
                const lifecycle = Schema.decodeUnknownSync(EngineEvent.AttemptLifecycle)({
                  state: actual.state,
                  startedAtMs: actual.startedAtMs,
                  finishedAtMs: actual.finishedAtMs,
                  result: actual.state === "failed" ?
                    { _tag: "Failure", reason: "error", detail: actual.error }
                    : { _tag: "Success", value: actual.outcome }
                })
                expected.push({
                  executionId: runId,
                  stepKeyDigest: actual.stepKeyDigest,
                  attempt: actual.attempt,
                  seq: index * 2 + 1,
                  lifecycle
                })
              }
              const live = yield* sql<
                { state_json: string }
              >`SELECT state_json FROM a2_attempt_projection ORDER BY rowid`
              expect(live.map((row) => JSON.parse(row.state_json))).toEqual(expected)
              if (compacted) {
                const fold = AttemptLifecycle.projection(consumer)
                const prefix = yield* journal.entries({ runId, limit: count })
                let state = fold.initial
                for (const entry of prefix.entries) state = yield* fold.reduce(state, entry)
                const seq = prefix.entries.at(-1)!.seq
                yield* journal.checkpoint({ runId, seq, state: { version: 2, lineage, seq, rows: state } }, owner)
                yield* journal.compact({ runId, upTo: seq }, owner)
              }
              return expected
            }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.scoped, withCrypto)
          )

          // The DROP commits in a separate real process. SIGKILL prevents any
          // application finalizer or in-memory projection from helping restore.
          const crashed = spawnSync(process.execPath, [
            "--input-type=module",
            "-e",
            `
            import { writeSync } from "node:fs";
            import { DatabaseSync } from "node:sqlite";
            process.on("exit", () => writeSync(1, "unexpected clean exit\\n"));
            const db = new DatabaseSync(process.argv[1]);
            db.exec("DROP TABLE a2_attempt_projection");
            writeSync(1, "projection dropped\\n");
            process.kill(process.pid, "SIGKILL");
          `,
            filename
          ], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" })
          expect(crashed.error).toBeUndefined()
          expect(crashed.stdout).toBe("projection dropped\n")
          // Windows self-kills use TerminateProcess(1), without a POSIX signal.
          expect(crashed.signal).toBe(process.platform === "win32" ? null : "SIGKILL")
          expect(crashed.status).toBe(process.platform === "win32" ? 1 : null)

          await Effect.runPromise(
            Effect.gen(function*() {
              const journal = yield* Journal.Journal
              const sql = yield* SqlClient.SqlClient
              const writer = yield* DurableWriter
              expect(yield* sql`SELECT name FROM ${TestDatabase.catalog(sql)} WHERE name = 'a2_attempt_projection'`)
                .toEqual([])
              const checkpoint = yield* journal.latestCheckpoint(runId)
              if (compacted) expect((yield* Effect.flip(journal.entries({ runId, limit: 17 }))).code).toBe("compacted")
              const fold = AttemptLifecycle.projection(consumer)
              const restoredSnapshot = Option.isSome(checkpoint)
                ? yield* AttemptLifecycle.restore(checkpoint.value.state, consumer)
                : undefined
              let state: AttemptLifecycle.State = restoredSnapshot?.rows ?? fold.initial
              let after = restoredSnapshot?.seq
              for (;;) {
                const page = yield* journal.entries({ runId, ...(after === undefined ? {} : { after }), limit: 17 })
                for (const entry of page.entries) state = yield* fold.reduce(state, entry)
                if (!page.hasMore) break
                after = page.entries.at(-1)!.seq
              }
              expect(state).toEqual(expected)
              yield* writer.write(Effect.gen(function*() {
                yield* sql`CREATE TABLE a2_attempt_projection (id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`
                for (const row of state) {
                  yield* sql`INSERT INTO a2_attempt_projection VALUES (${row.stepKeyDigest}, ${JSON.stringify(row)})`
                }
              }))
              const restored = yield* sql<
                { state_json: string }
              >`SELECT state_json FROM a2_attempt_projection ORDER BY rowid`
              expect(restored.map((row) => JSON.parse(row.state_json))).toEqual(expected)
            }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.scoped, withCrypto)
          )
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      })
    }
  }

  it("commits attempt state and its required event together, or neither across reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-a2-atomic-"))
    const filename = join(directory, "engine.db")
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* initializeRun
          const attempts = yield* AttemptStore.AttemptStore
          const journal = yield* Journal.Journal
          const sql = yield* SqlClient.SqlClient
          const writer = yield* DurableWriter
          const start = Schema.decodeUnknownSync(EngineEvent.AttemptLifecycle)({ state: "running", startedAtMs: 10 })
          const commit = (index: number) =>
            journal.transact(Effect.gen(function*() {
              yield* attempts.put({
                runId,
                stepKeyDigest: `step-${index}`,
                attempt: 1,
                state: "running",
                startedAtMs: 10,
                meta: {}
              }, owner)
              yield* journal.emitDurable(typed(index, start), owner)
            }))
          yield* writer.write(
            sql`CREATE TRIGGER a2_refuse_event BEFORE INSERT ON flows_journal_events BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`
          )
          expect((yield* Effect.exit(commit(0)))._tag).toBe("Failure")
          yield* writer.write(TestDatabase.dropTrigger(sql, "a2_refuse_event"))
          expect(
            (yield* Effect.exit(
              journal.transact(commit(1).pipe(Effect.andThen(Effect.fail("abort after both writes"))))
            ))._tag
          ).toBe("Failure")
          yield* commit(2)
        }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.scoped, withCrypto)
      )
      await Effect.runPromise(
        Effect.gen(function*() {
          const attempts = yield* AttemptStore.AttemptStore
          const journal = yield* Journal.Journal
          expect(yield* attempts.get({ runId, stepKeyDigest: "step-0", attempt: 1 })).toEqual(Option.none())
          expect(yield* attempts.get({ runId, stepKeyDigest: "step-1", attempt: 1 })).toEqual(Option.none())
          expect(Option.isSome(yield* attempts.get({ runId, stepKeyDigest: "step-2", attempt: 1 }))).toBe(true)
          const page = yield* journal.entries({ runId, limit: 10 })
          expect(page.entries).toHaveLength(1)
          const decoded = yield* TypedEvents.decodeEntry(page.entries[0], consumer)
          expect(decoded._tag).toBe("Attempt")
          if (decoded._tag === "Attempt") expect(decoded.payload.stepKeyDigest).toBe("step-2")
        }).pipe(Effect.provide(TestStores.layerAt(filename)), Effect.scoped, withCrypto)
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
