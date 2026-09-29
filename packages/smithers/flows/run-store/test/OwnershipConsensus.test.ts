/**
 * The ownership contract over the injected consensus strategy.
 *
 * One shared body — Bazel `GraphTester` style — runs the claim, activation,
 * steal, recovery, and release lifecycle against BOTH strategies: the
 * in-memory `Consensus.layerLocal` and the database-backed
 * `SqlConsensus.layer`. Each instantiation also pins rule R6: ownership
 * transitions append `flows.consensus.*` events through the journal in
 * context, roll back with the transaction that made them, and heartbeats
 * never do.
 *
 * A second section pins the delegation seam itself: the strategy is
 * authoritative, so when its lease disagrees with the run-row materialization
 * — driven here by operating the strategy directly — the store reports the
 * loss and reconverges the row.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Consensus from "@smthrs/journal/Consensus"
import { Journal, JournalError } from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { heartbeatStaleAfter } from "../src/Heartbeat.ts"
import * as Migrations from "../src/Migrations.ts"
import type { LivenessEvidence, OwnerId } from "../src/Ownership.ts"
import { type RunSnapshot, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-b", pid: 202, nonce: "owner-b" }
const observer: OwnerId = { hostId: "host-a", pid: 303, nonce: "observer" }

const pending: RunSnapshot = { status: "pending", owner: null, heartbeatAtMs: null }

const evidence = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
): LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: expectedOwner.hostId === claimant.hostId ? "same-host-pid-dead" : "cross-host-unreachable-stale"
})

type Strategy = Layer.Layer<Consensus.Consensus, never, DurableWriter.DurableWriter | SqlClient.SqlClient>

/** One strategy instance shared by the journal's fence and the store's arbitration. */
const stackFor = (strategy: Strategy) =>
  Layer.mergeAll(RunStoreLive.layerWith, SqlJournal.layerWith({ capacity: 64, overflow: "reject" })).pipe(
    Layer.provideMerge(strategy),
    Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
  )

type Services = Consensus.Consensus | Journal | RunStore | DurableWriter.DurableWriter | SqlClient.SqlClient

const withStack = (strategy: Strategy) => <A, E>(body: Effect.Effect<A, E, Services>) =>
  Effect.scoped(body.pipe(Effect.provide(stackFor(strategy)), Effect.provide(TestClock.layer())))

const consensusEntries = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 50 })
    return page.entries.filter((entry) => entry.eventType.startsWith("flows.consensus."))
  })

const consensusEvents = (runId: string) =>
  Effect.map(
    consensusEntries(runId),
    (entries) => entries.map((entry) => entry.eventType.replace("flows.consensus.", ""))
  )

const suite = (name: string, strategy: Strategy) => {
  const run = withStack(strategy)

  describe(`ownership over ${name}`, () => {
    it.effect("appends claimed and activated events for the two-phase lifecycle, and none for heartbeats", () =>
      run(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-lifecycle", "{}")
        const nowMs = yield* Clock.currentTimeMillis
        expect(yield* store.claim("run-lifecycle", pending, ownerA, nowMs)).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })
        expect(yield* store.activate("run-lifecycle", ownerA, nowMs, pending)).toEqual({ _tag: "Activated" })
        expect(yield* store.heartbeat("run-lifecycle", ownerA, nowMs + 5)).toEqual({ _tag: "Updated" })
        expect(yield* consensusEvents("run-lifecycle")).toEqual(["claimed", "activated"])

        expect(yield* store.transitionOwned("run-lifecycle", ownerA, "suspended")).toEqual({
          _tag: "Transitioned"
        })
        expect(yield* consensusEvents("run-lifecycle")).toEqual(["claimed", "activated", "released"])
        // The released lease refuses further pulses.
        expect(yield* store.heartbeat("run-lifecycle", ownerA, nowMs + 6)).toEqual({ _tag: "FenceLost" })

        // Every transition names its actor and the grant it concerns; the
        // run-level event carries no node lineage, which the journal's
        // readers keep as evidence of the run.
        const entries = yield* consensusEntries("run-lifecycle")
        expect(entries.map((entry) => entry.payload)).toEqual([
          { owner: ownerA, grantedAtMs: nowMs },
          { owner: ownerA, grantedAtMs: nowMs },
          { owner: ownerA, grantedAtMs: null }
        ])
        expect(entries.map((entry) => entry.meta)).toEqual([null, null, null])
        expect(new Set(entries.map((entry) => entry.sourceId))).toEqual(new Set(["flows/run-store/consensus"]))
      })))

    it.effect("re-owns one's own stale run through release, re-claim, and activation", () =>
      run(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-reown", "{}")
        expect(yield* store.claimAndOwn("run-reown", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const nowMs = yield* Clock.currentTimeMillis
        const stale: RunSnapshot = { status: "running", owner: ownerA, heartbeatAtMs: 0 }
        expect(yield* store.claimAndOwn("run-reown", stale, ownerA, nowMs)).toEqual({ _tag: "Activated" })
        const row = yield* store.get("run-reown")
        expect(row.owner).toEqual(ownerA)
        expect(row.heartbeatAtMs).toBe(nowMs)
        expect(yield* consensusEvents("run-reown")).toEqual(["claimed", "activated", "claimed", "activated"])
        // The fresh generation renews; the fence holds for the same owner.
        expect(yield* store.heartbeat("run-reown", ownerA, nowMs + 1)).toEqual({ _tag: "Updated" })
      })))

    it.effect("records a steal as stolen, and claimAndOwn over a stale rival as stolen plus activated", () =>
      run(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-stolen", "{}")
        expect(yield* store.claimAndOwn("run-stolen", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const nowMs = yield* Clock.currentTimeMillis
        const stale: RunSnapshot = { status: "running", owner: ownerA, heartbeatAtMs: 0 }
        expect(yield* store.steal("run-stolen", stale, ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })
        expect(yield* consensusEvents("run-stolen")).toEqual(["claimed", "activated", "stolen"])
        expect(yield* store.activate("run-stolen", ownerB, nowMs, stale)).toEqual({ _tag: "Activated" })
        expect(yield* consensusEvents("run-stolen")).toEqual(["claimed", "activated", "stolen", "activated"])
        // The displaced owner's fence is gone; the successor's holds.
        expect(yield* store.heartbeat("run-stolen", ownerA, nowMs + 1)).toEqual({ _tag: "FenceLost" })
        expect(yield* store.heartbeat("run-stolen", ownerB, nowMs + 1)).toEqual({ _tag: "Updated" })

        yield* store.create("run-taken-whole", "{}")
        expect(yield* store.claimAndOwn("run-taken-whole", pending, ownerA, nowMs)).toEqual({ _tag: "Activated" })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const laterMs = yield* Clock.currentTimeMillis
        const staleAgain: RunSnapshot = { status: "running", owner: ownerA, heartbeatAtMs: nowMs }
        expect(
          yield* store.claimAndOwn("run-taken-whole", staleAgain, ownerB, laterMs, evidence(ownerA, ownerB, laterMs))
        ).toEqual({ _tag: "Activated" })
        expect(yield* consensusEvents("run-taken-whole")).toEqual(["claimed", "activated", "stolen", "activated"])
      })))

    it.effect("records an abandoned claim as released and a recovered claim as expired", () =>
      run(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-claims", "{}")
        const first = yield* store.claim("run-claims", pending, ownerA, 0)
        expect(first).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
        expect(yield* store.abandonClaim("run-claims", ownerA, 0)).toEqual({ _tag: "Abandoned" })
        expect(yield* consensusEvents("run-claims")).toEqual(["claimed", "released"])

        const again = yield* store.claim("run-claims", pending, ownerA, 0)
        expect(again).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const nowMs = yield* Clock.currentTimeMillis
        expect(
          yield* store.recoverClaim("run-claims", ownerA, 0, observer, nowMs, evidence(ownerA, observer, nowMs))
        ).toEqual({ _tag: "Recovered" })
        expect(yield* consensusEvents("run-claims")).toEqual(["claimed", "released", "claimed", "expired"])
        const row = yield* store.get("run-claims")
        expect(row.claim).toBeNull()
        // The recovered slot is free for the next claimant.
        expect(yield* store.claim("run-claims", pending, ownerB, nowMs)).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })
      })))

    it.effect("records nothing when the caller masks the journal out of its context", () =>
      run(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-silent", "{}")
        const silently = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.updateContext(effect, (context: Context.Context<Journal>) => Context.omit(Journal)(context))
        expect(yield* silently(store.claimAndOwn("run-silent", pending, ownerA, 0))).toEqual({ _tag: "Activated" })
        expect(yield* silently(store.transitionOwned("run-silent", ownerA, "suspended"))).toEqual({
          _tag: "Transitioned"
        })
        expect(yield* consensusEvents("run-silent")).toEqual([])
        // The fence itself was still arbitrated: the released lease refuses.
        expect(yield* store.heartbeat("run-silent", ownerA, 1)).toEqual({ _tag: "FenceLost" })
      })))
  })
}

suite("Consensus.layerLocal", Consensus.layerLocal)
suite("SqlConsensus.layer", SqlConsensus.layer)

describe("SqlConsensus leases share the ownership write's transaction", () => {
  const run = withStack(SqlConsensus.layer)

  it.effect("rolls an ownership transition and its event back with the enclosing transaction", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const journal = yield* Journal
      yield* store.create("run-rollback", "{}")
      expect(yield* store.claimAndOwn("run-rollback", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      const exit = yield* Effect.exit(journal.transact(Effect.gen(function*() {
        expect(yield* store.transitionOwned("run-rollback", ownerA, "suspended")).toEqual({ _tag: "Transitioned" })
        return yield* Effect.fail("rejected after the transition")
      })))
      expect(exit._tag).toBe("Failure")
      expect((yield* store.get("run-rollback")).status).toBe("running")
      expect(yield* consensusEvents("run-rollback")).toEqual(["claimed", "activated"])
      // The lease rolled back with the row: the owner still holds the run.
      expect(yield* store.heartbeat("run-rollback", ownerA, 1)).toEqual({ _tag: "Updated" })
    })))

})

describe("the strategy is authoritative when the materialization disagrees", () => {
  const run = withStack(Consensus.layerLocal)

  it.effect("claim and claimAndOwn report the row-classified loss when the lease refuses the grant", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-lease-claimed", "{}")
      // The lease is taken behind the store's back, so the row still admits
      // the claim the strategy refuses.
      expect((yield* consensus.claim("run-lease-claimed", ownerB, 0))._tag).toBe("Claimed")
      expect(yield* store.claim("run-lease-claimed", pending, ownerA, 0)).toEqual({ _tag: "SnapshotChanged" })
      expect(yield* store.claimAndOwn("run-lease-claimed", pending, ownerA, 0)).toEqual({
        _tag: "SnapshotChanged"
      })
      expect(yield* consensusEvents("run-lease-claimed")).toEqual([])
    })))

  it.effect("claimAndOwn releases its fresh grant when the strategy revokes the activation", () =>
    Effect.gen(function*() {
      const revoked = Layer.effect(
        Consensus.Consensus,
        Effect.map(Consensus.makeLocal, (local) =>
          Consensus.make({
            ...local,
            activate: () => Effect.succeed({ _tag: "Lost" })
          }))
      )
      const outcome = yield* withStack(revoked)(Effect.gen(function*() {
        const store = yield* RunStore
        const consensus = yield* Consensus.Consensus
        yield* store.create("run-revoked", "{}")
        const result = yield* store.claimAndOwn("run-revoked", pending, ownerA, 0)
        // The compensating release freed the lease for the next claimant.
        expect((yield* consensus.claim("run-revoked", ownerB, 1))._tag).toBe("Claimed")
        expect(yield* consensusEvents("run-revoked")).toEqual([])
        return result
      }))
      expect(outcome).toEqual({ _tag: "SnapshotChanged" })
    }))

  it.effect("activate reports ClaimLost and clears the stale claim columns when the lease moved on", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-lease-lost", "{}")
      expect(yield* store.claim("run-lease-lost", pending, ownerA, 0)).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
      yield* consensus.release("run-lease-lost", ownerA)
      expect(yield* store.activate("run-lease-lost", ownerA, 0, pending)).toEqual({ _tag: "ClaimLost" })
      const row = yield* store.get("run-lease-lost")
      expect(row.claim).toBeNull()
      expect(yield* consensusEvents("run-lease-lost")).toEqual(["claimed"])
    })))

  it.effect("activate against a moved snapshot clears both the row claim and the lease claim", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-moved", "{}")
      expect(yield* store.claim("run-moved", pending, ownerA, 0)).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
      const moved: RunSnapshot = { status: "suspended", owner: null, heartbeatAtMs: null }
      expect(yield* store.activate("run-moved", ownerA, 0, moved)).toEqual({ _tag: "SnapshotChanged" })
      expect((yield* store.get("run-moved")).claim).toBeNull()
      expect((yield* consensus.claim("run-moved", ownerB, 1))._tag).toBe("Claimed")
    })))

  it.effect("steal reports the row-classified loss when the lease still records a live owner", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-live-lease", "{}")
      expect(yield* store.claimAndOwn("run-live-lease", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
      const nowMs = yield* Clock.currentTimeMillis
      // The lease renews behind the store's back, so the row looks stale
      // while the strategy still records a live owner.
      expect((yield* consensus.heartbeat("run-live-lease", ownerA, nowMs))._tag).toBe("Renewed")
      const stale: RunSnapshot = { status: "running", owner: ownerA, heartbeatAtMs: 0 }
      expect(yield* store.steal("run-live-lease", stale, ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
        _tag: "SnapshotChanged"
      })
      expect(
        yield* store.claimAndOwn("run-live-lease", stale, ownerB, nowMs, evidence(ownerA, ownerB, nowMs))
      ).toEqual({ _tag: "SnapshotChanged" })
    })))

  it.effect("recoverClaim reports ClaimChanged when the lease's claim moved on", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const consensus = yield* Consensus.Consensus
      yield* store.create("run-claim-gone", "{}")
      expect(yield* store.claim("run-claim-gone", pending, ownerA, 0)).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
      yield* consensus.release("run-claim-gone", ownerA)
      yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
      const nowMs = yield* Clock.currentTimeMillis
      expect(
        yield* store.recoverClaim("run-claim-gone", ownerA, 0, observer, nowMs, evidence(ownerA, observer, nowMs))
      ).toEqual({ _tag: "ClaimChanged" })
    })))

  it.effect("transitionOwned reports FenceLost when the row claims an owner the lease does not", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-row-only', 'running', 0, ${ownerA.hostId}, ${ownerA.pid}, ${ownerA.nonce}, 0, '{}')
      `
      expect(yield* store.transitionOwned("run-row-only", ownerA, "completed")).toEqual({ _tag: "FenceLost" })
      expect((yield* store.get("run-row-only")).status).toBe("running")
    })))

  it.effect("heartbeat reports FenceLost when the lease renews but the row no longer records the owner", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("run-mirror-lost", "{}")
      expect(yield* store.claimAndOwn("run-mirror-lost", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      // The row moves on behind the mirror, so the lease still renews while
      // the verified UPDATE matches nothing. A success here would report a
      // liveness stamp that was never written.
      yield* sql`
        UPDATE flows_runs
        SET status = 'suspended', owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL
        WHERE run_id = 'run-mirror-lost'
      `
      expect(yield* store.heartbeat("run-mirror-lost", ownerA, 1)).toEqual({ _tag: "FenceLost" })
    })))

  it.effect("heartbeat reports NotFound when the lease renews but the run row is gone", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("run-mirror-gone", "{}")
      expect(yield* store.claimAndOwn("run-mirror-gone", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      yield* sql`DELETE FROM flows_runs WHERE run_id = 'run-mirror-gone'`
      expect(yield* store.heartbeat("run-mirror-gone", ownerA, 1)).toEqual({ _tag: "NotFound" })
    })))
})

describe("a failing strategy is a persistence failure, never a silent grant", () => {
  const run = withStack(SqlConsensus.layer)

  it.effect("claim and transitionOwned surface the strategy's storage failure", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("run-broken-lease", "{}")
      yield* store.create("run-broken-claim", "{}")
      expect(yield* store.claimAndOwn("run-broken-lease", pending, ownerA, 0)).toEqual({ _tag: "Activated" })
      yield* sql`DROP TABLE flows_consensus_leases`
      const claimFailure = yield* Effect.flip(store.claim("run-broken-claim", pending, ownerB, 1))
      expect(claimFailure.code).toBe("persistence_failed")
      const transitionFailure = yield* Effect.flip(store.transitionOwned("run-broken-lease", ownerA, "completed"))
      expect(transitionFailure.code).toBe("persistence_failed")
      // Nothing was recorded for the refused transition, and the run row
      // still shows the owner the failed transition could not release.
      expect((yield* store.get("run-broken-lease")).status).toBe("running")
    })))

  it.effect("a closed journal fails the transition it could not record", () =>
    run(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-closed-journal", "{}")
      const closed = Journal.of({
        ...(yield* Journal),
        emitDurableUnfenced: () => Effect.fail(new JournalError({ code: "journal_closed", message: "journal is closed" }))
      })
      const failure = yield* Effect.flip(
        store.claimAndOwn("run-closed-journal", pending, ownerA, 0).pipe(Effect.provideService(Journal, closed))
      )
      expect(failure.code).toBe("persistence_failed")
      expect((yield* store.get("run-closed-journal")).status).toBe("pending")
      // The rolled-back transaction released the grant with it.
      expect(yield* store.claimAndOwn("run-closed-journal", pending, ownerB, 1)).toEqual({ _tag: "Activated" })
    })))
})
