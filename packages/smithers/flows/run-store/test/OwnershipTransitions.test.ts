/**
 * Ownership transitions reach the journal (rule R6) on the run's companion
 * stream, never on the run's own stream.
 *
 * Every transition the consensus strategy grants is appended as a
 * `flows.consensus.<transition>` fact in the transaction that made it. The
 * run's own stream stays untouched, so a consumer that reads it by position
 * sees exactly what it saw before; a rolled-back transition leaves no fact;
 * heartbeats never enter the journal; and a caller without a journal records
 * nothing.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { heartbeatStaleAfter } from "../src/Heartbeat.ts"
import * as Migrations from "../src/Migrations.ts"
import type { LivenessEvidence, OwnerId } from "../src/Ownership.ts"
import { type RunSnapshot, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-b", pid: 202, nonce: "owner-b" }
const observer: OwnerId = { hostId: "host-b", pid: 303, nonce: "observer" }
const pending: RunSnapshot = { status: "pending", owner: null, heartbeatAtMs: null }
const staleMs = Duration.toMillis(heartbeatStaleAfter)

const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const withJournal = Layer.mergeAll(RunStoreLive.layer, SqlJournal.layer({ capacity: 64, overflow: "reject" })).pipe(
  Layer.provideMerge(database)
)
const run = <A, E>(body: Effect.Effect<A, E, RunStore | Journal | DurableWriter.DurableWriter | SqlClient.SqlClient>) =>
  Effect.scoped(body.pipe(Effect.provide(withJournal), Effect.provide(TestClock.layer())))

interface Fact {
  readonly eventType: string
  readonly payload: unknown
  readonly meta: unknown
}

/** Every fact on the run's companion stream, in sequence order. */
const facts = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    const companion = JournalEvent.companionRunId("run-store", runId)
    const page = yield* journal.entries({ runId: companion, limit: 100 })
    return page.entries.map((entry): Fact => ({ eventType: entry.eventType, payload: entry.payload, meta: entry.meta }))
  })

const ownRun = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    return (yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 100 })).entries
  })

const fact = (runId: string, transition: string, owner: OwnerId, grantedAtMs: number | null): Fact => ({
  eventType: `flows.consensus.${transition}`,
  payload: { runId, owner, grantedAtMs },
  meta: { runId }
})

describe("ownership transitions on the run-store companion stream", () => {
  it.effect("records claim, activation and release in order, and leaves the run's own stream empty", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-two-phase", "{}")
      const claim = yield* store.claim("run-two-phase", pending, ownerA, 0)
      expect(claim).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
      expect(yield* store.activate("run-two-phase", ownerA, 0, pending)).toEqual({ _tag: "Activated" })
      expect(yield* store.heartbeat("run-two-phase", ownerA, 0)).toEqual({ _tag: "Updated" })
      expect(yield* store.transitionOwned("run-two-phase", ownerA, "completed")).toEqual({ _tag: "Transitioned" })
      expect(yield* facts("run-two-phase")).toEqual([
        fact("run-two-phase", "claimed", ownerA, 0),
        fact("run-two-phase", "activated", ownerA, 0),
        fact("run-two-phase", "released", ownerA, null)
      ])
      expect(yield* ownRun("run-two-phase")).toEqual([])
    })))

  it.effect("records claimAndOwn as a claim and an activation, and a re-own as a release first", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-own", "{}")
      expect(yield* store.claimAndOwn("run-own", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      yield* TestClock.adjust(staleMs + 1)
      const row = yield* store.get("run-own")
      expect(yield* store.claimAndOwn("run-own", row, ownerA, staleMs + 1)).toEqual({ _tag: "Activated" })
      expect(yield* facts("run-own")).toEqual([
        fact("run-own", "claimed", ownerA, 0),
        fact("run-own", "activated", ownerA, 0),
        fact("run-own", "released", ownerA, null),
        fact("run-own", "claimed", ownerA, staleMs + 1),
        fact("run-own", "activated", ownerA, staleMs + 1)
      ])
    })))

  it.effect("records a steal by evidence, both through steal and through claimAndOwn", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      for (const runId of ["run-steal", "run-take"]) {
        yield* store.create(runId, "{}")
        expect(yield* store.claimAndOwn(runId, pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      }
      yield* TestClock.adjust(staleMs + 1)
      const nowMs = staleMs + 1
      const evidence: LivenessEvidence = {
        expectedOwner: ownerA,
        checkedAtMs: nowMs,
        kind: "cross-host-unreachable-stale"
      }
      const stale = yield* store.get("run-steal")
      expect(yield* store.steal("run-steal", stale, ownerB, nowMs, evidence)).toEqual({
        _tag: "Claimed",
        claimedAtMs: nowMs
      })
      const taken = yield* store.get("run-take")
      expect(yield* store.claimAndOwn("run-take", taken, ownerB, nowMs, evidence)).toEqual({ _tag: "Activated" })
      expect((yield* facts("run-steal")).slice(2)).toEqual([fact("run-steal", "stolen", ownerB, nowMs)])
      expect((yield* facts("run-take")).slice(2)).toEqual([
        fact("run-take", "stolen", ownerB, nowMs),
        fact("run-take", "activated", ownerB, nowMs)
      ])
    })))

  it.effect("records an abandoned claim, a snapshot-changed activation, and a recovered claim as their own facts", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-abandon", "{}")
      yield* store.claim("run-abandon", pending, ownerA, 0)
      expect(yield* store.abandonClaim("run-abandon", ownerA, 0)).toEqual({ _tag: "Abandoned" })

      yield* store.create("run-moved", "{}")
      yield* store.claim("run-moved", pending, ownerA, 0)
      const suspended: RunSnapshot = { status: "suspended", owner: null, heartbeatAtMs: null }
      expect(yield* store.activate("run-moved", ownerA, 0, suspended)).toEqual({ _tag: "SnapshotChanged" })

      yield* store.create("run-recover", "{}")
      yield* store.claim("run-recover", pending, ownerA, 0)
      yield* TestClock.adjust(staleMs + 1)
      const nowMs = staleMs + 1
      const evidence: LivenessEvidence = {
        expectedOwner: ownerA,
        checkedAtMs: nowMs,
        kind: "cross-host-unreachable-stale"
      }
      expect(yield* store.recoverClaim("run-recover", ownerA, 0, observer, nowMs, evidence)).toEqual({
        _tag: "Recovered"
      })

      expect(yield* facts("run-abandon")).toEqual([
        fact("run-abandon", "claimed", ownerA, 0),
        fact("run-abandon", "released", ownerA, 0)
      ])
      expect(yield* facts("run-moved")).toEqual([
        fact("run-moved", "claimed", ownerA, 0),
        fact("run-moved", "released", ownerA, 0)
      ])
      expect(yield* facts("run-recover")).toEqual([
        fact("run-recover", "claimed", ownerA, 0),
        fact("run-recover", "expired", ownerA, 0)
      ])
    })))

  it.effect("records nothing for a refused claim or a heartbeat", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-refused", "{}")
      yield* store.claim("run-refused", pending, ownerA, 0)
      expect(yield* store.claim("run-refused", pending, ownerB, 0)).toEqual({ _tag: "AlreadyClaimed" })
      expect(yield* store.heartbeat("run-refused", ownerB, 0)).toEqual({ _tag: "FenceLost" })
      expect(yield* facts("run-refused")).toEqual([fact("run-refused", "claimed", ownerA, 0)])
    })))

  it.effect("rolls a transition's fact back with the enclosing transaction", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const journal = yield* Journal
      yield* store.create("run-rollback", "{}")
      yield* store.claimAndOwn("run-rollback", pending, ownerA, 0)
      const exit = yield* Effect.exit(journal.transact(Effect.gen(function*() {
        expect(yield* store.transitionOwned("run-rollback", ownerA, "suspended")).toEqual({ _tag: "Transitioned" })
        return yield* Effect.fail("rejected after the transition")
      })))
      expect(exit._tag).toBe("Failure")
      expect((yield* facts("run-rollback")).map((entry) => entry.eventType)).toEqual([
        "flows.consensus.claimed",
        "flows.consensus.activated"
      ])
    })))

  it.effect("records nothing when the caller runs without a journal", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-unjournaled", "{}")
        expect(yield* store.claimAndOwn("run-unjournaled", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly count: number | string }>`SELECT COUNT(*) AS count FROM flows_journal_events`
        expect(Number(rows[0]!.count)).toBe(0)
      }).pipe(Effect.provide(RunStoreLive.layer.pipe(Layer.provideMerge(database))))
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())))

  it.effect("refuses to create a run under a reserved companion stream id", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const companion = JournalEvent.companionRunId("run-store", "run-x")
      const error = yield* Effect.flip(store.create(companion, "{}"))
      expect(error.code).toBe("invalid_run")
      expect(error.cause).toMatchObject({ field: "runId" })
    })))
})
