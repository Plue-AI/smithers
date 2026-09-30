import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import {
  heartbeatInterval,
  heartbeatLoop,
  heartbeatSkewAllowance,
  heartbeatStaleAfter,
  heartbeatWriteTolerance,
  type LivenessEvidence,
  type OwnerId
} from "../src/Ownership.ts"
import { type HeartbeatOutcome, type RunRow, type RunSnapshot, type RunStatus, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => effect

const migrated = <A, E>(effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>) =>
  run(
    effect.pipe(
      Effect.provide(RunStoreLive.layer),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer),
      Effect.provide(TestClock.layer())
    )
  )

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-a", pid: 202, nonce: "owner-b" }
const ownerC: OwnerId = { hostId: "host-b", pid: 303, nonce: "owner-c" }
const expected: RunSnapshot = { status: "pending", owner: null, heartbeatAtMs: null }

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const activateNew = (store: RunStoreLive.Service, runId: string, owner: OwnerId) =>
  Effect.gen(function*() {
    yield* store.create(runId, "{}")
    const pending = yield* store.get(runId)
    const expected = snapshot(pending)
    const claimedAtMs = yield* Clock.currentTimeMillis
    expect(yield* store.claim(runId, expected, owner, claimedAtMs)).toEqual({ _tag: "Claimed", claimedAtMs })
    expect(yield* store.activate(runId, owner, claimedAtMs, expected)).toEqual({ _tag: "Activated" })
    return yield* store.get(runId)
  })

const staleEvidence = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
): LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: expectedOwner.hostId === claimant.hostId
    ? "same-host-pid-dead"
    : "cross-host-unreachable-stale"
})

describe("store-owned timestamps", () => {
  it.effect("persists integer milliseconds when a retry wakes at a fractional clock instant", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* TestClock.adjust("10.5 millis")
      yield* store.create("fractional-clock", "{}")
      const row = yield* store.get("fractional-clock")
      expect(row.createdAtMs).toBe(10)
      expect(yield* store.claim("fractional-clock", snapshot(row), ownerA, 10)).toEqual({
        _tag: "Claimed",
        claimedAtMs: 10
      })
      expect(yield* store.activate("fractional-clock", ownerA, 10, snapshot(row))).toEqual({ _tag: "Activated" })
      expect((yield* store.get("fractional-clock")).startedAtMs).toBe(10)
      yield* TestClock.adjust("1 millis")
      yield* store.transitionOwned("fractional-clock", ownerA, "completed", "{}")
      expect((yield* store.get("fractional-clock")).finishedAtMs).toBe(11)
    })))
})

describe("RunStore well-formed durable text", () => {
  it.effect("rejects lone high and low surrogate run identifiers", () =>
    Effect.gen(function*() {
      const failures = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        return yield* Effect.forEach(
          ["run-\uD800", "run-\uDC00"],
          (runId) => Effect.flip(store.create(runId, "{}"))
        )
      }))

      expect(failures).toEqual([
        expect.objectContaining({ code: "invalid_run", method: "create" }),
        expect.objectContaining({ code: "invalid_run", method: "create" })
      ])
    }))

  it.effect("rejects lone surrogates in parent, lineage, and executable state", () =>
    Effect.gen(function*() {
      const failures = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("parent", "{}")
        return yield* Effect.all([
          Effect.flip(store.create("bad-parent", "{}", { parentRunId: "parent-\uD800" })),
          Effect.flip(store.create("bad-lineage", "{}", { lineageId: "lineage-\uDC00", roundOrdinal: 1 })),
          Effect.flip(store.create("bad-state", `{"value":"\uD800"}`))
        ])
      }))

      expect(failures).toEqual([
        expect.objectContaining({ code: "invalid_run", method: "create" }),
        expect.objectContaining({ code: "invalid_run", method: "create" }),
        expect.objectContaining({ code: "invalid_run", method: "create" })
      ])
    }))

  it.effect("accepts U+FFFD as a well-formed identifier", () =>
    Effect.gen(function*() {
      const row = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-�", "{}")
        return yield* store.get("run-�")
      }))

      expect(row.runId).toBe("run-�")
    }))

  it.effect("round-trips a valid astral identifier byte-identically", () =>
    Effect.gen(function*() {
      const runId = "run-\u{1F600}"
      const row = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create(runId, "{}")
        return yield* store.get(runId)
      }))

      expect(row.runId).toBe(runId)
    }))

  it.effect("rejects lone surrogates in transitionOwned executable state", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-bad-transition-state", ownerA)
        const failure = yield* Effect.flip(
          store.transitionOwned(running.runId, ownerA, "running", `{"value":"\uD800"}`)
        )
        return { failure, row: yield* store.get(running.runId) }
      }))

      expect(result.failure).toMatchObject({ code: "invalid_run", method: "transitionOwned" })
      expect(result.row.stateJson).toBe("{}")
    }))
})

describe("RunStore", () => {
  it.effect("round-trips a newly created run", () =>
    Effect.gen(function*() {
      const row = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-round-trip", "{\"cursor\":1}")
        return yield* store.get("run-round-trip")
      }))

      expect(row).toEqual({
        runId: "run-round-trip",
        status: "pending",
        createdAtMs: 0,
        startedAtMs: null,
        finishedAtMs: null,
        owner: null,
        heartbeatAtMs: null,
        claim: null,
        claimedAtMs: null,
        parentRunId: null,
        cancelRequestedAtMs: null,
        lineageId: null,
        roundOrdinal: null,
        stateJson: "{\"cursor\":1}"
      })
    }))

  it.effect("returns typed errors for invalid, duplicate, missing, and corrupt runs", () =>
    Effect.gen(function*() {
      const codes = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* RunStore
        const empty = yield* Effect.flip(store.create("", "{}"))
        const invalidJson = yield* Effect.flip(store.create("invalid-json", "not-json"))
        yield* store.create("duplicate", "{}")
        const duplicate = yield* Effect.flip(store.create("duplicate", "{}"))
        const missing = yield* Effect.flip(store.get("missing"))

        yield* TestDatabase.checks(sql, false)
        yield* store.create("corrupt-schema", "{}")
        yield* sql`UPDATE flows_runs SET created_at_ms = -1 WHERE run_id = 'corrupt-schema'`
        const corruptSchema = yield* Effect.flip(store.get("corrupt-schema"))

        yield* store.create("corrupt-owner", "{}")
        yield* sql`
        UPDATE flows_runs
        SET owner_host_id = 'host', owner_pid = 1, owner_nonce = NULL
        WHERE run_id = 'corrupt-owner'
      `
        const corruptOwner = yield* Effect.flip(store.get("corrupt-owner"))

        yield* store.create("corrupt-heartbeat", "{}")
        yield* sql`
        UPDATE flows_runs SET heartbeat_at_ms = 1 WHERE run_id = 'corrupt-heartbeat'
      `
        const corruptHeartbeat = yield* Effect.flip(store.get("corrupt-heartbeat"))

        yield* store.create("corrupt-running-owner", "{}")
        yield* sql`
        UPDATE flows_runs
        SET status = 'running', heartbeat_at_ms = 1
        WHERE run_id = 'corrupt-running-owner'
      `
        const corruptRunningOwner = yield* Effect.flip(store.get("corrupt-running-owner"))

        yield* store.create("corrupt-claim", "{}")
        yield* sql`
        UPDATE flows_runs SET claim_host_id = 'host' WHERE run_id = 'corrupt-claim'
      `
        const corruptClaim = yield* Effect.flip(store.get("corrupt-claim"))

        yield* store.create("corrupt-claim-time", "{}")
        yield* sql`
        UPDATE flows_runs SET claimed_at_ms = 1 WHERE run_id = 'corrupt-claim-time'
      `
        const corruptClaimTime = yield* Effect.flip(store.get("corrupt-claim-time"))

        yield* store.create("corrupt-complete-claim", "{}")
        yield* sql`
        UPDATE flows_runs
        SET claim_host_id = 'host', claim_pid = 1, claim_nonce = 'nonce'
        WHERE run_id = 'corrupt-complete-claim'
      `
        const corruptCompleteClaim = yield* Effect.flip(store.get("corrupt-complete-claim"))

        yield* store.create("corrupt-json", "{}")
        yield* sql`
        UPDATE flows_runs SET state_json = 'not-json' WHERE run_id = 'corrupt-json'
      `
        const corruptJson = yield* Effect.flip(store.get("corrupt-json"))
        yield* TestDatabase.checks(sql, true)
        yield* sql`DROP TABLE flows_runs ${sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))}`
        const persistence = yield* Effect.flip(store.create("missing-table", "{}"))
        const readPersistence = yield* Effect.flip(store.get("missing-table"))

        return [
          empty,
          invalidJson,
          duplicate,
          missing,
          corruptSchema,
          corruptOwner,
          corruptHeartbeat,
          corruptRunningOwner,
          corruptClaim,
          corruptClaimTime,
          corruptCompleteClaim,
          corruptJson,
          persistence,
          readPersistence
        ].map((failure) => failure.code)
      }))

      expect(codes).toEqual([
        "invalid_run",
        "invalid_run",
        "constraint",
        "not_found_row",
        "decode_failed",
        "decode_failed",
        "decode_failed",
        "decode_failed",
        "decode_failed",
        "decode_failed",
        "decode_failed",
        "decode_failed",
        "persistence_failed",
        "persistence_failed"
      ])
    }))

  it.effect("allows exactly one of two concurrent claimants to claim one snapshot", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-concurrent", "{}")
        const expected = snapshot(yield* store.get("run-concurrent"))
        const nowMs = yield* Clock.currentTimeMillis
        return yield* Effect.all(
          [
            store.claim("run-concurrent", expected, ownerA, nowMs),
            store.claim("run-concurrent", expected, ownerB, nowMs)
          ],
          { concurrency: "unbounded" }
        )
      }))

      expect(outcomes.filter((outcome) => outcome._tag === "Claimed")).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome._tag !== "Claimed")).toHaveLength(1)
      expect(["AlreadyClaimed", "SnapshotChanged"]).toContain(
        outcomes.find((outcome) => outcome._tag !== "Claimed")?._tag
      )
    }))

  it.effect("claims and transfers stale ownership observably in one statement", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* activateNew(store, "run-claim-and-own-transfer", ownerA)
        yield* TestClock.adjust(Duration.seconds(31))
        const stale = yield* store.get("run-claim-and-own-transfer")
        const nowMs = yield* Clock.currentTimeMillis
        const outcome = yield* store.claimAndOwn(
          stale.runId,
          snapshot(stale),
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
        const oldOwnerHeartbeat = yield* store.heartbeat(stale.runId, ownerA, nowMs + 1)
        return { oldOwnerHeartbeat, outcome, row: yield* store.get(stale.runId) }
      }))

      expect(result.outcome).toEqual({ _tag: "Activated" })
      expect(result.row).toMatchObject({
        status: "running",
        owner: ownerB,
        heartbeatAtMs: 31_000,
        claim: null,
        claimedAtMs: null
      })
      expect(result.oldOwnerHeartbeat).toEqual({ _tag: "FenceLost" })
    }))

  it.effect("installs an owner different from the process claiming by proxy", () =>
    Effect.gen(function*() {
      const engineOwner: OwnerId = { hostId: "engine-host", pid: 404, nonce: "engine-to-spawn" }
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-proxy-claim", "{}")
        const pending = yield* store.get("run-proxy-claim")
        const outcome = yield* store.claimAndOwn(
          pending.runId,
          snapshot(pending),
          engineOwner,
          yield* Clock.currentTimeMillis
        )
        return { outcome, row: yield* store.get(pending.runId) }
      }))

      expect(engineOwner).not.toEqual(ownerA)
      expect(result.outcome).toEqual({ _tag: "Activated" })
      expect(result.row.owner).toEqual(engineOwner)
      expect(result.row.status).toBe("running")
      expect(result.row.heartbeatAtMs).toBe(0)
    }))

  it.effect("allows exactly one of two concurrent claim-and-own calls to win", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-concurrent-claim-and-own", "{}")
        const pending = yield* store.get("run-concurrent-claim-and-own")
        const expected = snapshot(pending)
        const nowMs = yield* Clock.currentTimeMillis
        const outcomes = yield* Effect.all(
          [
            store.claimAndOwn(pending.runId, expected, ownerA, nowMs),
            store.claimAndOwn(pending.runId, expected, ownerB, nowMs)
          ],
          { concurrency: "unbounded" }
        )
        return { outcomes, row: yield* store.get(pending.runId) }
      }))

      expect(result.outcomes.filter((outcome) => outcome._tag === "Activated")).toHaveLength(1)
      expect(result.outcomes.filter((outcome) => outcome._tag !== "Activated")).toHaveLength(1)
      expect(["HeartbeatFresh", "SnapshotChanged"]).toContain(
        result.outcomes.find((outcome) => outcome._tag !== "Activated")?._tag
      )
      expect([ownerA, ownerB]).toContainEqual(result.row.owner)
    }))

  it.effect("names the fresh lease, not the missing evidence, when a live owner holds the run", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-fresh-claim-and-own", ownerA)
        const outcome = yield* store.claimAndOwn(
          running.runId,
          snapshot(running),
          ownerB,
          yield* Clock.currentTimeMillis
        )
        return { outcome, row: yield* store.get(running.runId) }
      }))

      // Evidence cannot beat a fresh heartbeat, so `EvidenceRequired` would
      // advise the caller to supply evidence for a write SQL must still refuse.
      expect(result.outcome).toEqual({ _tag: "HeartbeatFresh" })
      expect(result.row.owner).toEqual(ownerA)
      expect(result.row.heartbeatAtMs).toBe(0)
    }))

  it.effect("reports a distinguishable refusal when no liveness evidence was supplied (B12)", () =>
    Effect.gen(function*() {
      // The recovery-sweeper case: a run whose owner died, so the heartbeat is
      // stale and the run is genuinely recoverable, claimed without evidence.
      // The refusal used to come back as `SnapshotChanged`, which asserts the
      // caller's snapshot was wrong. It was not — the sweeper re-read, got the
      // identical snapshot, and called again, livelocking on a recoverable run
      // with no outcome value naming the real reason.
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-no-evidence", ownerA)
        const expectedSnapshot = snapshot(running)
        yield* TestClock.adjust(Duration.seconds(31))
        const nowMs = yield* Clock.currentTimeMillis
        // The caller clock is past the cutoff, so the identical stale snapshot
        // isolates the missing evidence rather than a fresh lease.
        const outcome = yield* store.claimAndOwn(
          running.runId,
          expectedSnapshot,
          ownerB,
          nowMs
        )
        // A second call sees the identical snapshot: retrying cannot help, which
        // is exactly what the outcome now says.
        const again = yield* store.claimAndOwn(
          running.runId,
          expectedSnapshot,
          ownerB,
          nowMs
        )
        return { outcome, again, row: yield* store.get(running.runId) }
      }))

      expect(result.outcome).toEqual({ _tag: "EvidenceRequired" })
      expect(result.again).toEqual({ _tag: "EvidenceRequired" })
      // Nothing was taken: the run still belongs to the dead owner.
      expect(result.row.owner).toEqual(ownerA)
      expect(result.row.status).toBe("running")
    }))

  it.effect("rejects incomplete ownership pairs in expected snapshots without changing the row", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("run-invalid-owner-pairs", "{}")
      const before = yield* store.get("run-invalid-owner-pairs")
      const candidates: ReadonlyArray<RunSnapshot> = [
        { status: "running", owner: ownerA, heartbeatAtMs: null },
        { status: "running", owner: null, heartbeatAtMs: 0 },
        { status: "pending", owner: null, heartbeatAtMs: 0 },
        { status: "suspended", owner: ownerA, heartbeatAtMs: 0 }
      ]
      for (const expected of candidates) {
        const error = yield* Effect.flip(store.claimAndOwn(before.runId, expected, ownerB, 0))
        expect(error.code).toBe("invalid_run")
        expect(error.cause).toEqual({ field: "expected", detail: "violates ownership invariants" })
        expect(yield* store.get(before.runId)).toEqual(before)
      }
    })))

  it.effect("compares every stale ownership field before requesting liveness evidence", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const running = yield* activateNew(store, "run-no-evidence-fields", ownerA)
      yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatStaleAfter) + 1))
      const nowMs = yield* Clock.currentTimeMillis
      const unchanged = snapshot(running)
      const variants: ReadonlyArray<RunSnapshot> = [
        { ...unchanged, owner: { ...ownerA, hostId: "other-host" } },
        { ...unchanged, owner: { ...ownerA, pid: ownerA.pid + 1 } },
        { ...unchanged, owner: { ...ownerA, nonce: "other-nonce" } },
        { ...unchanged, heartbeatAtMs: 1 }
      ]
      for (const expected of variants) {
        expect(yield* store.claimAndOwn(running.runId, expected, ownerB, nowMs))
          .toEqual({ _tag: "SnapshotChanged" })
        expect(yield* store.get(running.runId)).toEqual(running)
      }
      expect(yield* store.claimAndOwn(running.runId, unchanged, ownerB, nowMs))
        .toEqual({ _tag: "EvidenceRequired" })
      expect(yield* store.get(running.runId)).toEqual(running)
    })))

  it.effect("reports SnapshotChanged when a no-evidence claim-and-own snapshot was suspended", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-no-evidence-suspended", ownerA)
        const expectedSnapshot = snapshot(running)
        expect(
          yield* store.transitionOwned(running.runId, ownerA, "suspended")
        ).toEqual({ _tag: "Transitioned" })
        yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatStaleAfter) + 1))
        const staleNowMs = yield* Clock.currentTimeMillis
        const stale = yield* store.claimAndOwn(
          running.runId,
          expectedSnapshot,
          ownerB,
          staleNowMs
        )
        const freshSnapshot = snapshot(yield* store.get(running.runId))
        const fresh = yield* store.claimAndOwn(
          running.runId,
          freshSnapshot,
          ownerB,
          staleNowMs
        )
        return { fresh, row: yield* store.get(running.runId), stale }
      }))

      expect(result.stale).toEqual({ _tag: "SnapshotChanged" })
      expect(result.fresh).toEqual({ _tag: "Activated" })
      expect(result.row).toMatchObject({ status: "running", owner: ownerB })
    }))

  it.effect("reports SnapshotChanged when a no-evidence claim-and-own snapshot completed", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-no-evidence-completed", ownerA)
        const expectedSnapshot = snapshot(running)
        expect(
          yield* store.transitionOwned(running.runId, ownerA, "completed")
        ).toEqual({ _tag: "Transitioned" })
        yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatStaleAfter) + 1))
        const outcome = yield* store.claimAndOwn(
          running.runId,
          expectedSnapshot,
          ownerB,
          yield* Clock.currentTimeMillis
        )
        return { outcome, row: yield* store.get(running.runId) }
      }))

      expect(result.outcome).toEqual({ _tag: "SnapshotChanged" })
      expect(result.row).toMatchObject({ status: "completed", owner: null })
    }))

  it.effect("refuses claim-and-own when the expected snapshot has changed", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-stale-claim-and-own-snapshot", "{}")
        const staleExpected = snapshot(yield* store.get("run-stale-claim-and-own-snapshot"))
        expect(
          yield* store.claim("run-stale-claim-and-own-snapshot", staleExpected, ownerA, 0)
        ).toEqual({ _tag: "Claimed", claimedAtMs: 0 })
        expect(
          yield* store.activate("run-stale-claim-and-own-snapshot", ownerA, 0, staleExpected)
        ).toEqual({ _tag: "Activated" })
        expect(
          yield* store.transitionOwned("run-stale-claim-and-own-snapshot", ownerA, "suspended")
        ).toEqual({ _tag: "Transitioned" })
        const outcome = yield* store.claimAndOwn(
          "run-stale-claim-and-own-snapshot",
          staleExpected,
          ownerB,
          yield* Clock.currentTimeMillis
        )
        return { outcome, row: yield* store.get("run-stale-claim-and-own-snapshot") }
      }))

      expect(result.outcome).toEqual({ _tag: "SnapshotChanged" })
      expect(result.row.status).toBe("suspended")
      expect(result.row.owner).toBeNull()
    }))

  it.effect("reports the fresh lease when an ordinary claim meets a running run", () =>
    Effect.gen(function*() {
      const outcome = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-fresh-claim", ownerA)
        return yield* store.claim(
          running.runId,
          snapshot(running),
          ownerB,
          yield* Clock.currentTimeMillis
        )
      }))

      expect(outcome).toEqual({ _tag: "HeartbeatFresh" })
    }))

  it.effect("rejects an ordinary claim on a running run even once its heartbeat is stale (D4)", () =>
    Effect.gen(function*() {
      // The invariant that makes `claim`'s staleness disjunction dead: `claim`
      // admits only 'pending' and 'suspended', so a running run is refused
      // whatever its heartbeat says. The neighbouring cell covers the fresh
      // heartbeat; this one covers past the cutoff, where the deleted
      // `(status <> 'running' OR heartbeat < cutoff)` branch would have been the
      // only thing standing between the caller and the row.
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-stale-ordinary-claim", ownerA)
        yield* TestClock.adjust(Duration.seconds(31))
        const outcome = yield* store.claim(
          running.runId,
          snapshot(running),
          ownerB,
          yield* Clock.currentTimeMillis
        )
        return { outcome, row: yield* store.get(running.runId) }
      }))

      expect(result.outcome).toEqual({ _tag: "SnapshotChanged" })
      // Nothing was claimed: the claim columns are still empty.
      expect(result.row.claim).toBeNull()
      expect(result.row.owner).toEqual(ownerA)
    }))

  it.effect("classifies missing and already-held claims", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const missing = yield* store.claim("missing", expected, ownerA, 0)
        yield* store.create("claimed", "{}")
        const pending = snapshot(yield* store.get("claimed"))
        yield* store.claim("claimed", pending, ownerA, 0)
        const alreadyClaimed = yield* store.claim("claimed", pending, ownerB, 0)
        return { missing, alreadyClaimed }
      }))

      expect(outcomes).toEqual({
        missing: { _tag: "NotFound" },
        alreadyClaimed: { _tag: "AlreadyClaimed" }
      })
    }))

  it.effect("recovers an exact stale claim only after liveness evidence confirms its claimant is dead", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("stale-claim", "{}")
        const pending = snapshot(yield* store.get("stale-claim"))
        expect(yield* store.claim("stale-claim", pending, ownerA, 0)).toEqual({
          _tag: "Claimed",
          claimedAtMs: 0
        })

        const fresh = yield* store.recoverClaim(
          "stale-claim",
          ownerA,
          0,
          ownerB,
          0,
          staleEvidence(ownerA, ownerB, 0)
        )
        yield* TestClock.adjust(Duration.seconds(31))
        const nowMs = yield* Clock.currentTimeMillis
        const stillBlocked = yield* store.claim("stale-claim", pending, ownerB, nowMs)
        const unconfirmed = yield* store.recoverClaim(
          "stale-claim",
          ownerA,
          0,
          ownerB,
          nowMs,
          staleEvidence(ownerC, ownerB, nowMs)
        )
        const recovered = yield* store.recoverClaim(
          "stale-claim",
          ownerA,
          0,
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
        const changed = yield* store.recoverClaim(
          "stale-claim",
          ownerA,
          0,
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
        const reclaimed = yield* store.claim("stale-claim", pending, ownerB, nowMs)
        const missing = yield* store.recoverClaim(
          "missing",
          ownerA,
          0,
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
        return { fresh, stillBlocked, unconfirmed, recovered, changed, reclaimed, missing }
      }))

      expect(outcomes).toEqual({
        fresh: { _tag: "ClaimFresh" },
        stillBlocked: { _tag: "AlreadyClaimed" },
        unconfirmed: { _tag: "LivenessUnconfirmed" },
        recovered: { _tag: "Recovered" },
        changed: { _tag: "ClaimChanged" },
        reclaimed: { _tag: "Claimed", claimedAtMs: 31_000 },
        missing: { _tag: "NotFound" }
      })
    }))

  it.effect("fences delayed activation and abandonment when a claimant identity is reused", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("reused-claimant", "{}")
        const pending = snapshot(yield* store.get("reused-claimant"))
        expect(yield* store.claim("reused-claimant", pending, ownerA, 0)).toEqual({
          _tag: "Claimed",
          claimedAtMs: 0
        })

        yield* TestClock.adjust(Duration.seconds(31))
        const nowMs = yield* Clock.currentTimeMillis
        expect(
          yield* store.recoverClaim(
            "reused-claimant",
            ownerA,
            0,
            ownerB,
            nowMs,
            staleEvidence(ownerA, ownerB, nowMs)
          )
        ).toEqual({ _tag: "Recovered" })
        expect(yield* store.claim("reused-claimant", pending, ownerA, nowMs)).toEqual({
          _tag: "Claimed",
          claimedAtMs: nowMs
        })

        const delayedActivation = yield* store.activate("reused-claimant", ownerA, 0, pending)
        const delayedAbandonment = yield* store.abandonClaim("reused-claimant", ownerA, 0)
        const stillClaimed = yield* store.get("reused-claimant")
        const currentActivation = yield* store.activate("reused-claimant", ownerA, nowMs, pending)
        return { currentActivation, delayedAbandonment, delayedActivation, stillClaimed }
      }))

      expect(result.delayedActivation).toEqual({ _tag: "ClaimLost" })
      expect(result.delayedAbandonment).toEqual({ _tag: "ClaimLost" })
      expect(result.stillClaimed.claim).toEqual(ownerA)
      expect(result.stillClaimed.claimedAtMs).toBe(31_000)
      expect(result.currentActivation).toEqual({ _tag: "Activated" })
    }))

  it.effect("requires both stale SQL state and matching liveness evidence to steal", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const fresh = yield* activateNew(store, "run-steal", ownerA)
        const freshNow = yield* Clock.currentTimeMillis
        const notStale = yield* store.steal(
          fresh.runId,
          snapshot(fresh),
          ownerC,
          freshNow,
          staleEvidence(ownerA, ownerC, freshNow)
        )

        yield* TestClock.adjust(Duration.seconds(31))
        const stale = yield* store.get(fresh.runId)
        const staleNow = yield* Clock.currentTimeMillis
        const bypass = yield* store.claim(
          stale.runId,
          snapshot(stale),
          ownerC,
          staleNow
        )
        const wrongEvidence = yield* store.steal(
          stale.runId,
          snapshot(stale),
          ownerC,
          staleNow,
          staleEvidence(ownerB, ownerC, staleNow)
        )
        const stolen = yield* store.steal(
          stale.runId,
          snapshot(stale),
          ownerC,
          staleNow,
          staleEvidence(ownerA, ownerC, staleNow)
        )
        return { notStale, bypass, wrongEvidence, stolen }
      }))

      expect(outcomes.notStale).toEqual({ _tag: "HeartbeatFresh" })
      expect(outcomes.bypass).toEqual({ _tag: "SnapshotChanged" })
      expect(outcomes.wrongEvidence).toEqual({ _tag: "LivenessUnconfirmed" })
      expect(outcomes.stolen).toEqual({ _tag: "Claimed", claimedAtMs: 31_000 })
    }))

  it.effect("reports SnapshotChanged when matching steal evidence loses to a changed row", () =>
    Effect.gen(function*() {
      const outcome = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-steal-changed-snapshot", ownerA)
        const expectedSnapshot = snapshot(running)
        yield* TestClock.adjust(Duration.seconds(31))
        expect(
          yield* store.heartbeat(running.runId, ownerA, yield* Clock.currentTimeMillis)
        ).toEqual({ _tag: "Updated" })
        yield* TestClock.adjust(Duration.seconds(31))
        const nowMs = yield* Clock.currentTimeMillis
        return yield* store.steal(
          running.runId,
          expectedSnapshot,
          ownerC,
          nowMs,
          staleEvidence(ownerA, ownerC, nowMs)
        )
      }))

      expect(outcome).toEqual({ _tag: "SnapshotChanged" })
    }))

  it.effect("invalidates activation when the old owner heartbeats after the claim", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* activateNew(store, "run-activation-race", ownerA)
        yield* TestClock.adjust(Duration.seconds(31))
        const stale = yield* store.get("run-activation-race")
        const nowMs = yield* Clock.currentTimeMillis
        expect(
          yield* store.steal(
            stale.runId,
            snapshot(stale),
            ownerB,
            nowMs,
            staleEvidence(ownerA, ownerB, nowMs)
          )
        ).toEqual({ _tag: "Claimed", claimedAtMs: nowMs })

        expect(yield* store.heartbeat(stale.runId, ownerA, nowMs)).toEqual({ _tag: "Updated" })
        const activation = yield* store.activate(stale.runId, ownerB, nowMs, snapshot(stale))
        return { activation, row: yield* store.get(stale.runId) }
      }))

      expect(result.activation).toEqual({ _tag: "SnapshotChanged" })
      expect(result.row.owner).toEqual(ownerA)
      expect(result.row.heartbeatAtMs).toBe(31_000)
      expect(result.row.claim).toBeNull()
      expect(result.row.claimedAtMs).toBeNull()
    }))

  it.effect("abandons only the claim and preserves the previous owner", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* activateNew(store, "run-abandon", ownerA)
        yield* TestClock.adjust(Duration.seconds(31))
        const stale = yield* store.get("run-abandon")
        const nowMs = yield* Clock.currentTimeMillis
        expect(
          yield* store.steal(
            stale.runId,
            snapshot(stale),
            ownerB,
            nowMs,
            staleEvidence(ownerA, ownerB, nowMs)
          )
        ).toEqual({ _tag: "Claimed", claimedAtMs: nowMs })
        const outcome = yield* store.abandonClaim(stale.runId, ownerB, nowMs)
        return { outcome, row: yield* store.get(stale.runId) }
      }))

      expect(result.outcome).toEqual({ _tag: "Abandoned" })
      expect(result.row.owner).toEqual(ownerA)
      expect(result.row.heartbeatAtMs).toBe(0)
      expect(result.row.claim).toBeNull()
      expect(result.row.claimedAtMs).toBeNull()
    }))

  it.effect("reports claim losses for activation and abandonment", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const activateMissing = yield* store.activate("missing", ownerA, 0, expected)
        const abandonMissing = yield* store.abandonClaim("missing", ownerA, 0)
        yield* store.create("claimed", "{}")
        const pending = snapshot(yield* store.get("claimed"))
        yield* store.claim("claimed", pending, ownerA, 0)
        const activateWrongOwner = yield* store.activate("claimed", ownerB, 0, pending)
        const abandonWrongOwner = yield* store.abandonClaim("claimed", ownerB, 0)
        return { activateMissing, abandonMissing, activateWrongOwner, abandonWrongOwner }
      }))

      expect(outcomes).toEqual({
        activateMissing: { _tag: "ClaimLost" },
        abandonMissing: { _tag: "ClaimLost" },
        activateWrongOwner: { _tag: "ClaimLost" },
        abandonWrongOwner: { _tag: "ClaimLost" }
      })
    }))

  it.effect("fences the old owner's heartbeat after an activated steal", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* activateNew(store, "run-heartbeat-fence", ownerA)
        yield* TestClock.adjust(Duration.seconds(31))
        const stale = yield* store.get("run-heartbeat-fence")
        const nowMs = yield* Clock.currentTimeMillis
        expect(
          yield* store.steal(
            stale.runId,
            snapshot(stale),
            ownerB,
            nowMs,
            staleEvidence(ownerA, ownerB, nowMs)
          )
        ).toEqual({ _tag: "Claimed", claimedAtMs: nowMs })
        expect(yield* store.activate(stale.runId, ownerB, nowMs, snapshot(stale))).toEqual({ _tag: "Activated" })
        return yield* store.heartbeat(stale.runId, ownerA, nowMs + 1)
      }))

      expect(result).toEqual({ _tag: "FenceLost" })
    }))

  it.effect("reports missing heartbeat and transition targets and stale owners", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const heartbeatMissing = yield* store.heartbeat("missing", ownerA, 0)
        const transitionMissing = yield* store.transitionOwned("missing", ownerA, "failed")
        const running = yield* activateNew(store, "running-transition", ownerA)
        const keptRunning = yield* store.transitionOwned(running.runId, ownerA, "running", "{\"cursor\":1}")
        const keptState = yield* store.transitionOwned(running.runId, ownerA, "running")
        const stale = yield* store.transitionOwned(running.runId, ownerB, "failed")
        const row = yield* store.get(running.runId)
        return { heartbeatMissing, transitionMissing, keptRunning, keptState, stale, row }
      }))

      expect(outcomes.heartbeatMissing).toEqual({ _tag: "NotFound" })
      expect(outcomes.transitionMissing).toEqual({ _tag: "NotFound" })
      expect(outcomes.keptRunning).toEqual({ _tag: "Transitioned" })
      expect(outcomes.keptState).toEqual({ _tag: "Transitioned" })
      expect(outcomes.stale).toEqual({ _tag: "FenceLost" })
      expect(outcomes.row.stateJson).toBe("{\"cursor\":1}")
    }))

  it.effect("rejects invalid owned transitions", () =>
    Effect.gen(function*() {
      const failures = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        return yield* Effect.all([
          Effect.flip(store.transitionOwned("run", ownerA, "unknown" as RunStatus)),
          Effect.flip(store.transitionOwned("run", ownerA, "failed", "not-json"))
        ])
      }))

      expect(failures.map((failure) => failure.code)).toEqual(["invalid_run", "invalid_run"])
    }))

  it.effect("pulses every second and interrupts its owner when the fence is lost", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.scoped(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-heartbeat-loop", ownerA)
        const started = yield* Deferred.make<void>()
        // The pulse's write is real database I/O, so no count of scheduler
        // turns can prove it finished. Record each pulse synchronously as it is
        // issued, which pins the one-second cadence, and expose its completion
        // so the test waits on the write itself.
        const pulses: Array<{ readonly atMs: number; readonly done: Deferred.Deferred<HeartbeatOutcome> }> = []
        const observedStore = {
          ...store,
          heartbeat: (runId: string, owner: OwnerId, atMs: number) =>
            Effect.suspend(() => {
              const done = Deferred.makeUnsafe<HeartbeatOutcome>()
              pulses.push({ atMs, done })
              return store.heartbeat(runId, owner, atMs).pipe(
                Effect.tap((outcome) => Deferred.succeed(done, outcome))
              )
            })
        }
        const owningFiber = yield* Effect.scoped(
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.raceFirst(Effect.never, heartbeatLoop(running.runId, ownerA))
          })
        ).pipe(
          Effect.provideService(RunStore, observedStore),
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(started)
        yield* TestClock.adjust(heartbeatInterval)
        yield* Effect.yieldNow
        expect(pulses.map((pulse) => pulse.atMs)).toEqual([1_000])
        expect(yield* Deferred.await(pulses[0]!.done)).toEqual({ _tag: "Updated" })
        const pulsed = yield* store.get(running.runId)
        expect(pulsed.heartbeatAtMs).toBe(1_000)

        expect(yield* store.transitionOwned(running.runId, ownerA, "suspended")).toEqual({
          _tag: "Transitioned"
        })
        yield* TestClock.adjust(heartbeatInterval)
        yield* Effect.yieldNow
        expect(pulses.map((pulse) => pulse.atMs)).toEqual([1_000, 2_000])
        expect(yield* Deferred.await(pulses[1]!.done)).toEqual({ _tag: "FenceLost" })
        return yield* Fiber.await(owningFiber)
      })))

      expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
    }))

  const heartbeatFailure = new RunStoreLive.RunStoreError({
    code: "persistence_failed",
    method: "heartbeat",
    message: "persistence_failed: heartbeat failed",
    cause: new Error("database unavailable")
  })

  /** A heartbeat store whose writes fail exactly while `broken.value` is set. */
  const flakyHeartbeatStore = (broken: { value: boolean }) =>
    RunStoreLive.layerNoop({
      heartbeat: (_runId: string, _owner: OwnerId, atMs: number) =>
        broken.value
          ? Effect.fail(heartbeatFailure)
          : Effect.succeed({ _tag: "Updated" as const, heartbeatAtMs: atMs })
    })

  it.effect("keeps pulsing through transient heartbeat failures until the fence goes stale", () =>
    Effect.gen(function*() {
      const broken = { value: true }
      const result = yield* run(
        Effect.scoped(Effect.gen(function*() {
          const started = yield* Deferred.make<void>()
          const owningFiber = yield* Effect.scoped(
            Effect.gen(function*() {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.raceFirst(Effect.never, heartbeatLoop("run-heartbeat-error", ownerA))
            })
          ).pipe(Effect.forkChild({ startImmediately: true }))

          yield* Deferred.await(started)
          // Consecutive write failures inside the staleness window must not
          // interrupt the owned work: no other process may legally steal the run
          // while the persisted heartbeat is still fresh.
          yield* TestClock.adjust(Duration.seconds(5))
          yield* Effect.yieldNow
          const survived = owningFiber.pollUnsafe()
          // The window then closes and the loop hands the fence back.
          yield* TestClock.adjust(heartbeatStaleAfter)
          yield* Effect.yieldNow
          const exit = yield* Fiber.await(owningFiber)
          return { exit, survived }
        })).pipe(
          Effect.provide(flakyHeartbeatStore(broken)),
          Effect.provide(TestClock.layer())
        )
      )

      expect(result.survived).toBe(undefined)
      expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
    }))

  it.effect("hands the fence back before the persisted heartbeat becomes stealable", () =>
    Effect.gen(function*() {
      const broken = { value: true }
      const result = yield* run(
        Effect.scoped(Effect.gen(function*() {
          const started = yield* Deferred.make<void>()
          const owningFiber = yield* Effect.scoped(
            Effect.gen(function*() {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.raceFirst(Effect.never, heartbeatLoop("run-heartbeat-window", ownerA))
            })
          ).pipe(Effect.forkChild({ startImmediately: true }))

          yield* Deferred.await(started)
          // The tolerance budget is a real budget: the owner keeps working while
          // no peer could possibly steal.
          yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatWriteTolerance) - 1))
          yield* Effect.yieldNow
          const survivedInsideBudget = owningFiber.pollUnsafe()
          // A peer judges staleness by the *persisted* heartbeat, so the owner
          // must already be interrupted by the time that timestamp crosses
          // `heartbeatStaleAfter` — otherwise both execute the same action.
          yield* TestClock.adjust(
            Duration.millis(
              Duration.toMillis(heartbeatStaleAfter) - Duration.toMillis(heartbeatWriteTolerance)
            )
          )
          yield* Effect.yieldNow
          return { exit: owningFiber.pollUnsafe(), survivedInsideBudget }
        })).pipe(
          Effect.provide(flakyHeartbeatStore(broken)),
          Effect.provide(TestClock.layer())
        )
      )

      expect(result.survivedInsideBudget).toBe(undefined)
      expect(Duration.toMillis(heartbeatWriteTolerance)).toBeLessThan(Duration.toMillis(heartbeatStaleAfter))
      expect(
        result.exit !== undefined && Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)
      ).toBe(true)
    }))

  it.effect("re-arms the tolerance window whenever a heartbeat write succeeds", () =>
    Effect.gen(function*() {
      const broken = { value: true }
      const alive = yield* run(
        Effect.scoped(Effect.gen(function*() {
          const started = yield* Deferred.make<void>()
          const owningFiber = yield* Effect.scoped(
            Effect.gen(function*() {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.raceFirst(Effect.never, heartbeatLoop("run-heartbeat-flap", ownerA))
            })
          ).pipe(Effect.forkChild({ startImmediately: true }))

          yield* Deferred.await(started)
          // Flap: fail for most of a window, recover for one pulse, then fail
          // again. Recovery is strictly before expiry; a pulse at the boundary
          // cannot renew. The successful pulse re-arms the fence, so the second outage
          // gets a full window of its own and the loop is still alive after a
          // total outage far longer than `heartbeatStaleAfter`.
          yield* TestClock.adjust(
            Duration.millis(Duration.toMillis(heartbeatWriteTolerance) - 2 * Duration.toMillis(heartbeatInterval))
          )
          broken.value = false
          yield* TestClock.adjust(heartbeatInterval)
          yield* Effect.yieldNow
          broken.value = true
          yield* TestClock.adjust(
            Duration.millis(Duration.toMillis(heartbeatWriteTolerance) - Duration.toMillis(heartbeatInterval))
          )
          yield* Effect.yieldNow
          expect(yield* Clock.currentTimeMillis).toBeGreaterThan(Duration.toMillis(heartbeatStaleAfter))
          return owningFiber.pollUnsafe()
        })).pipe(
          Effect.provide(flakyHeartbeatStore(broken)),
          Effect.provide(TestClock.layer())
        )
      )

      expect(alive).toBe(undefined)
    }))

  it.effect("interrupts on the exact heartbeatWriteTolerance expiry tick", () =>
    Effect.gen(function*() {
      // The existing cells assert the constant's ordering, the tolerance window
      // minus one millisecond, and a flapping outage. None drives the boundary
      // millisecond itself, which is the tick a fencing budget is judged on: the
      // owner must be interrupted AT the budget, not one pulse after it, or it
      // overlaps a peer that is already entitled to steal.
      const broken = { value: true }
      const result = yield* run(
        Effect.scoped(Effect.gen(function*() {
          const started = yield* Deferred.make<void>()
          const owningFiber = yield* Effect.scoped(
            Effect.gen(function*() {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.raceFirst(Effect.never, heartbeatLoop("run-heartbeat-exact", ownerA))
            })
          ).pipe(Effect.forkChild({ startImmediately: true }))

          yield* Deferred.await(started)
          // One millisecond inside the budget.
          yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatWriteTolerance) - 1))
          yield* Effect.yieldNow
          const beforeExpiry = owningFiber.pollUnsafe()
          // The boundary millisecond itself: the budget is spent, and the loop
          // interrupts on this tick rather than one pulse later.
          yield* TestClock.adjust(Duration.millis(1))
          yield* Effect.yieldNow
          return { beforeExpiry, atExpiry: owningFiber.pollUnsafe() }
        })).pipe(
          Effect.provide(flakyHeartbeatStore(broken)),
          Effect.provide(TestClock.layer())
        )
      )

      expect(result.beforeExpiry).toBe(undefined)
      expect(
        result.atExpiry !== undefined &&
          Exit.isFailure(result.atExpiry) &&
          Cause.hasInterruptsOnly(result.atExpiry.cause)
      ).toBe(true)
    }))

  it.effect("interrupts the owner at the write tolerance and admits a peer steal only once the persisted heartbeat is stale", () =>
    Effect.gen(function*() {
      // The whole point of the skew allowance is the ordering of two *observable*
      // events against one persisted heartbeat: the owner must have handed the
      // fence back strictly before any peer can legally take it. This drives the
      // real steal SQL, so it also pins the steal cutoff against
      // `heartbeatStaleAfter` rather than restating the constant's definition.
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const activated = yield* activateNew(store, "run-steal-boundary", ownerA)
        expect(activated.heartbeatAtMs).toBe(0)

        const broken = { value: true }
        const started = yield* Deferred.make<void>()
        const owningFiber = yield* Effect.scoped(
          Effect.gen(function*() {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.raceFirst(Effect.never, heartbeatLoop(activated.runId, ownerA))
          })
        ).pipe(
          // Every heartbeat write fails, so the persisted timestamp stays at 0
          // while the owner's tolerance budget burns down.
          Effect.provide(flakyHeartbeatStore(broken)),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(started)

        const stealAt = (atMs: number) =>
          Effect.gen(function*() {
            const row = yield* store.get(activated.runId)
            return yield* store.steal(row.runId, snapshot(row), ownerC, atMs, staleEvidence(ownerA, ownerC, atMs))
          })

        yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatWriteTolerance) - 1))
        yield* Effect.yieldNow
        const ownerInsideBudget = owningFiber.pollUnsafe()
        const peerInsideBudget = yield* stealAt(yield* Clock.currentTimeMillis)
        // Same instant, but judged by a peer whose clock runs five seconds ahead
        // of the owner's — the cross-host offset the allowance exists to absorb.
        // The magnitude is chosen independently of the constants on purpose.
        const aheadPeerInsideBudget = yield* stealAt((yield* Clock.currentTimeMillis) + 5_000)

        yield* TestClock.adjust(Duration.millis(1))
        yield* Effect.yieldNow
        const ownerAtTolerance = owningFiber.pollUnsafe()

        // The owner is already gone, yet the run is still not stealable: the
        // remaining skew allowance plus a pulse is exactly the margin a peer
        // whose clock runs ahead is allowed to consume.
        yield* TestClock.adjust(
          Duration.millis(Duration.toMillis(heartbeatStaleAfter) - Duration.toMillis(heartbeatWriteTolerance))
        )
        const peerAtStaleCutoff = yield* stealAt(yield* Clock.currentTimeMillis)

        yield* TestClock.adjust(Duration.millis(1))
        const stolenAtMs = yield* Clock.currentTimeMillis
        const peerPastStaleCutoff = yield* stealAt(stolenAtMs)

        return {
          ownerInsideBudget,
          peerInsideBudget,
          aheadPeerInsideBudget,
          ownerAtTolerance,
          peerAtStaleCutoff,
          peerPastStaleCutoff,
          stolenAtMs,
          finalClaim: (yield* store.get(activated.runId)).claim
        }
      }))

      // Inside the budget the owner keeps working and no peer may take the run.
      expect(result.ownerInsideBudget).toBe(undefined)
      expect(result.peerInsideBudget).toEqual({ _tag: "HeartbeatFresh" })
      expect(result.aheadPeerInsideBudget).toEqual({ _tag: "HeartbeatFresh" })
      // At the tolerance the owner interrupts itself...
      expect(
        result.ownerAtTolerance !== undefined && Exit.isFailure(result.ownerAtTolerance) &&
          Cause.hasInterruptsOnly(result.ownerAtTolerance.cause)
      ).toBe(true)
      // ...still strictly before the persisted heartbeat becomes stealable.
      expect(result.peerAtStaleCutoff).toEqual({ _tag: "HeartbeatFresh" })
      expect(result.peerPastStaleCutoff).toEqual({ _tag: "Claimed", claimedAtMs: result.stolenAtMs })
      expect(result.stolenAtMs).toBe(Duration.toMillis(heartbeatStaleAfter) + 1)
      expect(result.finalClaim).toEqual(ownerC)
    }))

  it("reserves a clock skew allowance larger than one pulse in the write budget", () => {
    // The owner stamps `heartbeat_at_ms` from its own clock and a peer judges
    // staleness against *its* clock, so the offset between the two hosts eats
    // directly into the owner's margin. Only the relation between the two
    // independently chosen constants is asserted here; the margin's *effect* is
    // covered behaviourally by the steal-boundary test above.
    expect(Duration.toMillis(heartbeatSkewAllowance)).toBeGreaterThan(Duration.toMillis(heartbeatInterval))
  })

  it.effect("suspends while clearing owner, heartbeat, and an in-flight claim atomically", () =>
    Effect.gen(function*() {
      const row = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* activateNew(store, "run-suspend", ownerA)
        yield* TestClock.adjust(Duration.seconds(31))
        const stale = yield* store.get("run-suspend")
        const nowMs = yield* Clock.currentTimeMillis
        expect(
          yield* store.steal(
            stale.runId,
            snapshot(stale),
            ownerB,
            nowMs,
            staleEvidence(ownerA, ownerB, nowMs)
          )
        ).toEqual({ _tag: "Claimed", claimedAtMs: nowMs })
        expect(
          yield* store.transitionOwned(stale.runId, ownerA, "suspended", "{\"reason\":\"opaque\"}")
        ).toEqual({ _tag: "Transitioned" })
        return yield* store.get(stale.runId)
      }))

      expect(row).toMatchObject({
        status: "suspended",
        owner: null,
        heartbeatAtMs: null,
        claim: null,
        claimedAtMs: null,
        stateJson: "{\"reason\":\"opaque\"}"
      })
    }))

  it.effect("clears ownership for every terminal transition", () =>
    Effect.gen(function*() {
      const rows = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const result: Array<RunRow> = []
        const statuses: ReadonlyArray<RunStatus> = ["completed", "failed", "cancelled"]
        for (const status of statuses) {
          const runId = `run-terminal-${status}`
          yield* activateNew(store, runId, ownerA)
          expect(yield* store.transitionOwned(runId, ownerA, status)).toEqual({ _tag: "Transitioned" })
          result.push(yield* store.get(runId))
        }
        return result
      }))

      for (const row of rows) {
        expect(row.finishedAtMs).toBe(0)
        expect(row.owner).toBeNull()
        expect(row.heartbeatAtMs).toBeNull()
        expect(row.claim).toBeNull()
        expect(row.claimedAtMs).toBeNull()
      }
    }))

  it.effect("does not reclaim a terminal run", () =>
    Effect.gen(function*() {
      const outcome = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* activateNew(store, "run-terminal-claim", ownerA)
        yield* store.transitionOwned("run-terminal-claim", ownerA, "completed")
        const terminal = yield* store.get("run-terminal-claim")
        return yield* store.claim(
          terminal.runId,
          snapshot(terminal),
          ownerB,
          yield* Clock.currentTimeMillis
        )
      }))

      expect(outcome).toEqual({ _tag: "SnapshotChanged" })
    }))

  it.effect("does not steal a terminal run through its pre-completion snapshot", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-terminal-steal", ownerA)
        const expectedSnapshot = snapshot(running)
        yield* store.transitionOwned(running.runId, ownerA, "completed")
        yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatStaleAfter) + 1))
        const nowMs = yield* Clock.currentTimeMillis
        const outcome = yield* store.steal(
          running.runId,
          expectedSnapshot,
          ownerB,
          nowMs,
          staleEvidence(ownerA, ownerB, nowMs)
        )
        return { outcome, row: yield* store.get(running.runId) }
      }))

      expect(result.outcome).toEqual({ _tag: "SnapshotChanged" })
      expect(result.row).toMatchObject({
        status: "completed",
        owner: null,
        claim: null,
        claimedAtMs: null
      })
    }))

  it.effect("never persists owner columns for a non-running status", () =>
    Effect.gen(function*() {
      const rows = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-pending-owner-invariant", "{}")
        const pending = yield* store.get("run-pending-owner-invariant")
        const result = [pending]
        for (const status of ["suspended", "completed", "failed", "cancelled"] as const) {
          const runId = `run-owner-invariant-${status}`
          yield* activateNew(store, runId, ownerA)
          yield* store.transitionOwned(runId, ownerA, status)
          result.push(yield* store.get(runId))
        }
        return result
      }))

      for (const row of rows) {
        expect(row.status).not.toBe("running")
        expect(row.owner).toBeNull()
        expect(row.heartbeatAtMs).toBeNull()
      }
    }))
})

describe("RunStore ownership evidence boundaries", () => {
  it.effect("uses a strict cutoff for claimAndOwn, recoverClaim, and steal", () =>
    Effect.gen(function*() {
      const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)
      const points = [staleAfterMs - 1, staleAfterMs, staleAfterMs + 1] as const
      const cases = yield* Effect.forEach(
        points.map((nowMs, index) => ({ index, nowMs })),
        ({ index, nowMs }) =>
          migrated(Effect.gen(function*() {
            const store = yield* RunStore
            const direct = yield* activateNew(store, `boundary-direct-${index}`, ownerA)
            const claimRunId = `boundary-claim-${index}`
            yield* store.create(claimRunId, "{}")
            const pending = snapshot(yield* store.get(claimRunId))
            yield* store.claim(claimRunId, pending, ownerA, 0)
            const running = yield* activateNew(store, `boundary-steal-${index}`, ownerA)
            yield* TestClock.setTime(nowMs)
            return {
              claimAndOwn: (yield* store.claimAndOwn(
                direct.runId,
                snapshot(direct),
                ownerB,
                nowMs,
                staleEvidence(ownerA, ownerB, nowMs)
              ))._tag,
              recoverClaim: (yield* store.recoverClaim(
                claimRunId,
                ownerA,
                0,
                ownerB,
                nowMs,
                staleEvidence(ownerA, ownerB, nowMs)
              ))._tag,
              steal: (yield* store.steal(
                running.runId,
                snapshot(running),
                ownerC,
                nowMs,
                staleEvidence(ownerA, ownerC, nowMs)
              ))._tag
            }
          }))
      )
      const outcomes = {
        claimAndOwn: cases.map((value) => value.claimAndOwn),
        recoverClaim: cases.map((value) => value.recoverClaim),
        steal: cases.map((value) => value.steal)
      }

      expect(outcomes).toEqual({
        claimAndOwn: ["HeartbeatFresh", "HeartbeatFresh", "Activated"],
        recoverClaim: ["ClaimFresh", "ClaimFresh", "Recovered"],
        steal: ["HeartbeatFresh", "HeartbeatFresh", "Claimed"]
      })
    }))

  it.effect("rejects stale checkedAtMs values and same-host/cross-host evidence kind mismatches", () =>
    Effect.gen(function*() {
      const variants = [
        {
          name: "wrong-time",
          observer: ownerB,
          evidence: (nowMs: number): LivenessEvidence => ({
            expectedOwner: ownerA,
            checkedAtMs: nowMs - 1,
            kind: "same-host-pid-dead"
          })
        },
        {
          name: "same-host-cross-kind",
          observer: ownerB,
          evidence: (nowMs: number): LivenessEvidence => ({
            expectedOwner: ownerA,
            checkedAtMs: nowMs,
            kind: "cross-host-unreachable-stale"
          })
        },
        {
          name: "cross-host-same-kind",
          observer: ownerC,
          evidence: (nowMs: number): LivenessEvidence => ({
            expectedOwner: ownerA,
            checkedAtMs: nowMs,
            kind: "same-host-pid-dead"
          })
        }
      ] as const

      const outcomes = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const result: Array<{
          readonly claimAndOwn: string
          readonly recoverClaim: string
          readonly steal: string
        }> = []
        for (const variant of variants) {
          // Each variant's rows go genuinely stale before the calls, so the
          // evidence mismatch is the only thing left to refuse them.
          const direct = yield* activateNew(store, `evidence-direct-${variant.name}`, ownerA)
          const claimRunId = `evidence-claim-${variant.name}`
          yield* store.create(claimRunId, "{}")
          const pending = snapshot(yield* store.get(claimRunId))
          const claimedAtMs = yield* Clock.currentTimeMillis
          yield* store.claim(claimRunId, pending, ownerA, claimedAtMs)
          const running = yield* activateNew(store, `evidence-steal-${variant.name}`, ownerA)
          yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatStaleAfter) + 1))
          const nowMs = yield* Clock.currentTimeMillis
          const evidence = variant.evidence(nowMs)

          const claimAndOwn = yield* store.claimAndOwn(
            direct.runId,
            snapshot(direct),
            variant.observer,
            nowMs,
            evidence
          )
          const recoverClaim = yield* store.recoverClaim(
            claimRunId,
            ownerA,
            claimedAtMs,
            variant.observer,
            nowMs,
            evidence
          )
          const steal = yield* store.steal(
            running.runId,
            snapshot(running),
            variant.observer,
            nowMs,
            evidence
          )
          result.push({ claimAndOwn: claimAndOwn._tag, recoverClaim: recoverClaim._tag, steal: steal._tag })
        }
        return result
      }))

      expect(outcomes).toEqual(variants.map(() => ({
        claimAndOwn: "EvidenceRequired",
        recoverClaim: "LivenessUnconfirmed",
        steal: "LivenessUnconfirmed"
      })))
    }))

  it.effect("pins both ten-second clock-skew edges around the stale lease boundary", () =>
    Effect.gen(function*() {
      const staleAtMs = Duration.toMillis(heartbeatStaleAfter) + 1
      const skewMs = Duration.toMillis(heartbeatSkewAllowance)
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const behind = yield* activateNew(store, "skew-behind", ownerA)
        const ahead = yield* activateNew(store, "skew-ahead", ownerA)
        // Both leases are exactly one millisecond past stale by the store's
        // own clock; the peers read ten seconds either side of it.
        yield* TestClock.adjust(Duration.millis(staleAtMs))
        const behindAtMs = staleAtMs - skewMs
        const aheadAtMs = staleAtMs + skewMs
        return {
          ahead: yield* store.steal(
            ahead.runId,
            snapshot(ahead),
            ownerC,
            aheadAtMs,
            staleEvidence(ownerA, ownerC, aheadAtMs)
          ),
          aheadAtMs,
          behind: yield* store.steal(
            behind.runId,
            snapshot(behind),
            ownerC,
            behindAtMs,
            staleEvidence(ownerA, ownerC, behindAtMs)
          ),
          behindAtMs
        }
      }))

      // CONTRACT: inside the skew allowance the store judges the supplied
      // wall-clock instant literally, so a peer ten seconds ahead steals at
      // the edge and a peer ten seconds behind still sees a fresh lease;
      // heartbeatLoop's write-tolerance budget, not the SQL predicate, absorbs
      // that skew. One millisecond past the allowance the reading is refused
      // (RunStoreLeaseOrdering.test.ts).
      expect(skewMs).toBe(10_000)
      expect(result.behindAtMs).toBe(20_001)
      expect(result.behind).toEqual({ _tag: "HeartbeatFresh" })
      expect(result.aheadAtMs).toBe(40_001)
      expect(result.ahead).toEqual({ _tag: "Claimed", claimedAtMs: 40_001 })
    }))
})

/**
 * The three run-store cases the 2026-08-12 review names as unpinned. Each drives
 * a branch the existing suite reaches only incidentally, or not at all.
 */
describe("run-store fencing gaps", () => {
  it.effect("activate clears nothing it does not own after a third party recovered the claim", () =>
    Effect.gen(function*() {
      // The compensating DELETE at RunStore.ts:776-788 runs only under
      // `rowMatchesClaim`, and no case drove that branch with a FOREIGN claim
      // present. Without the guard, a losing activation would strip the claim
      // columns a recovery process had just written for itself.
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-foreign-claim", "{}")
        const pending = snapshot(yield* store.get("run-foreign-claim"))
        const claimed = yield* store.claim("run-foreign-claim", pending, ownerA, 0)
        if (claimed._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))

        // A third party recovers the run: ownerA's claim is released and ownerB
        // takes its own, so the row now carries a claim ownerA does not own.
        yield* store.abandonClaim("run-foreign-claim", ownerA, claimed.claimedAtMs)
        const recovered = yield* store.claim("run-foreign-claim", pending, ownerB, 1)
        if (recovered._tag !== "Claimed") return yield* Effect.die(new Error("recovery claim lost"))

        // ownerA now activates against the claim it believes it holds.
        const outcome = yield* store.activate("run-foreign-claim", ownerA, claimed.claimedAtMs, pending)
        return { outcome, row: yield* store.get("run-foreign-claim") }
      }))

      expect(result.outcome).toEqual({ _tag: "ClaimLost" })
      // ownerB's claim survives untouched: the losing activation cleared nothing.
      expect(result.row.claim).toEqual(ownerB)
      expect(result.row.status).toBe("pending")
    }))

  it.effect("heartbeat on a run suspended under the same owner reports FenceLost, not NotFound", () =>
    Effect.gen(function*() {
      // The fenced UPDATE requires `status = 'running'`, so a suspension under
      // the same owner fails it. The fallback distinguishes an absent row from a
      // present one; nothing asserted which side a suspended run lands on, and
      // `NotFound` would tell a supervisor to stop rather than to release.
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const running = yield* activateNew(store, "run-suspended-heartbeat", ownerA)
        const suspended = yield* store.transitionOwned(running.runId, ownerA, "suspended")
        if (suspended._tag !== "Transitioned") return yield* Effect.die(new Error("suspend lost"))

        return {
          beat: yield* store.heartbeat(running.runId, ownerA, 5),
          absent: yield* store.heartbeat("run-never-created", ownerA, 5)
        }
      }))

      expect(result.beat).toEqual({ _tag: "FenceLost" })
      // The contrast that gives the assertion its meaning.
      expect(result.absent).toEqual({ _tag: "NotFound" })
    }))
})

describe("RunStore structural snapshot admission", () => {
  // [flows-run-store/api-design/1] RunRow extends RunSnapshot, so a row from
  // `get` must be accepted wherever an expected snapshot is typed.
  it.effect("accepts a RunRow from get as the expected snapshot of claim, claimAndOwn, activate, and steal", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("row-claim-and-own", "{}")
      const pendingRow = yield* store.get("row-claim-and-own")
      expect(yield* store.claimAndOwn("row-claim-and-own", pendingRow, ownerA, 0)).toEqual({ _tag: "Activated" })

      yield* store.create("row-claim-activate", "{}")
      const claimRow = yield* store.get("row-claim-activate")
      expect(yield* store.claim("row-claim-activate", claimRow, ownerA, 1)).toEqual({ _tag: "Claimed", claimedAtMs: 1 })
      expect(yield* store.activate("row-claim-activate", ownerA, 1, claimRow)).toEqual({ _tag: "Activated" })

      yield* TestClock.adjust(Duration.seconds(31))
      const runningRow = yield* store.get("row-claim-and-own")
      const staleNow = yield* Clock.currentTimeMillis
      const stolen = yield* store.steal(
        "row-claim-and-own",
        runningRow,
        ownerC,
        staleNow,
        staleEvidence(ownerA, ownerC, staleNow)
      )
      expect(stolen).toEqual({ _tag: "Claimed", claimedAtMs: staleNow })
    })))

  it.effect("still rejects accessors, prototype-carried fields, and missing required fields", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      yield* store.create("row-hostile", "{}")
      const row = yield* store.get("row-hostile")
      let calls = 0
      const accessor = Object.defineProperty({ ...row }, "status", {
        enumerable: true,
        get: () => {
          calls++
          return "pending"
        }
      })
      const extraAccessor = Object.defineProperty({ ...row }, "unrelated", {
        enumerable: true,
        get: () => {
          calls++
          return true
        }
      })
      const inherited = Object.create({ status: "pending", owner: null, heartbeatAtMs: null }) as RunSnapshot
      const { status: _status, ...missing } = row
      const classInstance = new (class Row {
        status = "pending"
        owner = null
        heartbeatAtMs = null
      })()
      const candidates = [accessor, extraAccessor, inherited, missing, classInstance]
      for (const [index, candidate] of candidates.entries()) {
        const failure = yield* Effect.flip(store.claimAndOwn("row-hostile", candidate as never, ownerA, 0))
        expect(failure.code, `candidate ${index}`).toBe("invalid_run")
      }
      expect(calls).toBe(0)
      expect((yield* store.get("row-hostile")).status).toBe("pending")
    })))
})
