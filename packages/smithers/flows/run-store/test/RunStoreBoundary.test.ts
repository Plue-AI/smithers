import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import { type RunRow, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const ownerA: OwnerId = { hostId: "boundary-host", pid: 1, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "boundary-host", pid: 2, nonce: "owner-b" }

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>
) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer())
  )

const snapshot = (row: RunRow): RunStoreLive.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const invalid = <A>(effect: Effect.Effect<A, RunStoreLive.RunStoreError>) =>
  Effect.map(Effect.flip(effect), (failure) => failure.code)

describe("RunStore inert input boundary", () => {
  it.effect("contains late descriptor failures and accepts stable descriptor-only owners", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const owner = { ...ownerA }
      let reads = 0
      const changing = new Proxy(owner, {
        getOwnPropertyDescriptor(target, key) {
          if (key === "hostId" && ++reads === 2) throw new Error("descriptor-probe-marker")
          return Reflect.getOwnPropertyDescriptor(target, key)
        }
      })
      expect(yield* store.heartbeat("missing", changing, 0)).toEqual({ _tag: "NotFound" })
      expect(yield* invalid(store.heartbeat("missing", changing, 0))).toBe("invalid_run")
      expect(reads).toBe(2)

      const stable = new Proxy(owner, {
        get: () => {
          throw new Error("ordinary property access must not occur")
        },
        getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor
      })
      expect(yield* store.heartbeat("missing", stable, 0)).toEqual({ _tag: "NotFound" })
    })))

  it.effect("rejects hostile owner records without invoking accessors or traps", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      let calls = 0
      const accessor = Object.defineProperty({ ...ownerA }, "nonce", {
        enumerable: true,
        get: () => {
          calls++
          return "owner-a"
        }
      })
      const hostile = new Proxy({}, {
        ownKeys: () => {
          calls++
          throw new Error("hostile")
        }
      })
      const disappearing = new Proxy({ ...ownerA }, {
        ownKeys: (target) => [...Reflect.ownKeys(target), "gone"],
        getOwnPropertyDescriptor: (target, key) =>
          key === "gone"
            ? undefined
            : Reflect.getOwnPropertyDescriptor(target, key)
      })
      const hidden = Object.defineProperty({ pid: 1, nonce: "owner-a" }, "hostId", {
        value: "boundary-host",
        enumerable: false
      })
      const candidates = [null, new Date(), accessor, hostile, hidden, { hostId: "boundary-host", pid: 1 }]
      for (const candidate of candidates) {
        expect(yield* invalid(store.heartbeat("missing", candidate as never, 0))).toBe("invalid_run")
      }
      expect(yield* store.heartbeat("missing", disappearing, 0)).toEqual({ _tag: "NotFound" })
      expect(calls).toBe(1)
    })))

  it.effect("returns invalid_run for non-string create state", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      for (const [index, stateJson] of [null, 42, { value: true }].entries()) {
        const failure = yield* Effect.flip(store.create(`invalid-create-state-${index}`, stateJson as never))
        expect(failure).toMatchObject({ code: "invalid_run", method: "create" })
      }
    })))

  it.effect("validates create options, snapshots, evidence, guards, and state as exact records", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const optionCandidates = [
        new Date(),
        { parentRunId: 1 },
        { lineageId: "lineage" },
        { roundOrdinal: 1 },
        { lineageId: "lineage", roundOrdinal: -1 }
      ]
      for (const [index, options] of optionCandidates.entries()) {
        expect(yield* invalid(store.create(`bad-options-${index}`, "{}", options as never))).toBe("invalid_run")
      }

      yield* store.create("boundary-run", "{}")
      const expectedCandidates = [
        null,
        new Proxy({}, {
          ownKeys: () => {
            throw new Error("hostile snapshot")
          }
        }),
        new Proxy({}, {
          getOwnPropertyDescriptor: () => {
            throw new Error("hostile descriptor")
          }
        }),
        { status: "unknown", owner: null, heartbeatAtMs: null },
        { status: "pending", owner: null, heartbeatAtMs: -1 },
        { status: "pending", owner: ownerA, heartbeatAtMs: null },
        { status: "running", owner: null, heartbeatAtMs: null }
      ]
      for (const expected of expectedCandidates) {
        expect(yield* invalid(store.claim("boundary-run", expected as never, ownerA, 0))).toBe("invalid_run")
      }

      const running = yield* store.claimAndOwn(
        "boundary-run",
        { status: "pending", owner: null, heartbeatAtMs: null },
        ownerA,
        0
      )
      expect(running).toEqual({ _tag: "Activated" })
      const row = yield* store.get("boundary-run")
      for (
        const evidence of [
          null,
          { expectedOwner: ownerA, checkedAtMs: 0, kind: "unknown" },
          { expectedOwner: ownerA, checkedAtMs: 0, kind: "lease-expired", extra: true }
        ]
      ) {
        const exit = yield* Effect.exit(
          store.steal("boundary-run", snapshot(row), ownerB, 0, evidence as never)
        )
        expect(exit._tag, JSON.stringify(evidence)).toBe("Failure")
      }

      expect(
        yield* invalid(store.transitionOwned(
          "boundary-run",
          ownerA,
          "running",
          1 as never
        ))
      ).toBe("invalid_run")
      expect(
        yield* invalid(store.transitionOwned(
          "boundary-run",
          ownerA,
          "unknown" as never
        ))
      ).toBe("invalid_run")
      expect(
        yield* invalid(store.transitionOwned(
          "boundary-run",
          ownerA,
          "running",
          undefined,
          new Date() as never
        ))
      ).toBe("invalid_run")
      expect(
        yield* invalid(store.transitionOwned(
          "boundary-run",
          ownerA,
          "running",
          undefined,
          { cancelRequested: "unknown" } as never
        ))
      ).toBe("invalid_run")
      expect(yield* store.transitionOwned("boundary-run", ownerA, "running", undefined, {})).toEqual({
        _tag: "Transitioned"
      })
    })))

  it.effect("distinguishes absent and already-claimed rows before requesting evidence", () =>
    migrated(Effect.gen(function*() {
      const store = yield* RunStore
      const sql = yield* SqlClient.SqlClient

      yield* store.create("gone-run", "{}")
      yield* store.claimAndOwn(
        "gone-run",
        { status: "pending", owner: null, heartbeatAtMs: null },
        ownerA,
        0
      )
      const gone = yield* store.get("gone-run")
      yield* sql`DELETE FROM flows_runs WHERE run_id = 'gone-run'`
      expect(yield* store.claimAndOwn("gone-run", snapshot(gone), ownerB, 0)).toEqual({ _tag: "NotFound" })

      yield* store.create("claimed-run", "{}")
      yield* store.claimAndOwn(
        "claimed-run",
        { status: "pending", owner: null, heartbeatAtMs: null },
        ownerA,
        0
      )
      const claimed = yield* store.get("claimed-run")
      yield* sql`
        UPDATE flows_runs
        SET claim_host_id = ${ownerB.hostId}, claim_pid = ${ownerB.pid},
            claim_nonce = ${ownerB.nonce}, claimed_at_ms = 0
        WHERE run_id = 'claimed-run'
      `
      expect(yield* store.claimAndOwn("claimed-run", snapshot(claimed), ownerB, 0)).toEqual({
        _tag: "AlreadyClaimed"
      })
    })))
})
