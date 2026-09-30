import { describe, expect, it } from "@effect/vitest"
import * as Sha256 from "@smthrs/crypto/Sha256"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { DatabaseSync } from "node:sqlite"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Retention from "../src/Retention.ts"
import * as RunChangeFeed from "../src/RunChangeFeed.ts"
import { fixture, onFile, state } from "./ExecutionSnapshotFixture.ts"

describe("execution snapshots", () => {
  it.effect("observes requested identity, each wait kind, spawn-parent precedence, revisions and explicit absence", () =>
    fixture((file) =>
      Effect.gen(function*() {
        yield* onFile(
          file,
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES ('root', 'completed', 1, ${state}), ('parent', 'pending', 1, ${state})`
            for (
              const [index, reason] of ["timer", "event", "signal", "approval", "quota", "human", "custom"].entries()
            ) {
              yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, waiting_reason, waiting_token, waiting_wake_at_ms)
            VALUES (${reason}, 'suspended', ${index + 2}, ${state}, ${reason}, 'token', 123)`
            }
            yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, lineage_id, round_ordinal, parent_run_id)
          VALUES ('round', 'suspended', 3, ${state}, 'root', 1, 'root')`
            yield* sql`INSERT INTO flows_run_parents VALUES ('timer', 'parent', 2), ('timer', 'root', 1)`
          })
        )
        yield* onFile(
          file,
          Effect.gen(function*() {
            const reader = yield* ExecutionSnapshot.make()
            const batch = yield* reader.read([
              "timer",
              "root",
              "round",
              "absent",
              "event",
              "signal",
              "approval",
              "quota",
              "human",
              "custom",
              "root"
            ])
            expect(batch.snapshots.map((row) => row.runId)).toEqual([
              "timer",
              "root",
              "round",
              "absent",
              "event",
              "signal",
              "approval",
              "quota",
              "human",
              "custom",
              "root"
            ])
            expect(batch.snapshots[0]).toMatchObject({
              _tag: "Observed",
              parentRunId: "root",
              waiting: { kind: "timer", wakeAtMs: 123, tokenDigest: Sha256.digestSync("token") }
            })
            expect(batch.snapshots[1]).toMatchObject({
              _tag: "Observed",
              status: "completed",
              parentRunId: null,
              lineageId: "root",
              roundOrdinal: 0,
              waiting: null
            })
            expect(batch.snapshots[2]).toMatchObject({
              _tag: "Observed",
              parentRunId: "root",
              lineageId: "root",
              roundOrdinal: 1
            })
            expect(batch.snapshots[3]).toEqual({
              _tag: "Missing",
              runId: "absent",
              source: batch.source,
              revision: batch.revision,
              deleted: false
            })
            expect(batch.snapshots.slice(4, 10).map((row) => row._tag === "Observed" && row.waiting?.kind)).toEqual([
              "signal",
              "signal",
              "approval",
              "quota",
              "human",
              "other"
            ])
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE flows_runs SET parent_run_id = 'parent' WHERE run_id = 'timer'`
            const after = yield* reader.read(["timer"])
            expect(after.snapshots[0]).toMatchObject({ parentRunId: "parent" })
            expect(ExecutionSnapshot.isNewer(after.snapshots[0]!, batch.snapshots[0]!)).toBe(true)
            expect(ExecutionSnapshot.isNewer(batch.snapshots[0]!, after.snapshots[0]!)).toBe(false)
            expect(ExecutionSnapshot.isNewer(after.snapshots[0]!, after.snapshots[0]!)).toBe(false)
            expect(ExecutionSnapshot.isNewer({ ...after, source: "0".repeat(32) }, after)).toBe(false)
            expect((yield* reader.read([])).snapshots).toEqual([])
            for (const count of [199, 200]) {
              expect((yield* reader.read(Array.from({ length: count }, () => "root"))).snapshots).toHaveLength(count)
            }
            expect((yield* Effect.flip(reader.read(Array.from({ length: 201 }, () => "root")))).code).toBe(
              "decode_failed"
            )
          })
        )
      })
    ))

  it.effect("coalesces bounded catch-up, retains tombstones after reopening and rejects terminal resurrection", () =>
    fixture((file) =>
      Effect.gen(function*() {
        const source = yield* onFile(
          file,
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const feed = yield* RunChangeFeed.make()
            const start = yield* feed.current
            expect(start.revision).toBe(0)
            expect((yield* feed.changesSince({ ...start, limit: 1 })).changes).toEqual([])
            for (const id of ["a", "b", "c"]) {
              yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (${id}, 'pending', 1, ${state})`
            }
            const reader = yield* ExecutionSnapshot.make()
            const stale = (yield* reader.read(["a"])).snapshots[0]!
            yield* sql`UPDATE flows_runs SET status = 'completed' WHERE run_id = 'a'`
            const terminal = (yield* reader.read(["a"])).snapshots[0]!
            let projection = terminal
            if (ExecutionSnapshot.isNewer(stale, projection)) {
              projection = stale
            }
            expect(projection).toMatchObject({ status: "completed" })
            yield* sql`DELETE FROM flows_runs WHERE run_id = 'b'`
            const first = yield* feed.changesSince({ ...start, limit: 1 })
            expect(first.hasMore).toBe(true)
            expect(first.changes.map((change) => change.runId)).toEqual(["c"])
            const rest = yield* feed.changesSince({ source: start.source, revision: first.nextRevision, limit: 2 })
            expect(rest.changes.map(({ deleted, runId }) => ({ runId, deleted }))).toEqual([{
              runId: "a",
              deleted: false
            }, { runId: "b", deleted: true }])
            expect(rest.hasMore).toBe(false)
            expect(rest.nextRevision).toBe(rest.revision)
            for (const limit of [0, 1001]) {
              expect((yield* Effect.flip(feed.changesSince({ ...start, limit }))).code).toBe("decode_failed")
            }
            for (const limit of [999, 1000]) {
              expect((yield* feed.changesSince({ ...start, limit })).changes).toHaveLength(3)
            }
            expect((yield* Effect.flip(feed.changesSince({ ...start, revision: 999, limit: 1 }))).code).toBe(
              "invalid_run"
            )
            expect((yield* Effect.flip(feed.changesSince({ ...start, source: "0".repeat(32), limit: 1 }))).code).toBe(
              "invalid_run"
            )
            return start.source
          })
        )
        yield* onFile(
          file,
          Effect.gen(function*() {
            const reader = yield* ExecutionSnapshot.make()
            const deleted = (yield* reader.read(["b"])).snapshots[0]!
            expect(deleted).toMatchObject({ _tag: "Missing", source, deleted: true })
            const feed = yield* RunChangeFeed.make()
            expect(
              (yield* feed.changesSince({ source, revision: 0, limit: 10 })).changes.find((c) => c.runId === "b")
                ?.deleted
            ).toBe(true)
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE flows_runs SET finished_at_ms = 1 WHERE run_id = 'a'`
            expect((yield* Retention.collect({ olderThanMs: 2 })).runs).toEqual(["a"])
            // The consumer still has revision zero after an ordinary retention pass.
            expect((yield* feed.changesSince({ source, revision: 0, limit: 10 })).changes.map((change) => ({
              runId: change.runId,
              deleted: change.deleted
            }))).toEqual([
              { runId: "c", deleted: false },
              { runId: "b", deleted: true },
              { runId: "a", deleted: true }
            ])
          })
        )
      })
    ))

  it.effect("keeps intent distinct from fenced durable acknowledgement", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.gen(function*() {
          const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
          const reader = yield* ExecutionSnapshot.make()
          const owner = { hostId: "owner", pid: 1, nonce: "fence" }
          yield* runs.create("cancel", state)
          yield* runs.claimAndOwn("cancel", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1)
          yield* runs.requestCancel("cancel", 2)
          expect((yield* reader.read(["cancel"])).snapshots[0]).toMatchObject({
            cancellation: { requestedAtMs: 2, acknowledgement: null }
          })
          yield* runs.acknowledgeCancel("cancel", owner, 3)
          yield* runs.transitionOwned("cancel", owner, "cancelled", state)
          expect((yield* reader.read(["cancel"])).snapshots[0]).toMatchObject({
            status: "cancelled",
            cancellation: { requestedAtMs: 2, acknowledgement: { observedAtMs: 3, owner } }
          })
        })
      )
    ))

  it.effect("holds one read revision while a peer completes the run between statements", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, waiting_reason, waiting_wake_at_ms)
      VALUES ('race', 'suspended', 1, ${state}, 'timer', 123)`
          const peer = new DatabaseSync(file)
          let interleaved = false
          try {
            const instrumented = new Proxy(sql, {
              get(target, key, receiver) {
                if (key !== "unsafe") return Reflect.get(target, key, receiver)
                return (...args: Parameters<typeof sql.unsafe>) => {
                  if (!interleaved && args[0].includes("spawn_parent_id")) {
                    interleaved = true
                    peer.exec(
                      "UPDATE flows_runs SET status = 'completed', waiting_reason = NULL, waiting_wake_at_ms = NULL WHERE run_id = 'race'"
                    )
                  }
                  return target.unsafe(...args)
                }
              }
            })
            const reader = yield* ExecutionSnapshot.make().pipe(
              Effect.provideService(SqlClient.SqlClient, instrumented)
            )
            const during = yield* reader.read(["race"])
            expect(interleaved).toBe(true)
            expect(during.snapshots[0]).toMatchObject({
              status: "suspended",
              waiting: { kind: "timer", wakeAtMs: 123 }
            })
            const after = yield* reader.read(["race"])
            expect(after.snapshots[0]).toMatchObject({ status: "completed", waiting: null })
            expect(after.revision).toBeGreaterThan(during.revision)
          } finally {
            peer.close()
          }
        })
      )
    ))

  it.effect("preserves interruption and the original SQL/defect causes, then releases the transaction", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('a', 'pending', 1, ${state})`
          const original = new Error("read defect")
          for (const injected of [Effect.interrupt, Effect.die(original), Effect.fail(original)]) {
            const instrumented = new Proxy(sql, {
              get(target, key, receiver) {
                return key === "unsafe"
                  ? () => injected
                  : Reflect.get(target, key, receiver)
              }
            })
            const reader = yield* ExecutionSnapshot.make().pipe(
              Effect.provideService(SqlClient.SqlClient, instrumented)
            )
            const exit = yield* Effect.exit(reader.read(["a"]))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              if (injected === Effect.interrupt) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
              else expect(Cause.squash(exit.cause)).toMatchObject({ code: "persistence_failed", cause: original })
            }
            const real = yield* ExecutionSnapshot.make()
            expect((yield* real.read(["a"])).snapshots[0]).toMatchObject({ _tag: "Observed" })
          }
          const service = yield* ExecutionSnapshot.ExecutionSnapshot.pipe(Effect.provide(ExecutionSnapshot.layer))
          expect((yield* service.read(["a"])).snapshots).toHaveLength(1)
          const feed = yield* RunChangeFeed.RunChangeFeed.pipe(Effect.provide(RunChangeFeed.layer))
          expect((yield* feed.current).revision).toBeGreaterThan(0)
        })
      )
    ))

  it.effect("fails closed for corrupt lifecycle, wait, identity, parent and source rows", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const reader = yield* ExecutionSnapshot.make()
          yield* TestDatabase.checks(sql, false)
          const corruptions = [
            "status = 'unknown'",
            "status = 'running'",
            "waiting_reason = ''",
            "waiting_wake_at_ms = 2",
            "waiting_token = 'token'",
            "waiting_request = '{}'",
            "waiting_reason = 'approval', waiting_request = 'not-json'",
            "owner_host_id = 'foreign'",
            "parent_run_id = run_id",
            "state_json = '{}'",
            "lineage_id = 'lineage'",
            "execution_parent_id = 'wrong'",
            "cancel_acknowledgement_json = '{\"observedAtMs\":1,\"owner\":{\"hostId\":\"h\",\"pid\":1,\"nonce\":\"n\"}}'"
          ]
          for (const [index, corruption] of corruptions.entries()) {
            const id = `bad-${index}`
            yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES (${id}, 'pending', 1, ${state})`
            yield* sql.unsafe(`UPDATE flows_runs SET ${corruption} WHERE run_id = ?`, [id])
            const error = yield* Effect.flip(reader.read([id]))
            expect(error.code).toBe("decode_failed")
            expect(error.cause).toBeDefined()
          }
          yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('parent-bad', 'pending', 1, ${state})`
          yield* sql`INSERT INTO flows_run_parents VALUES ('parent-bad', '', -1)`
          expect((yield* Effect.flip(reader.read(["parent-bad"]))).code).toBe("decode_failed")
          yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('revision-bad', 'pending', 1, ${state})`
          yield* sql`UPDATE flows_run_changes SET revision = 0 WHERE run_id = 'revision-bad'`
          expect((yield* Effect.flip(reader.read(["revision-bad"]))).code).toBe("decode_failed")
          yield* sql`UPDATE flows_run_changes SET revision = (SELECT revision + 1 FROM flows_run_source) WHERE run_id = 'revision-bad'`
          expect((yield* Effect.flip(reader.read(["revision-bad"]))).code).toBe("decode_failed")
          yield* sql`UPDATE flows_run_changes SET deleted = 1 WHERE run_id = 'revision-bad'`
          expect((yield* Effect.flip(reader.read(["revision-bad"]))).code).toBe("decode_failed")
          for (const id of ["nul\0id", "bad\ud800", "x".repeat(1025)]) {
            expect((yield* Effect.flip(reader.read([id]))).code).toBe("decode_failed")
          }
          for (const size of [1023, 1024]) {
            expect((yield* reader.read(["x".repeat(size)])).snapshots[0]!._tag).toBe("Missing")
          }
          yield* sql`UPDATE flows_run_source SET source = 'bad'`
          expect((yield* Effect.flip(reader.read(["missing"]))).code).toBe("decode_failed")
        })
      )
    ))
})
