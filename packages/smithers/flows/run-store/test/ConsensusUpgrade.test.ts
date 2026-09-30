/**
 * Upgrading a database that was already driving runs before the journal's
 * `0006_consensus` lease table existed. The migration backfills a lease from
 * each owned run row, so the pre-upgrade owner keeps its fence, a stale owner
 * stays reclaimable, and the reclaimed owner is fenced out afterwards.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { heartbeatStaleAfter } from "../src/Heartbeat.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import { RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const survivor: OwnerId = { hostId: "host-a", pid: 11, nonce: "survivor" }
const dead: OwnerId = { hostId: "host-a", pid: 12, nonce: "dead" }
const successor: OwnerId = { hostId: "host-b", pid: 21, nonce: "successor" }
const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

/** The journal set as it stood before the lease table. */
const preConsensus: DatabaseMigrations.MigrationSet = {
  ...JournalMigrations.set,
  migrations: Object.fromEntries(
    Object.entries(JournalMigrations.set.migrations).filter(([name]) => name !== "0006_consensus")
  )
}

const append = (runId: string, owner: OwnerId, index: number) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    return yield* journal.emitDurable(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make(`upgrade-${owner.nonce}`),
        sourceSeq: JournalEvent.SourceSeq.make(index),
        eventType: "test.upgrade",
        payload: { index }
      }),
      owner
    )
  })

describe("upgrading owned runs onto the consensus lease table", () => {
  it.effect("keeps a live owner's fence and lets a stale owner be stolen and fenced out", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* DatabaseMigrations.run([preConsensus, Migrations.set])
      const nowMs = 10 * staleAfterMs
      for (const [runId, owner, heartbeatAtMs] of [["live", survivor, nowMs], ["stale", dead, 0]] as const) {
        yield* sql`
          INSERT INTO flows_runs (
            run_id, status, created_at_ms, started_at_ms,
            owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
          ) VALUES (
            ${runId}, 'running', 0, 0,
            ${owner.hostId}, ${owner.pid}, ${owner.nonce}, ${heartbeatAtMs}, '{}'
          )
        `
      }
      expect((yield* Migrations.run).map(([id]) => id)).toEqual([6])
      yield* TestClock.adjust(Duration.millis(nowMs))

      yield* Effect.gen(function*() {
        const store = yield* RunStore
        expect(yield* store.heartbeat("live", survivor, nowMs + 1)).toEqual({ _tag: "Updated" })
        expect((yield* append("live", survivor, 0))._tag).toBe("Accepted")

        const stale = { status: "running", owner: dead, heartbeatAtMs: 0 } as const
        const evidence = { expectedOwner: dead, checkedAtMs: nowMs, kind: "lease-expired" } as const
        expect(yield* store.steal("stale", stale, successor, nowMs, evidence)).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })
        expect(yield* store.activate("stale", successor, nowMs, stale)).toEqual({ _tag: "Activated" })
        expect((yield* append("stale", successor, 0))._tag).toBe("Accepted")
        const lost = yield* Effect.flip(append("stale", dead, 0))
        expect(lost.code).toBe("fence_lost")
        expect(yield* store.heartbeat("stale", dead, nowMs + 1)).toEqual({ _tag: "FenceLost" })
      }).pipe(
        Effect.provide(Layer.mergeAll(RunStoreLive.layer, SqlJournal.layer({ capacity: 16, overflow: "reject" }))),
        Effect.scoped
      )
    }).pipe(Effect.provide(TestDatabase.layer)))
})
