import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Duration, Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const owner: OwnerId = { hostId: "host", pid: 1, nonce: "n" }

const layer = Layer.provideMerge(
  RunStore.layer,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
)

const effect = <E>(
  name: string,
  body: () => Effect.Effect<void, E, RunStore.RunStore | DurableWriter | SqlClient.SqlClient>
) => it.effect(name, () => body().pipe(Effect.provide(layer), Effect.scoped))

const own = (store: RunStore.Service, runId: string) =>
  store.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, 1_000)

const expectRunStoreFailure = <A>(
  exit: Exit.Exit<A, RunStore.RunStoreError>,
  method: string,
  code = "invalid_run"
): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  const failure = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined
  expect(failure?.error).toEqual(expect.objectContaining({ code, method }))
}

describe("run metadata", () => {
  effect("create records lineage and exposes it on the row", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("parent", "{}")
      yield* store.create("child", "{}", { parentRunId: "parent" })
      const parent = yield* store.get("parent")
      const child = yield* store.get("child")
      expect(parent.parentRunId).toBeNull()
      expect(parent.cancelRequestedAtMs).toBeNull()
      expect(child.parentRunId).toBe("parent")
      // Absent lineage columns read back as null: an ordinary run is a
      // lineage of one, and every row written before the append-only
      // migration decodes the same way.
      expect(parent.lineageId).toBeNull()
      expect(parent.roundOrdinal).toBeNull()
    }))

  effect("create records the trampoline lineage pair and exposes it on the row", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("round-0", "{}")
      yield* store.create("round-1", "{}", {
        parentRunId: "round-0",
        lineageId: "round-0",
        roundOrdinal: 1
      })
      const round = yield* store.get("round-1")
      expect(round.parentRunId).toBe("round-0")
      expect(round.lineageId).toBe("round-0")
      expect(round.roundOrdinal).toBe(1)
    }))

  effect("lineage is walkable in SQL", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("a", "{}")
      yield* store.create("b", "{}", { parentRunId: "a" })
      yield* store.create("c", "{}", { parentRunId: "b" })
      const rows = yield* sql<{ readonly run_id: string }>`
        WITH RECURSIVE ancestry(run_id, parent_run_id) AS (
          SELECT run_id, parent_run_id FROM flows_runs WHERE run_id = 'c'
          UNION ALL
          SELECT flows_runs.run_id, flows_runs.parent_run_id
          FROM flows_runs JOIN ancestry ON flows_runs.run_id = ancestry.parent_run_id
        )
        SELECT run_id FROM ancestry
      `
      expect(rows.map((row) => row.run_id)).toEqual(["c", "b", "a"])
    }))

  effect("requestCancel is idempotent and unfenced", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "AlreadyRequested", requestedAtMs: 500 })
      expect(yield* store.requestCancel("missing", 900)).toEqual({ _tag: "NotFound" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBe(500)
    }))

  effect("reads a cancellation timestamp from an earlier caller domain", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* TestClock.adjust(Duration.seconds(10))
      yield* store.create("earlier-cancel-clock", "{}")
      yield* TestClock.adjust(Duration.seconds(1))
      expect(yield* store.requestCancel("earlier-cancel-clock", 1)).toEqual({
        _tag: "CancelRequested",
        requestedAtMs: 1
      })
      expect((yield* store.get("earlier-cancel-clock")).cancelRequestedAtMs).toBe(1)
    }).pipe(Effect.provide(TestClock.layer())))

  effect("a guarded completion loses to a cancel request", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      yield* store.requestCancel("run", 500)
      const guarded = yield* store.transitionOwned("run", owner, "completed", undefined, {
        cancelRequested: "absent"
      })
      expect(guarded).toEqual({ _tag: "GuardFailed" })
      expect((yield* store.get("run")).status).toBe("running")
    }))

  effect("a guarded completion wins when no cancel was requested", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      const guarded = yield* store.transitionOwned("run", owner, "completed", undefined, {
        cancelRequested: "absent"
      })
      expect(guarded).toEqual({ _tag: "Transitioned" })
    }))

  effect("a cancel-present guard admits only a requested cancellation", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      expect(
        yield* store.transitionOwned("run", owner, "cancelled", undefined, { cancelRequested: "present" })
      ).toEqual({ _tag: "GuardFailed" })
      yield* store.requestCancel("run", 500)
      expect(
        yield* store.transitionOwned("run", owner, "cancelled", undefined, { cancelRequested: "present" })
      ).toEqual({ _tag: "Transitioned" })
    }))

  effect("a guard on a lost fence still reports the fence loss", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      const other: OwnerId = { hostId: "host", pid: 2, nonce: "other" }
      expect(
        yield* store.transitionOwned("run", other, "completed", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "FenceLost" })
      expect(
        yield* store.transitionOwned("missing", owner, "completed", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "NotFound" })
    }))

  effect("a guarded running transition keeps ownership", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      expect(
        yield* store.transitionOwned("run", owner, "running", `{"a":1}`, { cancelRequested: "absent" })
      ).toEqual({ _tag: "Transitioned" })
      yield* store.requestCancel("run", 500)
      expect(
        yield* store.transitionOwned("run", owner, "running", undefined, { cancelRequested: "absent" })
      ).toEqual({ _tag: "GuardFailed" })
    }))

  for (
    const [name, guard] of [
      ["an unknown cancelRequested value", { cancelRequested: "typo" }],
      ["a null value", null],
      ["an excess property", { cancelRequested: "absent", typo: true }]
    ] as const
  ) {
    effect(`transitionOwned rejects ${name} in its guard`, () =>
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const runId = `invalid-guard-${name}`
        yield* store.create(runId, "{}")
        yield* own(store, runId)
        const exit = yield* Effect.exit(
          store.transitionOwned(runId, owner, "completed", undefined, guard as never)
        )
        expectRunStoreFailure(exit, "transitionOwned")
        expect(yield* store.get(runId)).toMatchObject({ status: "running", owner })
      }))
  }

  effect("transitionOwned rejects pending without changing the owned run", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run-no-transition-to-pending", "{}")
      yield* own(store, "run-no-transition-to-pending")
      const exit = yield* Effect.exit(
        store.transitionOwned("run-no-transition-to-pending", owner, "pending")
      )
      expectRunStoreFailure(exit, "transitionOwned")
      expect(yield* store.get("run-no-transition-to-pending")).toMatchObject({
        status: "running",
        owner
      })
    }))

  effect("create rejects an empty parent run id", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const failure = yield* Effect.flip(store.create("run", "{}", { parentRunId: "" }))
      expect(failure.code).toBe("invalid_run")
    }))

  effect("create rejects incomplete or invalid trampoline metadata", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      expect(
        (yield* Effect.flip(store.create("missing-ordinal", "{}", {
          lineageId: "lineage"
        }))).code
      ).toBe("invalid_run")
      expect(
        (yield* Effect.flip(store.create("missing-lineage", "{}", {
          roundOrdinal: 1
        }))).code
      ).toBe("invalid_run")
      expect(
        (yield* Effect.flip(store.create("negative-ordinal", "{}", {
          lineageId: "lineage",
          roundOrdinal: -1
        }))).code
      ).toBe("invalid_run")
    }))

  effect("requestCancel rejects an invalid timestamp", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const failure = yield* Effect.flip(store.requestCancel("run", -1))
      expect(failure.code).toBe("invalid_run")
    }))

  effect("the noop store reports typed losses for the new operations", () =>
    Effect.gen(function*() {
      const store = RunStore.makeNoop()
      expect(yield* store.requestCancel("run", 1)).toEqual({ _tag: "NotFound" })
    }))
})

/**
 * B10: the `requestCancel` fallback read once collapsed "the row does not
 * exist" and "the row exists with a NULL column" into one `== null` test. The
 * writer serializes the whole call, so no peer can clear the column between
 * the guarded UPDATE and the classifier read; a live unrequested row there is
 * a persistence invariant failure, and a missing row is `NotFound`.
 */
describe("requestCancel classifies a miss inside one serialized write", () => {
  effect("concurrent requesters on one live run agree on the first request", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      const outcomes = yield* Effect.all(
        [store.requestCancel("run", 500), store.requestCancel("run", 900), store.requestCancel("run", 700)],
        { concurrency: "unbounded" }
      )
      const requested = outcomes.filter((outcome) => outcome._tag === "CancelRequested")
      expect(requested).toHaveLength(1)
      const winner = requested[0]!.requestedAtMs
      for (const outcome of outcomes) {
        if (outcome._tag !== "CancelRequested") {
          expect(outcome).toEqual({ _tag: "AlreadyRequested", requestedAtMs: winner })
        }
      }
      expect((yield* store.get("run")).cancelRequestedAtMs).toBe(winner)
    }))

  effect(
    "fails persistence_failed when the guarded update silently misses a live unrequested row",
    () =>
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* store.create("run", "{}")
        // RAISE(IGNORE) drops the row change without an error, which is the only
        // way a live unrequested row can survive the UPDATE inside one writer.
        yield* Dialect.trigger(sql, {
          name: `ignore_cancel`,
          table: `flows_runs`,
          event: `BEFORE UPDATE OF cancel_requested_at_ms`,
          ignore: true
        })
        const exit = yield* Effect.exit(store.requestCancel("run", 500))
        expectRunStoreFailure(exit, "requestCancel", "persistence_failed")
        expect(Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error : undefined)
          .toMatchObject({ cause: { runId: "run", stage: "write-invariant" } })
        expect((yield* store.get("run")).cancelRequestedAtMs).toBeNull()
      })
  )
})

describe("requestCancel status decode failures", () => {
  effect("fails decode_failed at the fallback status read", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.create("bad-fallback-status", "{}")
      yield* TestDatabase.checks(sql, false)
      yield* sql`
        UPDATE flows_runs
        SET status = 'not-a-status', cancel_requested_at_ms = 1
        WHERE run_id = 'bad-fallback-status'
      `
      yield* TestDatabase.checks(sql, true)
      const exit = yield* Effect.exit(store.requestCancel("bad-fallback-status", 2))
      expectRunStoreFailure(exit, "requestCancel", "decode_failed")
    }))
})

/**
 * B-02: `requestCancel` guarded only on `cancel_requested_at_ms IS NULL`, with
 * no status predicate, so a run that had already settled accepted new
 * cancellation intent forever. The write was not harmless: nothing ever acts
 * on it — the run has no owner and no drive to observe it — and
 * `RunDriver.inheritParentCancellation` reads the column straight off a
 * terminal parent, so a request written against a `completed` parent cancelled
 * children that parent had finished with.
 *
 * A settled run therefore reports the terminal status instead of recording
 * anything. The status is read rather than assumed, so the caller learns which
 * ending it lost to.
 */
describe("requestCancel refuses a run that already settled (B-02)", () => {
  /** Settles a run terminally through the owned transition, as a driver does. */
  const settle = (store: RunStore.Service, runId: string, status: RunStore.RunStatus) =>
    Effect.gen(function*() {
      yield* store.create(runId, "{}")
      yield* own(store, runId)
      expect(yield* store.transitionOwned(runId, owner, status, undefined)).toEqual({ _tag: "Transitioned" })
    })

  effect("a completed run answers Terminal twice and leaves the column NULL", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* settle(store, "run", "completed")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "Terminal", status: "completed" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBeNull()
      // Repeating it is the operator retry: it must stay Terminal rather than
      // decaying into AlreadyRequested off a column the first call wrote.
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "Terminal", status: "completed" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBeNull()
    }))

  effect("a failed run answers Terminal and leaves the column NULL", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* settle(store, "run", "failed")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "Terminal", status: "failed" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBeNull()
    }))

  effect("a cancelled run answers Terminal and keeps the request that closed it", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run", "{}")
      yield* own(store, "run")
      expect(yield* store.requestCancel("run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })
      expect(yield* store.transitionOwned("run", owner, "cancelled", undefined)).toEqual({ _tag: "Transitioned" })
      expect(yield* store.requestCancel("run", 900)).toEqual({ _tag: "Terminal", status: "cancelled" })
      expect((yield* store.get("run")).cancelRequestedAtMs).toBe(500)
    }))

  effect("a pending, running, or suspended run still records the request", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("pending-run", "{}")
      expect(yield* store.requestCancel("pending-run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })

      yield* store.create("running-run", "{}")
      yield* own(store, "running-run")
      expect(yield* store.requestCancel("running-run", 500)).toEqual({ _tag: "CancelRequested", requestedAtMs: 500 })

      yield* store.create("suspended-run", "{}")
      yield* own(store, "suspended-run")
      yield* store.transitionOwned("suspended-run", owner, "suspended", undefined)
      expect(yield* store.requestCancel("suspended-run", 500)).toEqual({
        _tag: "CancelRequested",
        requestedAtMs: 500
      })
    }))
})
