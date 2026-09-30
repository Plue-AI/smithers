/**
 * The ownership contract over the injected consensus strategy.
 *
 * One shared body — Bazel `GraphTester` style — runs the claim, activation,
 * steal, recovery, and release lifecycle against BOTH strategies: the
 * in-memory `Consensus.layerLocal` and the database-backed
 * `SqlConsensus.layer`. Each instantiation pins that the strategy's lease is
 * what the journal's fence and the store's heartbeat answer from, and that it
 * rolls back with the transaction that changed it.
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
import { Journal } from "@smthrs/journal/Journal"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Clock, Duration, Effect, Layer } from "effect"
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

/** Whether the shared strategy currently admits `owner`'s fenced writes on the run. */
const holds = (runId: string, owner: OwnerId) =>
  Effect.gen(function*() {
    const consensus = yield* Consensus.Consensus
    return yield* consensus.guard(runId, owner).pipe(
      Effect.as(true),
      Effect.catch((cause) => cause.code === "fence_lost" ? Effect.succeed(false) : Effect.fail(cause))
    )
  })

const suite = (name: string, strategy: Strategy) => {
  const run = withStack(strategy)

  describe(`ownership over ${name}`, () => {
    it.effect("grants the lease on activation and releases it on the owner's transition", () =>
      run(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-lifecycle", "{}")
        const nowMs = yield* Clock.currentTimeMillis
        expect(yield* store.claim("run-lifecycle", pending, ownerA, nowMs)).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })
        // A claim is not ownership: the fence admits nobody until activation.
        expect(yield* holds("run-lifecycle", ownerA)).toBe(false)
        expect(yield* store.activate("run-lifecycle", ownerA, nowMs, pending)).toEqual({ _tag: "Activated" })
        expect(yield* holds("run-lifecycle", ownerA)).toBe(true)
        expect(yield* holds("run-lifecycle", ownerB)).toBe(false)
        expect(yield* store.heartbeat("run-lifecycle", ownerA, nowMs + 5)).toEqual({ _tag: "Updated" })
        expect((yield* store.get("run-lifecycle")).heartbeatAtMs).toBe(nowMs + 5)

        expect(yield* store.transitionOwned("run-lifecycle", ownerA, "suspended")).toEqual({
          _tag: "Transitioned"
        })
        expect(yield* holds("run-lifecycle", ownerA)).toBe(false)
        // The released lease refuses further pulses.
        expect(yield* store.heartbeat("run-lifecycle", ownerA, nowMs + 6)).toEqual({ _tag: "FenceLost" })
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
        expect(yield* holds("run-reown", ownerA)).toBe(true)
        // The fresh generation renews; the fence holds for the same owner.
        expect(yield* store.heartbeat("run-reown", ownerA, nowMs + 1)).toEqual({ _tag: "Updated" })
      })))

    it.effect("moves the lease to the claimant on a steal and on claimAndOwn over a stale rival", () =>
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
        // The stolen claim is not yet ownership: the stale owner keeps its
        // fence until the claimant activates.
        expect(yield* holds("run-stolen", ownerA)).toBe(true)
        expect(yield* store.activate("run-stolen", ownerB, nowMs, stale)).toEqual({ _tag: "Activated" })
        expect(yield* holds("run-stolen", ownerA)).toBe(false)
        expect(yield* holds("run-stolen", ownerB)).toBe(true)
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
        expect(yield* holds("run-taken-whole", ownerA)).toBe(false)
        expect(yield* holds("run-taken-whole", ownerB)).toBe(true)
      })))

    it.effect("frees the lease claim when a claim is abandoned or recovered", () =>
      run(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-claims", "{}")
        const first = yield* store.claim("run-claims", pending, ownerA, 0)
        expect(first).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
        expect(yield* store.abandonClaim("run-claims", ownerA, 0)).toEqual({ _tag: "Abandoned" })

        const again = yield* store.claim("run-claims", pending, ownerA, 0)
        expect(again).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
        yield* TestClock.adjust(Duration.toMillis(heartbeatStaleAfter) + 1)
        const nowMs = yield* Clock.currentTimeMillis
        expect(
          yield* store.recoverClaim("run-claims", ownerA, 0, observer, nowMs, evidence(ownerA, observer, nowMs))
        ).toEqual({ _tag: "Recovered" })
        const row = yield* store.get("run-claims")
        expect(row.claim).toBeNull()
        // The recovered slot is free for the next claimant.
        expect(yield* store.claim("run-claims", pending, ownerB, nowMs)).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })
      })))
  })
}

suite("Consensus.layerLocal", Consensus.layerLocal)
suite("SqlConsensus.layer", SqlConsensus.layer)

describe("SqlConsensus leases share the ownership write's transaction", () => {
  const run = withStack(SqlConsensus.layer)

  it.effect("rolls an ownership transition back with the enclosing transaction", () =>
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
      expect(yield* holds("run-rollback", ownerA)).toBe(true)
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
})
