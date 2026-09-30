import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { RunStore } from "@smthrs/run-store"
import * as Ownership from "@smthrs/run-store/Ownership"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import { CacheStore } from "@smthrs/step-cache"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import type { LineageEdge } from "../src/Frame.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"
import { journalOf, makeRuns, row as makeRow } from "./MemoryHarness.ts"

const owner: OwnerId = { hostId: "test-host", pid: 10, nonce: "rewind-owner" }
const frame = { lineageId: "run/root", seq: 0 } as const

const row = (
  runId: string,
  status: RunStore.RunStatus = "suspended"
): RunStore.RunRow =>
  makeRow({
    runId,
    status,
    owner: status === "running" ? { hostId: "child-host", pid: 11, nonce: "child-owner" } : null,
    heartbeatAtMs: status === "running" ? 0 : null,
    stateJson: "{\"cursor\":5}"
  })

const boundaryRecord = (
  seq: number,
  effect: Omit<EffectBoundary.EffectRecord, "seq">
): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq,
  eventId: `event-${seq}`,
  lineageId: "run/root",
  payload: {
    eventType: EffectBoundary.eventType,
    payload: { version: 1, effect },
    meta: { lineageId: "run/root" }
  }
})

const baseline = (): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq: 0,
  eventId: "event-0",
  lineageId: "run/root",
  payload: {
    eventType: "baseline",
    payload: {},
    meta: { lineageId: "run/root" }
  }
})

const journalEntry = (seq: number): JournalEvent.Entry => ({
  runId: "run" as JournalEvent.RunId,
  seq: seq as JournalEvent.Seq,
  eventId: `event-${seq}`,
  sourceId: "test" as JournalEvent.SourceId,
  sourceSeq: seq as JournalEvent.SourceSeq,
  emittedAtMs: seq,
  eventType: "baseline",
  payload: {},
  meta: { lineageId: frame.lineageId }
})

const effect = (
  id: string,
  kind: string,
  tier: EffectBoundary.EffectTier,
  status: EffectBoundary.EffectStatus = "succeeded"
): Omit<EffectBoundary.EffectRecord, "seq"> => ({
  id,
  kind,
  tier,
  status,
  runId: "run",
  lineageId: "run/root",
  ...(tier === "compensable" ? { changeId: "target" } : {}),
  // `guard` never records an irreversible effect without a key, and the
  // handlers these cases register require one.
  ...(tier === "irreversible" ? { idempotencyKey: `${id}-key` } : {}),
  durableBoundary: true,
  providerStream: false
})

const makeJj = (initial: string) => {
  let pointer = initial
  const service = Jj.makeNoop({
    snapshot: () => Effect.succeed({ commitId: pointer, changeId: pointer }),
    restore: (changeId) =>
      Effect.sync(() => {
        pointer = changeId
      })
  })
  return { service, pointer: () => pointer }
}

const provide = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options: {
    readonly store: ReturnType<typeof MemoryTimeTravelStore.make>
    readonly runs: RunStore.Service
    readonly jj: Jj.Jj
    readonly handlers?: ReadonlyArray<EffectHandlerRegistry.Handler>
    readonly journal?: Journal.Service
  }
) =>
  program.pipe(
    Effect.provide(Layer.succeed(TimeTravelStore, options.store)),
    Effect.provide(Layer.succeed(RunStore.RunStore, options.runs)),
    Effect.provide(Layer.succeed(Journal.Journal, options.journal ?? journalOf(options.store))),
    Effect.provide(CacheStore.layerNoop({
      get: () => Effect.succeed(Option.none())
    })),
    Effect.provide(Layer.succeed(Jj.Jj, options.jj)),
    Effect.provide(
      Layer.succeed(
        EffectHandlerRegistry.EffectHandlerRegistry,
        Effect.runSync(EffectHandlerRegistry.make(options.handlers ?? []))
      )
    )
  )

describe("Rewind", () => {
  it.effect("rejects an empty validation continuation page", () =>
    Effect.gen(function*() {
      let pages = 0
      const failure = yield* Effect.flip(
        Rewind.validate({ runId: "run", frame }).pipe(
          Effect.provideService(
            Journal.Journal,
            Journal.makeNoop({
              entries: () =>
                Effect.sync(() =>
                  pages++ === 0
                    ? { entries: [journalEntry(0)], hasMore: true }
                    : { entries: [], hasMore: true }
                )
            })
          )
        )
      )

      expect(failure).toMatchObject({
        code: "invalid",
        message: "journal validation returned an empty continuation page for run"
      })
    }))

  it.effect("fails a repeated frame-validation page instead of spinning", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Rewind.validate({ runId: "run", frame }).pipe(
          Effect.provideService(
            Journal.Journal,
            Journal.makeNoop({ entries: () => Effect.succeed({ entries: [journalEntry(0)], hasMore: true }) })
          )
        )
      )

      expect(failure).toMatchObject({
        code: "invalid",
        message: "journal validation pagination did not advance for run"
      })
    }))

  it.effect("fails a repeated suffix page instead of spinning", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [baseline()] })
      const failure = yield* Effect.flip(provide(
        Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-repeated-suffix" }),
        {
          store,
          runs: makeRuns([row("run")]),
          jj: makeJj("current").service,
          journal: Journal.makeNoop({
            entries: ({ after }) =>
              Effect.succeed(
                after === undefined
                  ? { entries: [journalEntry(0)], hasMore: false }
                  : { entries: [journalEntry(1)], hasMore: true }
              )
          })
        }
      ))

      expect(failure).toMatchObject({
        code: "invalid",
        message: "journal suffix pagination did not advance for run"
      })
    }))

  it.effect("compensates in reverse order, restores jj, archives the suffix, and suspends the run", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const external = ["first", "second"]
      const handler: EffectHandlerRegistry.Handler = {
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "message remains delivered until compensation succeeds",
        revert: (crossed) =>
          Effect.sync(() => {
            calls.push(crossed.id)
            return external.pop()
          }),
        rollback: (_crossed, receipt) =>
          Effect.sync(() => {
            external.push(String(receipt))
          })
      }
      const records = [
        baseline(),
        boundaryRecord(1, effect("send-1", "send", "irreversible")),
        boundaryRecord(2, effect("send-2", "send", "irreversible")),
        boundaryRecord(3, effect("workspace", "fs-write", "compensable"))
      ]
      const store = MemoryTimeTravelStore.make({
        records,
        snapshots: [{ runId: "run", frame, changeId: "target" }]
      })
      const runs = makeRuns([row("run")])
      const jj = makeJj("current")

      const result = yield* (
        provide(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-happy" }),
          { store, runs, jj: jj.service, handlers: [handler] }
        )
      )

      expect(calls).toEqual(["send-2", "send-1"])
      expect(external).toEqual([])
      expect(jj.pointer()).toBe("target")
      expect(store.state().records.map((record) => record.seq)).toEqual([0])
      expect(store.state().archived.map((record) => record.seq)).toEqual([1, 2, 3])
      expect(store.state().receipts).toHaveLength(2)
      expect(store.state().audits).toMatchObject([{ id: "audit-happy", status: "completed" }])
      expect(runs.state("run")).toMatchObject({ status: "suspended", owner: null, stateJson: "{\"cursor\":5}" })
      expect(result.archive.archived).toBe(3)
    }))

  it.effect("discloses a terminal detached child as an orphan warning", () =>
    Effect.gen(function*() {
      const edge: LineageEdge = {
        parentRunId: "run",
        parentSeq: 1,
        childRunId: "child",
        kind: "child",
        attached: false
      }
      const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })
      const runs = makeRuns([row("run"), row("child", "completed")])
      const jj = makeJj("current")

      const result = yield* (
        provide(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-terminal" }),
          { store, runs, jj: jj.service }
        )
      )

      expect(result.warnings).toEqual([
        expect.objectContaining({ childRunId: "child", parentSeq: 1 })
      ])
      expect(result.archive.orphaned).toEqual([edge])
      expect(runs.state("child").status).toBe("completed")
    }))

  it.effect("preserves failed and cancelled detached children as disclosed terminal orphans", () =>
    Effect.gen(function*() {
      for (const status of ["failed", "cancelled"] as const) {
        const edge: LineageEdge = {
          parentRunId: "run",
          parentSeq: 1,
          childRunId: `child-${status}`,
          kind: "child",
          attached: false
        }
        const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })
        const runs = makeRuns([row("run"), row(edge.childRunId, status)])

        const result = yield* (
          provide(
            Rewind.rewind({ runId: "run", frame, owner, auditId: `audit-${status}` }),
            { store, runs, jj: makeJj("current").service }
          )
        )

        expect(result.warnings).toEqual([
          {
            childRunId: edge.childRunId,
            parentSeq: 1,
            reason: `Terminal detached child ${edge.childRunId} survives as an orphaned lineage edge.`
          }
        ])
        expect(result.archive.orphaned).toEqual([edge])
        expect(runs.state(edge.childRunId).status).toBe(status)
      }
    }))

  it.effect("blocks a live detached child before any compensation runs", () =>
    Effect.gen(function*() {
      let reverts = 0
      const handler: EffectHandlerRegistry.Handler = {
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "message remains sent",
        revert: () =>
          Effect.sync(() => {
            reverts += 1
            return "receipt"
          }),
        rollback: () => Effect.void
      }
      const edge: LineageEdge = {
        parentRunId: "run",
        parentSeq: 1,
        childRunId: "child",
        kind: "child",
        attached: false
      }
      const store = MemoryTimeTravelStore.make({
        records: [baseline(), boundaryRecord(1, effect("send", "send", "irreversible"))],
        edges: [edge]
      })
      const runs = makeRuns([row("run"), row("child", "running")])
      const jj = makeJj("current")

      const failure = yield* (
        Effect.flip(
          provide(
            Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-live" }),
            { store, runs, jj: jj.service, handlers: [handler] }
          )
        )
      )

      expect(failure.code).toBe("live_child")
      expect(reverts).toBe(0)
      expect(store.state().records).toHaveLength(2)
      expect(runs.state("run").status).toBe("suspended")
    }))

  it.effect("claims and cancels a nonterminal detached child under explicit cancel policy", () =>
    Effect.gen(function*() {
      const edges: ReadonlyArray<LineageEdge> = [
        { parentRunId: "run", parentSeq: 1, childRunId: "child-a", kind: "child", attached: false },
        { parentRunId: "run", parentSeq: 2, childRunId: "child-b", kind: "child", attached: false }
      ]
      const store = MemoryTimeTravelStore.make({ records: [baseline()], edges })
      const runs = makeRuns([row("run"), row("child-a", "suspended"), row("child-b", "suspended")])
      const jj = makeJj("current")

      const result = yield* (
        provide(
          Rewind.rewind({
            runId: "run",
            frame,
            owner,
            auditId: "audit-cancel",
            detachedChildPolicy: "cancel"
          }),
          { store, runs, jj: jj.service }
        )
      )

      expect(result.cancelledChildren).toEqual(["child-b", "child-a"])
      expect(runs.state("child-a")).toMatchObject({ status: "cancelled", owner: null })
      expect(runs.state("child-b")).toMatchObject({ status: "cancelled", owner: null })
    }))

  it.effect("blocks a live attached child before archiving or advancing preflight", () =>
    Effect.gen(function*() {
      const edge: LineageEdge = {
        parentRunId: "run",
        parentSeq: 1,
        childRunId: "attached-child",
        kind: "child",
        attached: true
      }
      const store = MemoryTimeTravelStore.make({
        records: [baseline(), { ...baseline(), runId: edge.childRunId, eventId: "child-0" }],
        edges: [edge]
      })
      const runs = makeRuns([row("run"), row(edge.childRunId, "suspended")])

      const failure = yield* Effect.flip(provide(
        Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-attached-block" }),
        { store, runs, jj: makeJj("current").service }
      ))

      expect(failure).toMatchObject({
        code: "live_child",
        message: "live attached child attached-child blocks rewind"
      })
      expect(store.state().archived).toEqual([])
      expect(store.state().records).toHaveLength(2)
      expect(store.state().audits[0]).toMatchObject({
        status: "failed",
        detail: { suffixCount: 0 }
      })
    }))

  it.effect("cancels an attached child once even when duplicate edge evidence also calls it detached", () =>
    Effect.gen(function*() {
      const attached: LineageEdge = {
        parentRunId: "run",
        parentSeq: 2,
        childRunId: "shared-child",
        kind: "child",
        attached: true
      }
      const detached: LineageEdge = { ...attached, parentSeq: 1, attached: false }
      const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [attached, detached] })
      const runs = makeRuns([row("run"), row(attached.childRunId, "suspended")])

      const result = yield* provide(
        Rewind.rewind({
          runId: "run",
          frame,
          owner,
          auditId: "audit-attached-cancel",
          detachedChildPolicy: "cancel"
        }),
        { store, runs, jj: makeJj("current").service }
      )

      expect(result.cancelledChildren).toEqual([attached.childRunId])
      expect(runs.state(attached.childRunId)).toMatchObject({ status: "cancelled", owner: null })
    }))

  it.effect("warns when a terminal attached child's journal is archived with its parent", () =>
    Effect.gen(function*() {
      const edge: LineageEdge = {
        parentRunId: "run",
        parentSeq: 1,
        childRunId: "terminal-attached",
        kind: "child",
        attached: true
      }
      const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })
      const runs = makeRuns([row("run"), row(edge.childRunId, "completed")])

      const result = yield* provide(
        Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-attached-terminal" }),
        { store, runs, jj: makeJj("current").service }
      )

      expect(result.warnings).toEqual([{
        childRunId: edge.childRunId,
        parentSeq: edge.parentSeq,
        reason: `Terminal attached child ${edge.childRunId} had its journal archived with parent run.`
      }])
      expect(result.archive.archived).toBe(0)
    }))

  it.effect("propagates child persistence failures instead of calling them missing evidence", () =>
    Effect.gen(function*() {
      const edge: LineageEdge = {
        parentRunId: "run",
        parentSeq: 1,
        childRunId: "unreadable-child",
        kind: "child",
        attached: false
      }
      const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })
      const base = makeRuns([row("run"), row(edge.childRunId, "completed")])
      const persistenceFailure = new RunStore.RunStoreError({
        code: "persistence_failed",
        method: "get",
        message: "database offline",
        cause: "database offline"
      })
      const runs = RunStore.makeNoop({
        ...base,
        get: (runId) => runId === edge.childRunId ? Effect.fail(persistenceFailure) : base.get(runId)
      })

      const failure = yield* Effect.flip(provide(
        Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-child-read" }),
        { store, runs, jj: makeJj("current").service }
      ))

      expect(failure).toMatchObject({
        code: "unknown",
        message: "read detached child unreadable-child failed"
      })
      expect(JSON.stringify(failure.cause)).toContain("database offline")
      expect(store.state().archived).toEqual([])
    }))

  it.effect("keeps blocking-effect payloads out of the encoded error cause", () =>
    Effect.gen(function*() {
      const marker = "SECRET-RAW-EFFECT-PAYLOAD"
      const store = MemoryTimeTravelStore.make({
        records: [
          baseline(),
          boundaryRecord(1, { ...effect("blocked-effect", "missing-handler", "irreversible"), input: { marker } })
        ]
      })

      const failure = yield* Effect.flip(provide(
        Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-redacted-cause" }),
        { store, runs: makeRuns([row("run")]), jj: makeJj("current").service }
      ))
      const encoded = JSON.stringify(failure.cause)

      expect(failure.code).toBe("irreversible")
      expect(encoded).not.toContain(marker)
      expect(encoded).toContain("blocked-effect")
      expect(encoded).toContain("missing-handler")
    }))

  it.effect("revalidates the journal tail after claiming and refuses a moved tail", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [baseline(), { ...baseline(), seq: 1, eventId: "event-1" }]
      })
      let scans = 0
      const journal = Journal.makeNoop({
        entries: ({ after }) =>
          Effect.sync(() => {
            if (after !== undefined) {
              return { entries: [journalEntry(1), journalEntry(2)], hasMore: false }
            }
            scans += 1
            return scans === 1
              ? { entries: [journalEntry(0), journalEntry(1)], hasMore: false }
              : { entries: [journalEntry(0), journalEntry(1), journalEntry(2)], hasMore: false }
          })
      })

      const failure = yield* Effect.flip(provide(
        Rewind.validate({ runId: "run", frame }).pipe(
          Effect.flatMap((expectedTail) =>
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: "audit-tail-moved",
              expectedTail
            })
          )
        ),
        { store, runs: makeRuns([row("run")]), jj: makeJj("current").service, journal }
      ))

      expect(failure).toMatchObject({ code: "busy", message: "journal tail moved for run" })
      expect(store.state().audits).toEqual([])
      expect(store.state().archived).toEqual([])
    }))

  it.effect("revalidates the tail under the claim from one page at the expected tail, never a rescan", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [baseline(), { ...baseline(), seq: 1, eventId: "event-1" }, {
          ...baseline(),
          seq: 2,
          eventId: "event-2"
        }]
      })
      const reads: Array<{ readonly after: number | undefined; readonly limit: number }> = []
      const journal = Journal.makeNoop({
        entries: ({ after, limit }) =>
          Effect.sync(() => {
            reads.push({ after, limit })
            const entries = [journalEntry(0), journalEntry(1), journalEntry(2)].filter((entry) =>
              entry.seq > (after ?? -1)
            )
            return { entries: entries.slice(0, limit), hasMore: entries.length > limit }
          })
      })
      const tailFrame = { lineageId: "run/root", seq: 2 } as const

      const result = yield* provide(
        Rewind.validate({ runId: "run", frame: tailFrame }).pipe(
          Effect.tap(() => Effect.sync(() => void (reads.length = 0))),
          Effect.flatMap((expectedTail) =>
            Rewind.rewind({
              runId: "run",
              frame: tailFrame,
              owner,
              auditId: "audit-tail-revalidated",
              expectedTail
            })
          )
        ),
        { store, runs: makeRuns([row("run")]), jj: makeJj("current").service, journal }
      )

      expect(result.frame).toEqual(tailFrame)
      // The revalidation is the first read under the claim: one page at the
      // expected tail. Nothing under the claim reads the journal from its start.
      expect(reads[0]).toEqual({ after: 1, limit: 2 })
      expect(reads.filter((read) => read.after === undefined)).toEqual([])
    }))

  it.effect("refuses a rewritten tail whose seq validation already observed", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [baseline(), { ...baseline(), seq: 1, eventId: "event-1" }]
      })
      let validated = false
      const journal = Journal.makeNoop({
        entries: ({ after }) =>
          Effect.sync(() => {
            // After validation, seq 1 belongs to another lineage: a peer
            // rewound below it and the run re-appended up to the same seq.
            const entries = validated
              ? [journalEntry(0), { ...journalEntry(1), meta: { lineageId: "run/other" } }]
              : [journalEntry(0), journalEntry(1)]
            return { entries: entries.filter((entry) => entry.seq > (after ?? -1)), hasMore: false }
          })
      })

      const failure = yield* Effect.flip(provide(
        Rewind.validate({ runId: "run", frame }).pipe(
          Effect.tap(() => Effect.sync(() => void (validated = true))),
          Effect.flatMap((expectedTail) =>
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: "audit-tail-rewritten",
              expectedTail
            })
          )
        ),
        { store, runs: makeRuns([row("run")]), jj: makeJj("current").service, journal }
      ))

      expect(failure).toMatchObject({ code: "busy", message: "journal tail moved for run" })
      expect(store.state().archived).toEqual([])
    }))

  it.effect("refuses a record appended after validating an empty frame-zero journal", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      const entries: Array<JournalEvent.Entry> = []
      const journal = Journal.makeNoop({
        entries: ({ after }) =>
          Effect.sync(() => ({
            entries: entries.filter((entry) => entry.seq > (after ?? -1)),
            hasMore: false
          }))
      })

      const failure = yield* Effect.flip(provide(
        Rewind.validate({ runId: "run", frame }).pipe(
          Effect.flatMap((expectedTail) =>
            Effect.sync(() => entries.push(journalEntry(0))).pipe(
              Effect.andThen(
                Rewind.rewind({
                  runId: "run",
                  frame,
                  owner,
                  auditId: "audit-empty-tail-moved",
                  expectedTail
                })
              )
            )
          )
        ),
        { store, runs: makeRuns([row("run")]), jj: makeJj("current").service, journal }
      ))

      expect(failure).toMatchObject({ code: "busy", message: "journal tail moved for run" })
      expect(store.state().audits).toEqual([])
    }))

  it.effect("suspends with state derived at the rewind frame", () =>
    Effect.gen(function*() {
      const decision = (seq: number, cursor: number): MemoryTimeTravelStore.JournalRecord => ({
        runId: "run",
        seq,
        eventId: `decision-${seq}`,
        lineageId: frame.lineageId,
        eventType: "flows.engine.run-decision",
        payload: { state: { cursor } }
      })
      const store = MemoryTimeTravelStore.make({ records: [decision(1, 1), decision(5, 5)] })
      const runs = makeRuns([row("run")])

      yield* provide(
        Rewind.rewind({
          runId: "run",
          frame: { ...frame, seq: 1 },
          owner,
          auditId: "audit-frame-state"
        }),
        { store, runs, jj: makeJj("current").service }
      )

      expect(runs.state("run").stateJson).toBe("{\"cursor\":1}")
    }))

  it.effect("heartbeats while stalled and stops heartbeating after rewind returns", () =>
    Effect.gen(function*() {
      // The lease is what stops a co-located engine sweeping this run as stale
      // while a compensation handler is still running, so the assertion is that
      // a pulse lands DURING the protocol and none lands after it returns. The
      // clock is virtual: a real sleep would make the test a race.
      const pulses: Array<{ readonly runId: string; readonly owner: OwnerId }> = []
      const stalled = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const runs = makeRuns([row("run")], {
        heartbeat: (runId, heartbeatOwner) =>
          Effect.sync(() => {
            pulses.push({ runId, owner: heartbeatOwner })
            return { _tag: "Updated" as const }
          })
      })
      const store = MemoryTimeTravelStore.make({ records: [baseline()] })

      const fiber = yield* Effect.forkChild(
        provide(
          Rewind.rewind({
            runId: "run",
            frame,
            owner,
            auditId: "audit-heartbeat",
            hooks: {
              beforeStep: (step) =>
                step === "compensate-effects"
                  ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Deferred.await(release)))
                  : Effect.void
            }
          }),
          { store, runs, jj: makeJj("current").service }
        ),
        { startImmediately: true }
      )

      yield* Deferred.await(stalled)
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      expect(pulses).toEqual([{ runId: "run", owner }])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)

      const afterReturn = pulses.length
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      expect(pulses).toHaveLength(afterReturn)
    }))

  it.effect("lets the fenced suspension finish after intentional lease release stops the heartbeat", () =>
    Effect.gen(function*() {
      const transitionEntered = yield* Deferred.make<void>()
      const releaseTransition = yield* Deferred.make<void>()
      const heartbeatLost = yield* Deferred.make<void>()
      const runs = makeRuns([row("run")], {
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
      const store = MemoryTimeTravelStore.make({ records: [baseline()] })
      const fiber = yield* Effect.forkChild(
        provide(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-intentional-release" }),
          { store, runs, jj: makeJj("current").service }
        ),
        { startImmediately: true }
      )

      yield* Deferred.await(transitionEntered)
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      yield* Deferred.await(heartbeatLost)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseTransition, undefined)
      const result = yield* Fiber.join(fiber)

      expect(result.auditId).toBe("audit-intentional-release")
      expect(store.state().audits[0]).toMatchObject({ status: "completed" })
    }))

  it.effect("persists every still-pending child when post-commit cancellation fails", () =>
    Effect.gen(function*() {
      const edge: LineageEdge = {
        parentRunId: "run",
        parentSeq: 1,
        childRunId: "pending-child",
        kind: "child",
        attached: false
      }
      const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })
      const base = makeRuns([row("run"), row(edge.childRunId, "suspended")])
      const cancellationFailure = new RunStore.RunStoreError({
        code: "persistence_failed",
        method: "transitionOwned",
        message: "child cancellation write failed",
        cause: "child cancellation write failed"
      })
      const runs = RunStore.makeNoop({
        ...base,
        transitionOwned: (runId, ...args) =>
          runId === edge.childRunId
            ? Effect.fail(cancellationFailure)
            : base.transitionOwned(runId, ...args)
      })

      const failure = yield* Effect.flip(provide(
        Rewind.rewind({
          runId: "run",
          frame,
          owner,
          auditId: "audit-pending-child",
          detachedChildPolicy: "cancel"
        }),
        { store, runs, jj: makeJj("current").service }
      ))

      expect(failure.message).toBe("cancel child pending-child failed")
      expect(store.state().audits[0]).toMatchObject({
        status: "in_progress",
        detail: { phase: "archive_committed", pendingChildren: [edge.childRunId] }
      })
    }))

  it.effect("leaves detached children unchanged when rewind fails before the archive commit", () =>
    Effect.gen(function*() {
      const edge: LineageEdge = {
        parentRunId: "run",
        parentSeq: 1,
        childRunId: "child",
        kind: "child",
        attached: false
      }
      const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })
      const runs = makeRuns([row("run"), row("child", "suspended")])
      const jj = makeJj("current")

      const failure = yield* (
        Effect.flip(
          provide(
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: "audit-rollback-cancelled",
              detachedChildPolicy: "cancel",
              hooks: {
                beforeStep: (step) =>
                  step === "compensate-effects"
                    ? Effect.fail(new Error("injected compensate-effects"))
                    : Effect.void
              }
            }),
            { store, runs, jj: jj.service }
          )
        )
      )

      expect(failure.code).toBe("unknown")
      expect(runs.state("run").status).toBe("suspended")
      expect(runs.state("child").status).toBe("suspended")
      const audit = store.state().audits.at(-1)!
      expect(audit.status).toBe("failed")
      const detail = audit.detail as Rewind.AuditDetail
      expect(detail.phase).toBe("rolled_back")
      expect(detail.cancelledChildren).toEqual([])
    }))

  it.effect("does not cancel any detached child when workspace restoration rolls back", () =>
    Effect.gen(function*() {
      const edges: ReadonlyArray<LineageEdge> = [
        { parentRunId: "run", parentSeq: 1, childRunId: "child-a", kind: "child", attached: false },
        { parentRunId: "run", parentSeq: 2, childRunId: "child-b", kind: "child", attached: false }
      ]
      const store = MemoryTimeTravelStore.make({ records: [baseline()], edges: [...edges] })
      const runs = makeRuns([row("run"), row("child-a", "suspended"), row("child-b", "suspended")])
      const jj = makeJj("current")

      yield* (
        Effect.flip(
          provide(
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: "audit-cancel-order",
              detachedChildPolicy: "cancel",
              hooks: {
                beforeStep: (step) =>
                  step === "restore-workspace"
                    ? Effect.fail(new Error("injected restore-workspace"))
                    : Effect.void
              }
            }),
            { store, runs, jj: jj.service }
          )
        )
      )

      expect(runs.state("child-a").status).toBe("suspended")
      expect(runs.state("child-b").status).toBe("suspended")
      const detail = store.state().audits.at(-1)!.detail as Rewind.AuditDetail
      expect(detail.cancelledChildren).toEqual([])
      expect(detail.phase).toBe("rolled_back")
    }))

  it.effect("resolves the full suffix before running any handler", () =>
    Effect.gen(function*() {
      let reverts = 0
      const handler: EffectHandlerRegistry.Handler = {
        kind: "known",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "known residue",
        revert: () =>
          Effect.sync(() => {
            reverts += 1
            return "receipt"
          }),
        rollback: () => Effect.void
      }
      const store = MemoryTimeTravelStore.make({
        records: [
          baseline(),
          boundaryRecord(1, effect("known", "known", "irreversible")),
          boundaryRecord(2, effect("missing", "missing", "irreversible"))
        ]
      })
      const runs = makeRuns([row("run")])
      const jj = makeJj("current")

      const failure = yield* (
        Effect.flip(
          provide(
            Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-blocked" }),
            { store, runs, jj: jj.service, handlers: [handler] }
          )
        )
      )

      expect(failure.code).toBe("irreversible")
      expect(reverts).toBe(0)
      expect(store.state().records.map((record) => record.seq)).toEqual([0, 1, 2])
      expect(store.state().receipts).toEqual([])
      expect(runs.state("run").status).toBe("suspended")
    }))
})
