import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { RunStore } from "@smthrs/run-store"
import * as Ownership from "@smthrs/run-store/Ownership"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import type { Result as CompensationResult } from "../src/internal/Compensation.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Recovery from "../src/internal/Recovery.ts"
import type { AuditDetail } from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { error } from "../src/TimeTravelError.ts"
import { type Audit, TimeTravelStore } from "../src/TimeTravelStore.ts"
import { row as makeRow } from "./MemoryHarness.ts"

const owner: OwnerId = { hostId: "recovery-host", pid: 40, nonce: "recovery-owner" }
const frame = { lineageId: "run/root", seq: 0 } as const

const makeRuns = (
  overrides: Partial<RunStore.Service> = {}
): RunStore.Service & { readonly state: () => RunStore.RunRow } => {
  let row: RunStore.RunRow = makeRow({
    status: "running",
    owner,
    heartbeatAtMs: 0,
    stateJson: "{\"cursor\":7}"
  })
  const service = RunStore.makeNoop({
    get: () => Effect.succeed({ ...row }),
    transitionOwned: (_runId, currentOwner, status, stateJson) =>
      Effect.sync(() => {
        if (row.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        row = {
          ...row,
          status,
          stateJson: stateJson ?? row.stateJson,
          ...(status === "running"
            ? {}
            : {
              owner: null,
              heartbeatAtMs: null,
              claim: null,
              claimedAtMs: null,
              parentRunId: null,
              cancelRequestedAtMs: null
            })
        }
        return { _tag: "Transitioned" as const }
      }),
    ...overrides
  })
  return Object.assign(service, { state: () => ({ ...row }) })
}

const journal = (hasSuffix: boolean): Journal.Service =>
  Journal.makeNoop({
    // The store appends ownership transitions for the children recovery
    // claims and cancels; the stub accepts them without retaining them.
    emitDurableUnfenced: () =>
      Effect.succeed({ _tag: "Accepted", seq: 0 as JournalEvent.Seq, sourceSeq: 0 as JournalEvent.SourceSeq }),
    entries: () =>
      Effect.succeed({
        entries: hasSuffix
          ? [{
            runId: "run" as JournalEvent.RunId,
            seq: 1 as JournalEvent.Seq,
            eventId: "event-1",
            sourceId: "recovery" as JournalEvent.SourceId,
            sourceSeq: 1 as JournalEvent.SourceSeq,
            emittedAtMs: 1,
            eventType: "suffix",
            payload: {},
            meta: {}
          } as JournalEvent.Entry]
          : [],
        hasMore: false
      })
  })

const effect: EffectRecord = {
  id: "send",
  kind: "send",
  tier: "irreversible",
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  seq: 1,
  durableBoundary: true,
  providerStream: false
}

const compensation: CompensationResult = {
  handlerReceipts: [{
    id: "send:rollback",
    effect,
    data: { value: "sent" }
  }],
  workspace: {
    currentChangeId: "current",
    targetChangeId: "target"
  }
}

const audit = (
  phase: AuditDetail["phase"],
  detailCompensation?: CompensationResult
): Audit => ({
  id: `audit-${phase}`,
  runId: "run",
  frame,
  status: "in_progress",
  detail: {
    version: 1,
    phase,
    originalStatus: "suspended",
    suffixCount: 1,
    suffixTailSeq: 1,
    ...(detailCompensation === undefined ? {} : { compensation: detailCompensation }),
    warnings: [],
    cancelledChildren: []
  } satisfies AuditDetail
})

const seed = (
  store: ReturnType<typeof MemoryTimeTravelStore.make>,
  value: Audit
) => Effect.runSync(store.writeAudit(value))

const runRecovery = (
  store: ReturnType<typeof MemoryTimeTravelStore.make>,
  runs: RunStore.Service,
  jj: Jj.Jj,
  registry: EffectHandlerRegistry.Service,
  hasSuffix: boolean,
  options: Partial<Recovery.Options> = {}
) =>
  Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined), ...options }).pipe(
    Effect.provide(Layer.succeed(TimeTravelStore, store)),
    Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
    Effect.provide(Layer.succeed(Journal.Journal, journal(hasSuffix))),
    Effect.provide(Layer.succeed(Jj.Jj, jj)),
    Effect.provide(Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, registry))
  )

describe("Recovery", () => {
  for (const committed of [true, false]) {
    for (const claimedOnly of [false, true]) {
      it.effect(`recovers a stale ${claimedOnly ? "claim" : "running child"} ${committed ? "after" : "before"} commit`, () =>
        Effect.gen(function*() {
          yield* Migrations.run
          const sql = yield* SqlClient.SqlClient
          const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
          const store = MemoryTimeTravelStore.make()
          const phase = committed ? "archive_committed" : "compensated"
          const value = audit(phase)
          seed(store, { ...value, detail: { ...value.detail as AuditDetail, pendingChildren: ["child"] } })
          yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('run', 'suspended', 0, '{}'), ('child', 'suspended', 0, '{"cursor":3}')
          `
          const dead = { hostId: "dead-host", pid: 99, nonce: "dead:rewind-child:child" }
          const expected = { status: "suspended" as const, owner: null, heartbeatAtMs: null }
          const claim = yield* runs.claim("child", expected, dead, 0)
          expect(claim._tag).toBe("Claimed")
          if (!claimedOnly) {
            expect(yield* runs.activate("child", dead, 0, expected)).toEqual({ _tag: "Activated" })
          }
          yield* TestClock.adjust("1 minute")
          const options: Partial<Recovery.Options> = {
            livenessEvidence: (_audit, row, _claimant, nowMs) =>
              Effect.succeed({
                expectedOwner: row.owner!,
                checkedAtMs: nowMs,
                kind: "lease-expired"
              })
          }
          const outcomes = yield* runRecovery(
            store,
            runs,
            Jj.makeNoop({}),
            EffectHandlerRegistry.makeNoop(),
            !committed,
            options
          )
          expect(outcomes).toEqual([{ _tag: committed ? "Completed" : "RolledBack", auditId: value.id }])
          expect(yield* runs.get("child")).toMatchObject({
            status: committed ? "cancelled" : "suspended",
            owner: null,
            claim: null,
            stateJson: "{\"cursor\":3}"
          })
          expect(store.state().audits[0]).toMatchObject({
            status: committed ? "completed" : "failed",
            detail: { pendingChildren: [], cancelledChildren: committed ? ["child"] : [] }
          })
          expect(
            yield* runRecovery(
              store,
              runs,
              Jj.makeNoop({}),
              EffectHandlerRegistry.makeNoop(),
              !committed,
              options
            )
          ).toEqual([])
        }).pipe(Effect.provide(TestDatabase.layer)))
    }
  }

  for (const refusal of ["no-probe", "live", "fresh", "wrong-owner", "old-evidence", "heartbeat-race"] as const) {
    it.effect(`keeps the child and audit recoverable on ${refusal}`, () =>
      Effect.gen(function*() {
        yield* Migrations.run
        const sql = yield* SqlClient.SqlClient
        const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
        const store = MemoryTimeTravelStore.make()
        const value = audit("archive_committed")
        seed(store, { ...value, detail: { ...value.detail as AuditDetail, pendingChildren: ["child"] } })
        yield* sql`
          INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES ('run', 'suspended', 0, '{}'), ('child', 'suspended', 0, '{}')
        `
        // Also recover an earlier recovery pass that died after activating a child.
        const dead = { hostId: "dead-host", pid: 99, nonce: "dead:recovery-child:child" }
        const expected = { status: "suspended" as const, owner: null, heartbeatAtMs: null }
        yield* runs.claim("child", expected, dead, 0)
        yield* runs.activate("child", dead, 0, expected)
        yield* TestClock.adjust("1 minute")
        if (refusal === "fresh") yield* runs.heartbeat("child", dead, 60_000)
        const options: Partial<Recovery.Options> = refusal === "no-probe" ? {} : {
          livenessEvidence: (_audit, row, _claimant, nowMs) =>
            Effect.gen(function*() {
              if (refusal === "live") return undefined
              if (refusal === "heartbeat-race") yield* runs.heartbeat("child", dead, nowMs).pipe(Effect.orDie)
              return {
                expectedOwner: refusal === "wrong-owner" ? owner : row.owner!,
                checkedAtMs: refusal === "old-evidence" ? nowMs - 1 : nowMs,
                kind: "lease-expired" as const
              }
            })
        }
        expect(
          yield* runRecovery(
            store,
            runs,
            Jj.makeNoop({}),
            EffectHandlerRegistry.makeNoop(),
            false,
            options
          )
        ).toMatchObject([{ _tag: "Busy", error: { code: "busy" } }])
        expect(yield* runs.get("child")).toMatchObject({ status: "running", owner: dead, claim: null })
        expect(store.state().audits[0]).toMatchObject({
          status: "in_progress",
          detail: { pendingChildren: ["child"] }
        })
        yield* TestClock.adjust("1 minute")
        expect(
          yield* runRecovery(
            store,
            runs,
            Jj.makeNoop({}),
            EffectHandlerRegistry.makeNoop(),
            false,
            {
              livenessEvidence: (_audit, row, _claimant, nowMs) =>
                Effect.succeed({
                  expectedOwner: row.owner!,
                  checkedAtMs: nowMs,
                  kind: "lease-expired"
                })
            }
          )
        ).toEqual([{ _tag: "Completed", auditId: value.id }])
      }).pipe(Effect.provide(TestDatabase.layer)))
  }

  it.effect("rolls back without releasing unrelated child owners or claims", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      const sql = yield* SqlClient.SqlClient
      const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
      const store = MemoryTimeTravelStore.make()
      const value = audit("compensated")
      seed(store, { ...value, detail: { ...value.detail as AuditDetail, pendingChildren: ["owned", "claimed"] } })
      yield* sql`
        INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('run', 'suspended', 0, '{}'), ('owned', 'suspended', 0, '{}'), ('claimed', 'pending', 0, '{}')
      `
      const stranger = { hostId: "engine", pid: 99, nonce: "engine-owner" }
      const expected = { status: "suspended" as const, owner: null, heartbeatAtMs: null }
      yield* runs.claim("owned", expected, stranger, 0)
      yield* runs.activate("owned", stranger, 0, expected)
      yield* runs.claim("claimed", { ...expected, status: "pending" }, stranger, 0)
      yield* TestClock.adjust("1 minute")
      expect(
        yield* runRecovery(
          store,
          runs,
          Jj.makeNoop({}),
          EffectHandlerRegistry.makeNoop(),
          true,
          {
            livenessEvidence: () => Effect.die("unrelated ownership must not be probed")
          }
        )
      ).toEqual([{ _tag: "RolledBack", auditId: value.id }])
      expect(yield* runs.get("owned")).toMatchObject({ status: "running", owner: stranger })
      expect(yield* runs.get("claimed")).toMatchObject({ status: "pending", claim: stranger })
    }).pipe(Effect.provide(TestDatabase.layer)))

  for (
    const refusal of [
      "foreign-owner",
      "foreign-claim",
      "missing-claim-time",
      "claim-fresh",
      "claim-race",
      "claim-error",
      "steal-error"
    ] as const
  ) {
    it.effect(`reports child recovery ${refusal} without closing a retryable audit`, () =>
      Effect.gen(function*() {
        const store = MemoryTimeTravelStore.make()
        const value = audit("archive_committed")
        seed(store, { ...value, detail: { ...value.detail as AuditDetail, pendingChildren: ["child"] } })
        const parent = makeRuns()
        const dead = { hostId: "dead-host", pid: 99, nonce: "dead:rewind-child:child" }
        const stranger = { ...dead, nonce: "engine" }
        const hasClaim = refusal !== "foreign-owner" && refusal !== "steal-error"
        const child: RunStore.RunRow = {
          ...parent.state(),
          runId: "child",
          status: hasClaim ? "suspended" : "running",
          owner: hasClaim ? null : refusal === "foreign-owner" ? stranger : dead,
          claim: hasClaim ? refusal === "foreign-claim" ? stranger : dead : null,
          claimedAtMs: refusal === "missing-claim-time" ? null : 0
        }
        const persistenceFailure = new RunStore.RunStoreError({
          code: "persistence_failed",
          method: "recovery-test",
          message: "store unavailable",
          cause: undefined
        })
        const runs = RunStore.makeNoop({
          ...parent,
          get: (runId) => runId === "child" ? Effect.succeed(child) : parent.get(runId),
          recoverClaim: () =>
            refusal === "claim-error"
              ? Effect.fail(persistenceFailure)
              : Effect.succeed({ _tag: refusal === "claim-fresh" ? "ClaimFresh" as const : "ClaimChanged" as const }),
          steal: () => Effect.fail(persistenceFailure)
        })
        const failed = refusal === "claim-error" || refusal === "steal-error"
        expect(
          yield* runRecovery(
            store,
            runs,
            Jj.makeNoop({}),
            EffectHandlerRegistry.makeNoop(),
            false,
            {
              livenessEvidence: (_audit, row, _claimant, nowMs) =>
                Effect.succeed({
                  expectedOwner: row.owner!,
                  checkedAtMs: nowMs,
                  kind: "lease-expired"
                })
            }
          )
        ).toMatchObject([{ _tag: failed ? "Failed" : "Busy", error: { code: failed ? "unknown" : "busy" } }])
        expect(store.state().audits[0]).toMatchObject({
          status: failed ? "failed" : "in_progress",
          detail: { pendingChildren: ["child"] }
        })
        expect(yield* runs.get("child")).toEqual(child)
      }))
  }

  it.effect("finishes the suspended transition when the archive transaction committed", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("archive_committed"))
      const runs = makeRuns()
      const registry = EffectHandlerRegistry.makeNoop()
      const jj = Jj.makeNoop({
        snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }),
        restore: () => Effect.void
      })

      const outcomes = yield* runRecovery(store, runs, jj, registry, false)

      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit-archive_committed" }])
      expect(runs.state()).toMatchObject({ status: "suspended", owner: null, stateJson: "{\"cursor\":7}" })
      expect(store.state().audits).toMatchObject([
        { id: "audit-archive_committed", status: "completed" }
      ])
    }))

  it.effect("restores the state at the rewind frame after an archive commit", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [{
          runId: "run",
          seq: 0,
          eventId: "state-at-frame",
          lineageId: frame.lineageId,
          eventType: "flows.engine.run-decision",
          payload: { state: { cursor: 0 } }
        }]
      })
      seed(store, audit("archive_committed"))
      const runs = makeRuns()

      const outcomes = yield* runRecovery(
        store,
        runs,
        Jj.makeNoop({}),
        EffectHandlerRegistry.makeNoop(),
        false
      )

      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit-archive_committed" }])
      expect(runs.state()).toMatchObject({
        status: "suspended",
        owner: null,
        stateJson: JSON.stringify({ cursor: 0 })
      })
    }))

  it.effect("restores jj and handler receipts when the archive transaction did not commit", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("compensated", compensation))
      const runs = makeRuns()
      const external: Array<string> = []
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ value: "sent" }),
          rollback: (_crossed, receipt) =>
            Effect.sync(() => {
              external.push(String((receipt as { readonly value: string }).value))
            })
        }])
      )
      let pointer = "target"
      const jj = Jj.makeNoop({
        snapshot: () => Effect.succeed({ commitId: pointer, changeId: pointer }),
        restore: (changeId) =>
          Effect.sync(() => {
            pointer = changeId
          })
      })

      const outcomes = yield* runRecovery(store, runs, jj, registry, true)

      expect(outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit-compensated" }])
      expect(pointer).toBe("current")
      expect(external).toEqual(["sent"])
      expect(runs.state()).toMatchObject({ status: "suspended", owner: null })
      expect(store.state().audits).toMatchObject([
        { id: "audit-compensated", status: "failed" }
      ])
    }))

  it.effect("persists a successful rollback before a busy restoration and never repeats it", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("compensated", compensation))
      let rollbacks = 0
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ value: "sent" }),
          rollback: () => Effect.sync(() => (rollbacks += 1))
        }])
      )
      const stuck = makeRuns({
        transitionOwned: () => Effect.succeed({ _tag: "FenceLost" as const })
      })

      const first = yield* runRecovery(store, stuck, Jj.makeNoop({ restore: () => Effect.void }), registry, true)

      expect(first[0]).toMatchObject({ _tag: "Busy", error: { code: "busy" } })
      const firstOutcome = first[0]
      expect(firstOutcome?._tag === "Busy" ? firstOutcome.error.message : "").toContain(
        "run run lost its rollback fence"
      )
      expect(rollbacks).toBe(1)
      expect(store.state().audits[0]).toMatchObject({ status: "in_progress" })
      expect((store.state().audits[0]!.detail as AuditDetail).compensation).toBeUndefined()

      const second = yield* runRecovery(
        store,
        makeRuns(),
        Jj.makeNoop({ restore: () => Effect.void }),
        registry,
        true
      )

      expect(second).toEqual([{ _tag: "RolledBack", auditId: "audit-compensated" }])
      expect(rollbacks).toBe(1)
    }))

  // `sameOwner` compares hostId, pid, and nonce. A nonce is unique per process
  // start, but two hosts can still present one to the same run row after a
  // restore or a clone, so the host is part of the identity and not decoration:
  // a row whose owner matches on pid and nonce alone is somebody else's.
  it.effect("refuses a running row whose owner shares the nonce and pid but not the host", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("archive_committed"))
      const impostor = { ...owner, hostId: "other-host" }
      const runs = makeRuns({
        get: () =>
          Effect.succeed(
            makeRow({ status: "running", owner: impostor, heartbeatAtMs: 0, stateJson: "{\"cursor\":7}" })
          )
      })

      const outcomes = yield* runRecovery(
        store,
        runs,
        Jj.makeNoop({ restore: () => Effect.void }),
        Effect.runSync(EffectHandlerRegistry.make([])),
        false
      )

      expect(outcomes).toMatchObject([{
        _tag: "Busy",
        auditId: "audit-archive_committed",
        error: { code: "busy", message: "run run is still live" }
      }])
      expect(store.state().audits).toMatchObject([{ status: "in_progress" }])
    }))

  it.effect("records an unrecoverable typed terminal failure without inventing a run status", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("compensated", compensation))
      const runs = makeRuns()
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ value: "sent" }),
          rollback: () => Effect.fail(error("compensation_failed", "rollback failed"))
        }])
      )
      const jj = Jj.makeNoop({
        snapshot: () => Effect.succeed({ commitId: "target", changeId: "target" }),
        restore: () => Effect.void
      })

      const outcomes = yield* runRecovery(store, runs, jj, registry, true)

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        auditId: "audit-compensated",
        error: { code: "compensation_failed" }
      })
      expect(runs.state()).toMatchObject({ status: "suspended", owner: null })
      expect(["pending", "running", "suspended", "completed", "failed", "cancelled"]).toContain(
        runs.state().status
      )
      expect(store.state().audits[0]).toMatchObject({
        status: "failed",
        detail: { phase: "terminal_failure" }
      })
    }))

  it.effect("heartbeats throughout recovery rollback and stops after ownership restoration", () =>
    Effect.gen(function*() {
      // Recovery's rollback runs external handlers and a jj restore while it
      // holds the run, so the lease has to be renewed for exactly as long as it
      // does and no longer. The clock is virtual, so this is a fact about the
      // protocol rather than a race against wall time.
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("compensated", compensation))
      const pulses: Array<{ readonly runId: string; readonly owner: OwnerId }> = []
      const rolling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const runs = makeRuns({
        heartbeat: (runId, heartbeatOwner) =>
          Effect.sync(() => {
            pulses.push({ runId, owner: heartbeatOwner })
            return { _tag: "Updated" as const }
          })
      })
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ value: "sent" }),
          rollback: () => Deferred.succeed(rolling, undefined).pipe(Effect.andThen(Deferred.await(release)))
        }])
      )

      const fiber = yield* Effect.forkChild(
        runRecovery(store, runs, Jj.makeNoop({ restore: () => Effect.void }), registry, true),
        { startImmediately: true }
      )
      yield* Deferred.await(rolling)
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      expect(pulses).toEqual([{ runId: "run", owner }])
      yield* Deferred.succeed(release, undefined)
      const outcomes = yield* Fiber.join(fiber)

      expect(outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit-compensated" }])
      const afterReturn = pulses.length
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      expect(pulses).toHaveLength(afterReturn)
    }))

  it.effect("persists a rollback that finished after the heartbeat lost the fence", () =>
    Effect.gen(function*() {
      // The lease guard interrupts the body when the fence is lost, but a
      // rollback is atomic. Its non-idempotent fact must reach the audit before
      // that interrupt lands, or the next pass rolls the handlers back twice.
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("compensated", compensation))
      const rolling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const lost = yield* Deferred.make<void>()
      let rollbacks = 0
      const restores: Array<string> = []
      const runs = makeRuns({
        heartbeat: () => Deferred.succeed(lost, undefined).pipe(Effect.as({ _tag: "FenceLost" as const })),
        transitionOwned: () => Effect.succeed({ _tag: "FenceLost" as const })
      })
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ value: "sent" }),
          rollback: () =>
            Effect.sync(() => rollbacks++).pipe(
              Effect.andThen(Deferred.succeed(rolling, undefined)),
              Effect.andThen(Deferred.await(release))
            )
        }])
      )
      const jj = Jj.makeNoop({ restore: (changeId) => Effect.sync(() => void restores.push(changeId)) })

      const fiber = yield* Effect.forkChild(runRecovery(store, runs, jj, registry, true), { startImmediately: true })
      yield* Deferred.await(rolling)
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      yield* Deferred.await(lost)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      const outcomes = yield* Fiber.join(fiber)

      expect(outcomes[0]).toMatchObject({ _tag: "Busy", auditId: "audit-compensated" })
      expect(rollbacks).toBe(1)
      expect(restores).toEqual(["current"])
      expect(store.state().audits[0]!.status).toBe("in_progress")
      expect((store.state().audits[0]!.detail as AuditDetail).compensation).toBeUndefined()
    }))

  it.effect("lets ownership restoration finish after intentional release stops the heartbeat", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("archive_committed"))
      const transitionEntered = yield* Deferred.make<void>()
      const releaseTransition = yield* Deferred.make<void>()
      const heartbeatLost = yield* Deferred.make<void>()
      const runs = makeRuns({
        heartbeat: () =>
          Deferred.succeed(heartbeatLost, undefined).pipe(
            Effect.as({ _tag: "FenceLost" as const })
          ),
        transitionOwned: () =>
          Deferred.succeed(transitionEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseTransition)),
            Effect.as({ _tag: "Transitioned" as const })
          )
      })
      const fiber = yield* Effect.forkChild(
        runRecovery(store, runs, Jj.makeNoop({}), EffectHandlerRegistry.makeNoop(), false),
        { startImmediately: true }
      )

      yield* Deferred.await(transitionEntered)
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      yield* Deferred.await(heartbeatLost)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseTransition, undefined)
      const outcomes = yield* Fiber.join(fiber)

      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit-archive_committed" }])
      expect(store.state().audits[0]).toMatchObject({ status: "completed" })
    }))

  it.effect("fails owned recovery work when the heartbeat loses its fence", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("archive_committed"))
      const entered = yield* Deferred.make<void>()
      const lost = yield* Deferred.make<void>()
      const blockingStore = {
        ...store,
        stateAt: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      }
      const runs = makeRuns({
        heartbeat: () =>
          Deferred.succeed(lost, undefined).pipe(
            Effect.as({ _tag: "FenceLost" as const })
          )
      })
      const program = Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined) }).pipe(
        Effect.provide(Layer.succeed(TimeTravelStore, blockingStore)),
        Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
        Effect.provide(Layer.succeed(Journal.Journal, journal(false))),
        Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
        Effect.provide(
          Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, EffectHandlerRegistry.makeNoop())
        )
      )
      const fiber = yield* Effect.forkChild(program, { startImmediately: true })

      yield* Deferred.await(entered)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      yield* Effect.yieldNow
      yield* Deferred.await(lost)
      const outcomes = yield* Fiber.join(fiber)

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "fence_lost", message: "run run lost its ownership lease" }
      })
      expect(runs.state()).toMatchObject({ status: "suspended", owner: null })
      expect(store.state().audits[0]).toMatchObject({
        status: "failed",
        detail: { phase: "terminal_failure" }
      })
    }))

  it.effect("isolates malformed audits so one terminal failure does not block later recovery", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, {
        id: "audit-malformed",
        runId: "run",
        frame,
        status: "in_progress",
        detail: { version: 2 }
      })
      seed(store, { ...audit("archive_committed"), id: "audit-good" })
      const runs = makeRuns()

      const outcomes = yield* runRecovery(
        store,
        runs,
        Jj.makeNoop({ restore: () => Effect.void }),
        EffectHandlerRegistry.makeNoop(),
        false
      )

      expect(outcomes).toEqual([
        expect.objectContaining({ _tag: "Failed", auditId: "audit-malformed" }),
        { _tag: "Completed", auditId: "audit-good" }
      ])
      expect(store.state().audits.map((item) => ({ id: item.id, status: item.status }))).toEqual([
        { id: "audit-malformed", status: "failed" },
        { id: "audit-good", status: "completed" }
      ])
    }))

  it.effect("does not release ownership twice when persisting the rollback audit fails", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      const value = audit("compensated")
      seed(store, value)
      const baseRuns = makeRuns()
      let releases = 0
      const runs = makeRuns({
        transitionOwned: (...args) => {
          releases++
          return baseRuns.transitionOwned(...args)
        }
      })
      let refused = false
      const failing = {
        ...store,
        updateAudit: (id: string, patch: Parameters<typeof store.updateAudit>[1]) => {
          if (!refused && patch.status === "failed") {
            refused = true
            return Effect.fail(error("unknown", "audit write unavailable"))
          }
          return store.updateAudit(id, patch)
        }
      }
      yield* runRecovery(failing, runs, Jj.makeNoop({}), EffectHandlerRegistry.makeNoop(), true)
      expect(refused).toBe(true)
      expect(releases).toBe(1)
      expect(baseRuns.state()).toMatchObject({ status: "suspended", owner: null })
    }))

  it.effect("propagates a pending-audit persistence failure before touching run ownership", () =>
    Effect.gen(function*() {
      let reads = 0
      const failure = yield* (
        Effect.flip(
          Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined) }).pipe(
            Effect.provide(
              Layer.succeed(
                TimeTravelStore,
                TimeTravelStore.of({
                  ...MemoryTimeTravelStore.make(),
                  pendingAudits: () => Effect.fail(error("unknown", "audit store unavailable"))
                })
              )
            ),
            Effect.provide(
              Layer.succeed(
                RunStore.RunStore,
                RunStore.makeNoop({
                  get: () =>
                    Effect.sync(() => {
                      reads += 1
                      return makeRuns().state()
                    })
                })
              )
            ),
            Effect.provide(Layer.succeed(Journal.Journal, journal(false))),
            Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
            Effect.provide(
              Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, EffectHandlerRegistry.makeNoop())
            )
          )
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "audit store unavailable" })
      expect(reads).toBe(0)
    }))

  it.effect("finishes the atomic recovery transition when interrupted mid-protocol", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("archive_committed"))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(makeRuns().state()),
        transitionOwned: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ _tag: "Transitioned" as const })
          )
      })
      const program = Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined) }).pipe(
        Effect.provide(Layer.succeed(TimeTravelStore, store)),
        Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
        Effect.provide(Layer.succeed(Journal.Journal, journal(false))),
        Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
        Effect.provide(
          Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, EffectHandlerRegistry.makeNoop())
        )
      )
      const fiber = yield* Effect.forkChild(program, { startImmediately: true })

      yield* (Deferred.await(entered))
      const interrupt = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true })
      yield* (Deferred.succeed(release, undefined))
      yield* (Fiber.join(interrupt))
      const exit = yield* (Fiber.await(fiber))

      expect(exit._tag).toBe("Failure")
      expect(store.state().audits).toMatchObject([
        { id: "audit-archive_committed", status: "completed", detail: { phase: "completed" } }
      ])
    }))
})
