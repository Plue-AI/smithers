/**
 * The shared consensus conformance contract.
 *
 * Every strategy implements the same rules; none may weaken them. This
 * module states those rules once as executable cases and each strategy's test
 * file instantiates them, the way Bazel's Skyframe pins every evaluator
 * implementation against one `GraphTester` harness
 * (`reference/bazel/src/main/java/com/google/devtools/build/skyframe/`).
 *
 * The harness builds one `Consensus` per case over a migrated in-memory
 * database, with the journal fencing through that same instance, so the
 * fencing cases exercise the strategy exactly as `emitDurable`, `checkpoint`,
 * and `compact` do.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Clock, Duration, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { Consensus, heartbeatStaleAfter, type LivenessEvidence } from "../src/Consensus.ts"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-b", pid: 202, nonce: "owner-b" }
const ownerC: OwnerId = { hostId: "host-a", pid: 303, nonce: "owner-c" }

const evidence = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
): LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: expectedOwner.hostId === claimant.hostId ? "same-host-pid-dead" : "cross-host-unreachable-stale"
})

const input = (run: RunId, source: string, sourceSeq: number): Input =>
  new Input({
    runId: run,
    sourceId: source as SourceId,
    sourceSeq: sourceSeq as SourceSeq,
    eventType: "flows.engine.run-decision",
    payload: { decision: "created" }
  }, { disableChecks: true })

/**
 * Instantiates the conformance contract for one strategy.
 *
 * `strategyLayer` provides the strategy under test over the migrated test
 * database; the journal in every case fences through that same instance.
 */
export const conformance = (
  name: string,
  strategyLayer: Layer.Layer<Consensus, never, DurableWriter | SqlClient.SqlClient>
): void => {
  const stack = SqlJournal.layerWith({ capacity: 32, overflow: "reject" }).pipe(
    Layer.provideMerge(strategyLayer),
    Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
  )

  const withStack = <A, E>(
    body: Effect.Effect<A, E, Consensus | Journal | DurableWriter | SqlClient.SqlClient | Scope.Scope>
  ) => Effect.scoped(body.pipe(Effect.provide(stack), Effect.provide(TestClock.layer())))

  describe(`consensus conformance: ${name}`, () => {
    it.effect("grants one claim at a time and refuses the loser with already_claimed", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        const first = yield* consensus.claim("run-claim", ownerA, 0)
        expect(first).toEqual({ _tag: "Claimed", grantedAtMs: 0 })
        const second = yield* consensus.claim("run-claim", ownerB, 0)
        expect(second).toEqual({ _tag: "Rejected", reason: "already_claimed" })
      })))

    it.effect("refuses a claim while an owner holds the run with owner_held", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        yield* consensus.claim("run-held", ownerA, 0)
        yield* consensus.activate("run-held", ownerA, 0, 0)
        const refused = yield* consensus.claim("run-held", ownerB, 0)
        expect(refused).toEqual({ _tag: "Rejected", reason: "owner_held" })
      })))

    it.effect("activates only the exact grant — a different grant timestamp is Lost (R4)", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        yield* consensus.claim("run-generation", ownerA, 5)
        // A different generation of the same tuple cannot activate, and
        // neither can an owner that never claimed.
        expect(yield* consensus.activate("run-generation", ownerA, 6, 6)).toEqual({ _tag: "Lost" })
        expect(yield* consensus.activate("run-generation", ownerB, 5, 5)).toEqual({ _tag: "Lost" })
        expect(yield* consensus.activate("run-never-claimed", ownerA, 5, 5)).toEqual({ _tag: "Lost" })
        expect(yield* consensus.activate("run-generation", ownerA, 5, 5)).toEqual({ _tag: "Activated" })
        // The grant is spent: presenting it again is Lost, not a re-activation.
        expect(yield* consensus.activate("run-generation", ownerA, 5, 5)).toEqual({ _tag: "Lost" })
      })))

    it.effect("renews the owner's lease monotonically and loses everyone else's", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        yield* consensus.claim("run-heartbeat", ownerA, 0)
        yield* consensus.activate("run-heartbeat", ownerA, 0, 100)
        expect(yield* consensus.heartbeat("run-heartbeat", ownerA, 250)).toEqual({
          _tag: "Renewed",
          heartbeatAtMs: 250
        })
        // A late pulse never moves the lease backwards.
        expect(yield* consensus.heartbeat("run-heartbeat", ownerA, 150)).toEqual({
          _tag: "Renewed",
          heartbeatAtMs: 250
        })
        expect(yield* consensus.heartbeat("run-heartbeat", ownerB, 300)).toEqual({ _tag: "Lost" })
        expect(yield* consensus.heartbeat("run-unknown", ownerA, 300)).toEqual({ _tag: "Lost" })
        // A pending claim is not a lease: only an activated owner renews.
        yield* consensus.claim("run-claim-only", ownerA, 0)
        expect(yield* consensus.heartbeat("run-claim-only", ownerA, 1)).toEqual({ _tag: "Lost" })
      })))

    it.effect("reconfirms only an activated exact owner without a pending claim", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        expect(yield* consensus.reconfirm("reconfirm-missing", ownerA, 100)).toEqual({ _tag: "Lost" })
        yield* consensus.claim("reconfirm", ownerA, 0)
        expect(yield* consensus.reconfirm("reconfirm", ownerA, 100)).toEqual({ _tag: "Lost" })
        yield* consensus.activate("reconfirm", ownerA, 0, 0)
        expect(yield* consensus.reconfirm("reconfirm", ownerB, 100)).toEqual({ _tag: "Lost" })
        const nowMs = staleAfterMs + 1
        expect(yield* consensus.reconfirm("reconfirm", ownerA, nowMs)).toEqual({
          _tag: "Renewed",
          heartbeatAtMs: nowMs
        })
        expect(yield* consensus.reconfirm("reconfirm", ownerA, 1)).toEqual({ _tag: "Renewed", heartbeatAtMs: nowMs })
        yield* consensus.guard("reconfirm", ownerA)
        const stealAt = nowMs + staleAfterMs + 1
        expect((yield* consensus.steal("reconfirm", ownerB, stealAt, evidence(ownerA, ownerB, stealAt)))._tag).toBe(
          "Claimed"
        )
        // A steal has only installed its claim: the original owner still
        // occupies the row, but it can no longer reconfirm exclusivity.
        expect(yield* consensus.reconfirm("reconfirm", ownerA, stealAt)).toEqual({ _tag: "Lost" })
        expect(yield* consensus.activate("reconfirm", ownerB, stealAt, stealAt)).toEqual({ _tag: "Activated" })
        expect(yield* consensus.reconfirm("reconfirm", ownerA, stealAt + 1)).toEqual({ _tag: "Lost" })
        expect(yield* consensus.reconfirm("reconfirm", ownerB, stealAt + 1)).toEqual({
          _tag: "Renewed",
          heartbeatAtMs: stealAt + 1
        })
        yield* consensus.release("reconfirm", ownerB)
        expect(yield* consensus.reconfirm("reconfirm", ownerB, stealAt + 2)).toEqual({ _tag: "Lost" })
      })))

    it.effect("serializes reconfirm against a competing steal with exactly one winner", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        const nowMs = staleAfterMs + 1
        for (let index = 0; index < 12; index++) {
          const run = `reconfirm-race-${index}`
          yield* consensus.claim(run, ownerA, 0)
          yield* consensus.activate(run, ownerA, 0, 0)
          const renewal = consensus.reconfirm(run, ownerA, nowMs)
          const steal = consensus.steal(run, ownerB, nowMs, evidence(ownerA, ownerB, nowMs))
          const outcomes = yield* Effect.all(index % 2 === 0 ? [renewal, steal] : [steal, renewal], {
            concurrency: "unbounded"
          })
          const reconfirmed = outcomes[index % 2 === 0 ? 0 : 1]
          const stolen = outcomes[index % 2 === 0 ? 1 : 0]
          expect([reconfirmed._tag, stolen._tag]).toEqual(
            reconfirmed._tag === "Renewed" ? ["Renewed", "Rejected"] : ["Lost", "Claimed"]
          )
          if (reconfirmed._tag === "Renewed") {
            expect(stolen).toEqual({ _tag: "Rejected", reason: "owner_live" })
            yield* consensus.guard(run, ownerA)
            expect(yield* consensus.activate(run, ownerB, nowMs, nowMs)).toEqual({ _tag: "Lost" })
          } else {
            expect(yield* consensus.activate(run, ownerB, nowMs, nowMs)).toEqual({ _tag: "Activated" })
            expect((yield* Effect.flip(consensus.guard(run, ownerA))).code).toBe("fence_lost")
          }
        }
      })))

    it.effect("release clears the caller's claim or ownership and nobody else's", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        yield* consensus.claim("run-release", ownerA, 0)
        // A stranger's release changes nothing.
        yield* consensus.release("run-release", ownerB)
        expect(yield* consensus.activate("run-release", ownerA, 0, 0)).toEqual({ _tag: "Activated" })
        // A stranger's release of the owner's lease changes nothing either.
        yield* consensus.release("run-release", ownerB)
        expect(yield* consensus.heartbeat("run-release", ownerA, 1)).toEqual({ _tag: "Renewed", heartbeatAtMs: 1 })
        yield* consensus.release("run-release", ownerA)
        expect(yield* consensus.heartbeat("run-release", ownerA, 2)).toEqual({ _tag: "Lost" })
        // Releasing a run that was never claimed is a no-op.
        yield* consensus.release("run-never-claimed", ownerA)
        // A pending claim is released without ever activating.
        yield* consensus.claim("run-release-claim", ownerA, 0)
        yield* consensus.release("run-release-claim", ownerA)
        expect(yield* consensus.claim("run-release-claim", ownerB, 0)).toEqual({
          _tag: "Claimed",
          grantedAtMs: 0
        })
      })))

    it.effect("steals only a stale owner's run, and only with matching evidence (R5)", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        yield* consensus.claim("run-steal", ownerA, 0)
        yield* consensus.activate("run-steal", ownerA, 0, 0)

        // Live owner: refused regardless of evidence.
        const live = yield* consensus.steal("run-steal", ownerB, 1, evidence(ownerA, ownerB, 1))
        expect(live).toEqual({ _tag: "Rejected", reason: "owner_live" })

        const nowMs = staleAfterMs + 1
        // Stale, but the evidence is malformed: wrong expected owner, a stale
        // clock reading, or the wrong host relation for its kind.
        expect(yield* consensus.steal("run-steal", ownerB, nowMs, evidence(ownerB, ownerB, nowMs))).toEqual({
          _tag: "Rejected",
          reason: "evidence_invalid"
        })
        expect(yield* consensus.steal("run-steal", ownerB, nowMs, evidence(ownerA, ownerB, nowMs - 1))).toEqual({
          _tag: "Rejected",
          reason: "evidence_invalid"
        })
        expect(
          yield* consensus.steal("run-steal", ownerB, nowMs, {
            expectedOwner: ownerA,
            checkedAtMs: nowMs,
            kind: "same-host-pid-dead"
          })
        ).toEqual({ _tag: "Rejected", reason: "evidence_invalid" })
        expect(
          yield* consensus.steal("run-steal", ownerC, nowMs, {
            expectedOwner: ownerA,
            checkedAtMs: nowMs,
            kind: "cross-host-unreachable-stale"
          })
        ).toEqual({ _tag: "Rejected", reason: "evidence_invalid" })
        // A run nobody owns has no owner the evidence could disprove, and
        // neither does a run somebody else owns.
        expect(yield* consensus.steal("run-unowned", ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
          _tag: "Rejected",
          reason: "evidence_invalid"
        })
        yield* consensus.claim("run-other-owner", ownerC, 0)
        yield* consensus.activate("run-other-owner", ownerC, 0, 0)
        expect(yield* consensus.steal("run-other-owner", ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
          _tag: "Rejected",
          reason: "evidence_invalid"
        })

        // Stale plus valid evidence: the steal takes the claim, and a rival
        // steal then loses on the pending claim. The lease alone is evidence
        // too, from any host.
        expect(yield* consensus.steal("run-steal", ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
          _tag: "Claimed",
          grantedAtMs: nowMs
        })
        expect(yield* consensus.steal("run-steal", ownerC, nowMs, evidence(ownerA, ownerC, nowMs))).toEqual({
          _tag: "Rejected",
          reason: "already_claimed"
        })
        expect(yield* consensus.activate("run-steal", ownerB, nowMs, nowMs)).toEqual({ _tag: "Activated" })
        expect(
          yield* consensus.steal("run-other-owner", ownerB, nowMs, {
            expectedOwner: ownerC,
            checkedAtMs: nowMs,
            kind: "lease-expired"
          })
        ).toEqual({ _tag: "Claimed", grantedAtMs: nowMs })
      })))

    it.effect("recovers only the exact stale claim of a proven-dead claimant", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        yield* consensus.claim("run-recover", ownerA, 0)
        const nowMs = staleAfterMs + 1

        expect(
          yield* consensus.recover("run-recover", ownerA, 0, ownerC, nowMs, evidence(ownerA, ownerC, nowMs - 1))
        ).toEqual({ _tag: "Rejected", reason: "evidence_invalid" })
        expect(
          yield* consensus.recover("run-recover", ownerB, 0, ownerC, nowMs, evidence(ownerB, ownerC, nowMs))
        ).toEqual({ _tag: "Rejected", reason: "claim_changed" })
        expect(
          yield* consensus.recover("run-recover", ownerA, 1, ownerC, nowMs, evidence(ownerA, ownerC, nowMs))
        ).toEqual({ _tag: "Rejected", reason: "claim_changed" })
        expect(
          yield* consensus.recover("run-never-claimed", ownerA, 0, ownerC, nowMs, evidence(ownerA, ownerC, nowMs))
        ).toEqual({ _tag: "Rejected", reason: "claim_changed" })
        expect(
          yield* consensus.recover(
            "run-recover",
            ownerA,
            0,
            ownerC,
            staleAfterMs,
            evidence(ownerA, ownerC, staleAfterMs)
          )
        ).toEqual({ _tag: "Rejected", reason: "claim_fresh" })
        expect(
          yield* consensus.recover("run-recover", ownerA, 0, ownerC, nowMs, evidence(ownerA, ownerC, nowMs))
        ).toEqual({ _tag: "Recovered" })
        // The slot is free again.
        expect(yield* consensus.claim("run-recover", ownerB, nowMs)).toEqual({
          _tag: "Claimed",
          grantedAtMs: nowMs
        })
      })))

    it.effect("guards fenced journal writes: appends, checkpoints, and compactions (R3)", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        const journal = yield* Journal
        const run = "run-fence" as RunId
        yield* consensus.claim(run, ownerA, 0)
        yield* consensus.activate(run, ownerA, 0, 0)

        for (let sequence = 0; sequence < 4; sequence++) {
          expect((yield* journal.emitDurable(input(run, "driver", sequence), ownerA))._tag).toBe("Accepted")
        }
        const checkpointed = yield* journal.checkpoint({ runId: run, seq: 3 as Seq, state: { cursor: 3 } }, ownerA)
        expect(checkpointed.seq).toBe(3)

        // The fence moves: staleness passes on the TestClock and a successor
        // steals and activates through the strategy.
        yield* TestClock.adjust(heartbeatStaleAfter)
        yield* TestClock.adjust(Duration.millis(1))
        const nowMs = yield* Clock.currentTimeMillis
        expect(yield* consensus.steal(run, ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
          _tag: "Claimed",
          grantedAtMs: nowMs
        })
        expect(yield* consensus.activate(run, ownerB, nowMs, nowMs)).toEqual({ _tag: "Activated" })

        // R3: nothing fenced by the displaced owner commits after the loss.
        const append = yield* Effect.flip(journal.emitDurable(input(run, "driver", 9), ownerA))
        expect(append.code).toBe("fence_lost")
        const checkpoint = yield* Effect.flip(
          journal.checkpoint({ runId: run, seq: 3 as Seq, state: { zombie: true } }, ownerA)
        )
        expect(checkpoint.code).toBe("fence_lost")
        const compact = yield* Effect.flip(journal.compact({ runId: run }, ownerA))
        expect(compact.code).toBe("fence_lost")

        // The successor's fenced writes are admitted.
        expect((yield* journal.emitDurable(input(run, "successor", 0), ownerB))._tag).toBe("Accepted")
        const compacted = yield* journal.compact({ runId: run }, ownerB)
        expect(compacted.checkpointSeq).toBe(3)
      })))

    it.effect("fails a fenced append admitted under a fence that is lost before commit (R3)", () =>
      withStack(Effect.gen(function*() {
        const consensus = yield* Consensus
        const journal = yield* Journal
        const run = "run-commit-fence" as RunId
        yield* consensus.claim(run, ownerA, 0)
        yield* consensus.activate(run, ownerA, 0, 0)

        // The append and the fence loss race inside one `transact`: the steal
        // is arbitrated by the same serialized strategy, so whichever order
        // the transaction observes, an append fenced by the displaced owner
        // must not commit after the loss.
        const nowMs = staleAfterMs + 1
        const outcome = yield* journal.transact(Effect.gen(function*() {
          expect(yield* consensus.steal(run, ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
            _tag: "Claimed",
            grantedAtMs: nowMs
          })
          expect(yield* consensus.activate(run, ownerB, nowMs, nowMs)).toEqual({ _tag: "Activated" })
          return yield* Effect.flip(journal.emitDurable(input(run, "driver", 0), ownerA))
        }))
        expect(outcome.code).toBe("fence_lost")
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries).toHaveLength(0)
      })))
  })
}
