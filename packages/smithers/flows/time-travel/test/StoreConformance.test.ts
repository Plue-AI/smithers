import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { forkCreatedEventType, type LineageEdge } from "../src/Frame.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravelError } from "../src/TimeTravelError.ts"
import type * as TimeTravelStore from "../src/TimeTravelStore.ts"

const owner = { hostId: "owner-host", pid: 10, nonce: "owner-nonce" } as const
const stranger = { hostId: "stranger-host", pid: 11, nonce: "stranger-nonce" } as const
const frame = { lineageId: "run/root", seq: 1 } as const

const memorySeed = () =>
  MemoryTimeTravelStore.make({
    records: [
      {
        runId: "run",
        seq: 0,
        eventId: "run-0",
        payload: { state: { version: 1, flowName: "Demo", payload: { at: 0 } } },
        eventType: "flows.engine.run-decision"
      },
      {
        runId: "run",
        seq: 1,
        eventId: "run-1",
        lineageId: "run/root",
        payload: { stepKeyDigest: "step", attempt: 1 },
        eventType: "flows.engine.attempt-started"
      },
      {
        runId: "run",
        seq: 2,
        eventId: "run-2",
        lineageId: "run/root",
        payload: {
          decision: "handed-off",
          nextExecutionId: "detached",
          state: { version: 1, flowName: "Demo", payload: { at: 2 } }
        },
        eventType: "flows.engine.run-decision"
      },
      { runId: "attached", seq: 0, eventId: "attached-0", payload: {} }
    ],
    edges: [
      { parentRunId: "run", parentSeq: 2, childRunId: "attached", kind: "child", attached: true },
      { parentRunId: "run", parentSeq: 2, childRunId: "detached", kind: "fork", attached: false },
      { parentRunId: "run", parentSeq: 2, childRunId: "detached", kind: "continuation", attached: false }
    ],
    snapshots: [{ runId: "run", frame: { lineageId: "run/root", seq: 0 }, changeId: "change-0" }],
    runOwners: new Map([["run", owner]])
  })

const seedSql = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* sql`
      INSERT INTO flows_runs
        (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
      VALUES (
        'run', 'running', 0,
        ${JSON.stringify({ version: 1, flowName: "Demo", payload: { at: 2 } })},
        ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0
      )
    `
    yield* sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES
        ('attached', 'completed', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })}),
        ('detached', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})
    `
    const events = [
      {
        seq: 0,
        type: "flows.engine.run-decision",
        payload: { state: { version: 1, flowName: "Demo", payload: { at: 0 } } },
        meta: {}
      },
      {
        seq: 1,
        type: "flows.engine.attempt-started",
        payload: { stepKeyDigest: "step", attempt: 1 },
        meta: { lineageId: "run/root" }
      },
      {
        seq: 2,
        type: "flows.engine.run-decision",
        payload: {
          decision: "handed-off",
          nextExecutionId: "detached",
          state: { version: 1, flowName: "Demo", payload: { at: 2 } }
        },
        meta: { lineageId: "run/root" }
      }
    ] as const
    for (const event of events) {
      yield* sql`
        INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
           event_type, payload_json, meta_json)
        VALUES (
          'run', ${event.seq}, ${`run-${event.seq}`}, 'source', ${event.seq}, 0,
          ${event.type}, ${JSON.stringify(event.payload)}, ${JSON.stringify(event.meta)}
        )
      `
    }
    yield* sql`
      INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
         event_type, payload_json, meta_json)
      VALUES ('attached', 0, 'attached-0', 'source', 0, 0, 'test', '{}', '{}')
    `
    yield* sql`
      INSERT INTO flows_time_travel_edges
        (parent_run_id, parent_seq, child_run_id, kind, attached)
      VALUES
        ('run', 2, 'attached', 'child', 1),
        ('run', 2, 'detached', 'fork', 0)
    `
    yield* sql`
      INSERT INTO flows_time_travel_snapshots
        (run_id, lineage_id, seq, change_id, plan_digest)
      VALUES ('run', 'run/root', 0, 'change-0', NULL)
    `
  })

const normalizeEdges = (edges: ReadonlyArray<LineageEdge>) =>
  edges.map((edge) => ({ ...edge })).sort((left, right) => left.childRunId.localeCompare(right.childRunId))

const observe = (store: TimeTravelStore.Service) =>
  Effect.gen(function*() {
    const snapshot = yield* store.snapshotAt("run", frame)
    const state = yield* store.stateAt("run", frame)
    const attempts = yield* store.attemptsAt("run", frame)
    const descendants = yield* store.descendants("run", frame)
    const archivedBefore = yield* store.archivedAt("run", 2)
    const refusal = yield* Effect.flip(store.archiveAndTruncate("run", frame, [], stranger))
    const archivedAfterRefusal = yield* store.archivedAt("run", 2)
    yield* store.archiveAndTruncate("run", frame, [], owner)
    const archivedAfter = yield* store.archivedAt("run", 2)
    return {
      snapshot,
      state,
      attempts,
      descendants: {
        attached: normalizeEdges(descendants.attached),
        detached: normalizeEdges(descendants.detached)
      },
      archivedBefore,
      refusal: { code: refusal.code, message: refusal.message },
      archivedAfterRefusal,
      archivedAfter
    }
  })

const withSql = <A>(
  body: (store: TimeTravelStore.Service, sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>
) =>
  Effect.gen(function*() {
    yield* EngineMigrations.run
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const store = yield* SqlTimeTravelStore.make
    return yield* body(store, sql)
  }).pipe(Effect.provide(TestDatabase.layer))

describe("TimeTravelStore conformance", () => {
  it.effect("answers frame reads, descendants, archive evidence, and owner fences identically", () =>
    Effect.gen(function*() {
      const memory = yield* observe(memorySeed())
      const sqlite = yield* withSql((store, sql) => seedSql(sql).pipe(Effect.andThen(observe(store))))

      expect(memory).toEqual(sqlite)
      expect(memory).toMatchObject({
        snapshot: { changeId: "change-0" },
        state: JSON.stringify({ version: 1, flowName: "Demo", payload: { at: 0 } }),
        attempts: [{ stepKeyDigest: "step", attempt: 1 }],
        descendants: {
          attached: [{ childRunId: "attached" }],
          detached: [{ childRunId: "detached" }]
        },
        archivedBefore: false,
        refusal: {
          code: "fence_lost",
          message: "run run is no longer owned by stranger-host:11:stranger-nonce"
        },
        archivedAfterRefusal: false,
        archivedAfter: true
      })
    }))

  it.effect("refuses a negative archive frame identically without changing history", () =>
    Effect.gen(function*() {
      const refuse = (store: TimeTravelStore.Service) =>
        Effect.gen(function*() {
          const before = yield* store.stateAt("run", { ...frame, seq: 2 })
          const exit = yield* Effect.exit(store.archiveAndTruncate("run", { ...frame, seq: -1 }, [], owner))
          return {
            failure: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
            before,
            after: yield* store.stateAt("run", { ...frame, seq: 2 }),
            archived: [yield* store.archivedAt("run", 0), yield* store.archivedAt("run", 2)]
          }
        })
      const memory = memorySeed()
      const before = memory.state()
      const memoryResult = yield* refuse(memory)
      const sqlResult = yield* withSql((store, sql) => seedSql(sql).pipe(Effect.andThen(refuse(store))))
      for (const result of [memoryResult, sqlResult]) {
        expect(result.failure).toMatchObject({ code: "invalid", message: "invalid archive frame" })
        expect(result.after).toEqual(result.before)
        expect(result.archived).toEqual([false, false])
      }
      expect(memory.state()).toEqual(before)
    }))

  // `stranger` differs from `owner` in all three fields, so it cannot tell
  // which comparisons the fence actually makes. Each of these differs in
  // exactly one, which is what pins hostId, pid, and nonce individually.
  for (
    const { field, rival } of [
      { field: "hostId", rival: { ...owner, hostId: "rival-host" } },
      { field: "pid", rival: { ...owner, pid: owner.pid + 1 } },
      { field: "nonce", rival: { ...owner, nonce: "rival-nonce" } }
    ]
  ) {
    it.effect(`refuses a parent fence differing only in ${field}`, () =>
      Effect.gen(function*() {
        const refuse = (store: TimeTravelStore.Service) =>
          Effect.gen(function*() {
            const failure = yield* Effect.flip(store.archiveAndTruncate("run", frame, [], rival))
            return {
              failure: { code: failure.code, message: failure.message },
              archived: yield* store.archivedAt("run", 2)
            }
          })
        const memory = yield* refuse(memorySeed())
        const sqlite = yield* withSql((store, sql) => seedSql(sql).pipe(Effect.andThen(refuse(store))))

        expect(memory).toEqual(sqlite)
        expect(memory).toEqual({
          failure: {
            code: "fence_lost",
            message: `run run is no longer owned by ${rival.hostId}:${rival.pid}:${rival.nonce}`
          },
          archived: false
        })
      }))
  }

  it.effect("retains both generations after truncating, re-appending, and truncating", () =>
    Effect.gen(function*() {
      const zero = { ...frame, seq: 0 }
      const exercise = (store: TimeTravelStore.Service, append: (parent: string) => Effect.Effect<unknown, unknown>) =>
        Effect.gen(function*() {
          yield* append("original")
          const first = yield* store.archiveAndTruncate("run", zero, [], owner)
          yield* append("replacement")
          const second = yield* store.archiveAndTruncate("run", zero, [], owner)
          return [first.archived, second.archived]
        })
      const memory = MemoryTimeTravelStore.make({
        records: [{ runId: "run", seq: 0, eventId: "baseline", payload: {} }],
        runOwners: new Map([["run", owner]])
      })
      // Fork markers are the memory store's journal append path. Empty donor
      // runs copy no prefix and append one marker at the reused seq 1.
      const memoryCounts = yield* exercise(memory, (parent) => memory.createFork(parent, zero, "run"))
      const memoryArchive = memory.state().archived.map((record) => ({
        generation: record.generation,
        seq: record.seq,
        parent: (record.payload as { parentRunId: string }).parentRunId
      }))
      const sqlite = yield* withSql((store, sql) =>
        Effect.gen(function*() {
          yield* seedSql(sql)
          yield* sql`DELETE FROM flows_time_travel_edges`
          yield* sql`DELETE FROM flows_journal_events WHERE run_id = 'run' AND seq > 0`
          const counts = yield* exercise(store, (parent) =>
            sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('run', 1, ${parent}, 'source', 1, 0, ${forkCreatedEventType},
                    ${JSON.stringify({ parentRunId: parent })}, '{}')
          `)
          const archived = yield* sql<{ readonly generation: number; readonly seq: number; readonly parent: string }>`
            SELECT generation, seq, ${Dialect.jsonText(sql, sql`payload_json`, "$.parentRunId")} AS parent
            FROM flows_time_travel_archive WHERE run_id = 'run' ORDER BY generation, seq
          `
          return { counts, archived }
        })
      )
      expect(memoryCounts).toEqual([1, 1])
      expect(memoryArchive).toEqual([
        { generation: 0, seq: 1, parent: "original" },
        { generation: 1, seq: 1, parent: "replacement" }
      ])
      expect(sqlite).toEqual({ counts: memoryCounts, archived: memoryArchive })
    }))

  for (const backend of ["memory", "sqlite"] as const) {
    it.effect(`${backend} clears discarded snapshot anchors while retaining prefix and detached anchors`, () =>
      Effect.gen(function*() {
        const exercise = (store: TimeTravelStore.Service) =>
          Effect.gen(function*() {
            for (
              const snapshot of [
                { runId: "run", frame, changeId: "at-frame" },
                { runId: "run", frame: { ...frame, seq: 2 }, changeId: "discarded-future" },
                { runId: "run", frame: { lineageId: "other", seq: 2 }, changeId: "other-future" },
                { runId: "attached", frame: { ...frame, seq: 0 }, changeId: "child-future" },
                { runId: "detached", frame: { ...frame, seq: 0 }, changeId: "detached" }
              ]
            ) yield* store.recordSnapshot(snapshot)
            yield* store.archiveAndTruncate("run", frame, [], owner)
            // Replacement history anchors at 3, skipping the old anchor at 2.
            yield* store.recordSnapshot({ runId: "run", frame: { ...frame, seq: 3 }, changeId: "replacement" })
            return {
              parent: yield* store.snapshotAt("run", { ...frame, seq: 2 }),
              other: yield* store.snapshotAt("run", { lineageId: "other", seq: 2 }),
              child: yield* store.snapshotAt("attached", { ...frame, seq: 2 }),
              detached: yield* store.snapshotAt("detached", frame),
              replacement: yield* store.snapshotAt("run", { ...frame, seq: 3 })
            }
          })
        const expected = {
          parent: { runId: "run", frame, changeId: "at-frame" },
          other: undefined,
          child: undefined,
          detached: { runId: "detached", frame: { ...frame, seq: 0 }, changeId: "detached" },
          replacement: { runId: "run", frame: { ...frame, seq: 3 }, changeId: "replacement" }
        }
        const actual = backend === "memory"
          ? yield* exercise(memorySeed())
          : yield* withSql((store, sql) => seedSql(sql).pipe(Effect.andThen(exercise(store))))
        expect(actual).toEqual(expected)
      }))
  }

  for (const backend of ["memory", "sqlite"] as const) {
    it.effect(`${backend} records a batch in one write and reports the last anchor per lineage`, () =>
      Effect.gen(function*() {
        const exercise = (store: TimeTravelStore.Service) =>
          Effect.gen(function*() {
            const empty = yield* store.latestSnapshots("nobody")
            yield* store.recordSnapshots([])
            yield* store.recordSnapshots([
              { runId: "run", frame: { ...frame, seq: 0 }, changeId: "first" },
              {
                runId: "run",
                frame: { ...frame, seq: 4 },
                changeId: "root-4",
                operationId: "operation-4",
                planDigest: "plan-4"
              },
              { runId: "run", frame: { lineageId: "other", seq: 2 }, changeId: "other-2" },
              { runId: "run", frame: { lineageId: "other", seq: 3 }, changeId: "other-3" },
              { runId: "peer", frame: { ...frame, seq: 9 }, changeId: "peer" },
              // A later batch member at the same frame replaces the earlier one.
              { runId: "run", frame: { ...frame, seq: 0 }, changeId: "replaced" }
            ])
            return {
              empty,
              latest: yield* store.latestSnapshots("run"),
              replaced: yield* store.snapshotAt("run", { ...frame, seq: 0 }),
              withOperation: yield* store.snapshotAt("run", { ...frame, seq: 5 })
            }
          })
        const expected = {
          empty: [],
          latest: [
            { runId: "run", frame: { lineageId: "other", seq: 3 }, changeId: "other-3" },
            {
              runId: "run",
              frame: { ...frame, seq: 4 },
              changeId: "root-4",
              operationId: "operation-4",
              planDigest: "plan-4"
            }
          ],
          replaced: { runId: "run", frame: { ...frame, seq: 0 }, changeId: "replaced" },
          withOperation: {
            runId: "run",
            frame: { ...frame, seq: 4 },
            changeId: "root-4",
            operationId: "operation-4",
            planDigest: "plan-4"
          }
        }
        const actual = backend === "memory"
          ? yield* exercise(MemoryTimeTravelStore.make())
          : yield* withSql((store) => exercise(store))
        expect(actual).toEqual(expected)
      }))
  }

  it.effect("refuses a foreign-owned attached child without changing either journal", () =>
    Effect.gen(function*() {
      const childOwner = { ...owner, nonce: "rewind-child" }
      const childFrame = { lineageId: "parent/root", seq: 0 } as const
      const childEdge: LineageEdge = {
        parentRunId: "parent",
        parentSeq: 1,
        childRunId: "child",
        kind: "child",
        attached: true
      }
      const memoryStore = MemoryTimeTravelStore.make({
        records: [
          { runId: "parent", seq: 0, eventId: "parent-0", payload: {} },
          { runId: "parent", seq: 1, eventId: "parent-1", payload: {} },
          { runId: "child", seq: 0, eventId: "child-0", payload: {} }
        ],
        edges: [childEdge],
        runOwners: new Map<string, OwnerId>([["parent", owner], ["child", stranger]]),
        runStatuses: new Map([["child", "running"]])
      })
      const memoryFailure = yield* Effect.flip(
        memoryStore.archiveAndTruncate(
          "parent",
          childFrame,
          [],
          owner,
          new Map([["child", childOwner]])
        )
      )

      const sqlResult = yield* withSql((store, sql) =>
        Effect.gen(function*() {
          for (const [runId, runOwner] of [["parent", owner], ["child", stranger]] as const) {
            yield* sql`
              INSERT INTO flows_runs
                (run_id, status, created_at_ms, state_json,
                 owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
              VALUES (${runId}, 'running', 0, '{}',
                      ${runOwner.hostId}, ${runOwner.pid}, ${runOwner.nonce}, 0)
            `
          }
          for (const [runId, seq] of [["parent", 0], ["parent", 1], ["child", 0]] as const) {
            yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                 event_type, payload_json, meta_json)
              VALUES (${runId}, ${seq}, ${`${runId}-${seq}`}, 'source', ${seq}, 0, 'test', '{}', '{}')
            `
          }
          yield* sql`
            INSERT INTO flows_time_travel_edges
              (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES ('parent', 1, 'child', 'child', 1)
          `
          const failure = yield* Effect.flip(
            store.archiveAndTruncate(
              "parent",
              childFrame,
              [],
              owner,
              new Map([["child", childOwner]])
            )
          )
          const live = yield* sql<{ readonly run_id: string; readonly seq: number }>`
            SELECT run_id, seq FROM flows_journal_events ORDER BY run_id, seq
          `
          const archived = yield* sql<{ readonly run_id: string }>`
            SELECT run_id FROM flows_time_travel_archive
          `
          return { failure, live, archived }
        })
      )

      expect(memoryFailure).toMatchObject({
        code: "fence_lost",
        message: "attached child child is not owned by this rewind"
      })
      expect(memoryStore.state().records.map(({ runId, seq }) => ({ runId, seq }))).toEqual([
        { runId: "parent", seq: 0 },
        { runId: "parent", seq: 1 },
        { runId: "child", seq: 0 }
      ])
      expect(memoryStore.state().archived).toEqual([])
      for (
        const mismatchedOwner of [
          { ...childOwner, hostId: "different-child-host" },
          { ...childOwner, pid: childOwner.pid + 1 },
          { ...childOwner, nonce: "different-child-nonce" }
        ]
      ) {
        const mismatchStore = MemoryTimeTravelStore.make({
          records: [
            { runId: "parent", seq: 0, eventId: "parent-0", payload: {} },
            { runId: "parent", seq: 1, eventId: "parent-1", payload: {} },
            { runId: "child", seq: 0, eventId: "child-0", payload: {} }
          ],
          edges: [childEdge],
          runOwners: new Map<string, OwnerId>([["parent", owner], ["child", mismatchedOwner]]),
          runStatuses: new Map([["child", "running"]])
        })
        const mismatch = yield* Effect.flip(
          mismatchStore.archiveAndTruncate(
            "parent",
            childFrame,
            [],
            owner,
            new Map([["child", childOwner]])
          )
        )
        expect(mismatch).toMatchObject({ code: "fence_lost" })
      }
      expect(sqlResult.failure).toMatchObject({
        code: "fence_lost",
        message: "attached child child is not owned by this rewind"
      })
      expect(sqlResult.live).toEqual([
        { run_id: "child", seq: 0 },
        { run_id: "parent", seq: 0 },
        { run_id: "parent", seq: 1 }
      ])
      expect(sqlResult.archived).toEqual([])
    }))

  it.effect("applies allowed audit patches and rejects identity keys identically", () =>
    Effect.gen(function*() {
      const exercise = (store: TimeTravelStore.Service) =>
        Effect.gen(function*() {
          const detail = { nested: { value: "before" } }
          yield* store.writeAudit({
            id: "audit",
            runId: "run",
            frame,
            status: "in_progress",
            detail
          })
          detail.nested.value = "mutated-after-write"
          const first = yield* store.pendingAudits()
          // Snapshot before mutating: the point of the next line is that
          // mutating what a read handed back changes nothing durable, so the
          // value being compared has to be the one the read produced.
          const firstDetail = structuredClone(first[0]!.detail)
          ;(first[0]!.detail as { nested: { value: string } }).nested.value = "mutated-after-read"
          const second = yield* store.pendingAudits()
          yield* store.updateAudit("audit", { detail: { allowed: true }, rateLimit: { remaining: 2 } })
          const invalid = yield* Effect.flip(
            store.updateAudit("audit", { id: "moved" } as never)
          )
          const marker = "SECRET-HANDLER-RECEIPT-DATA"
          const invalidStatus = yield* Effect.flip(
            store.updateAudit("audit", {
              status: "bogus",
              detail: { compensation: { handlerReceipts: [{ id: "receipt", data: { token: marker } }] } }
            } as never)
          )
          expect(invalidStatus.message).not.toContain(marker)
          expect(JSON.stringify(Schema.encodeSync(TimeTravelError)(invalidStatus))).not.toContain(marker)
          expect(invalidStatus.cause).toBeDefined()
          const updated = yield* store.pendingAudits()
          return {
            first: firstDetail,
            second: second[0]!.detail,
            invalid: { code: invalid.code, message: invalid.message },
            invalidStatus: { code: invalidStatus.code, message: invalidStatus.message },
            updated: {
              id: updated[0]!.id,
              runId: updated[0]!.runId,
              frame: updated[0]!.frame,
              status: updated[0]!.status,
              rateLimit: updated[0]!.rateLimit,
              detail: updated[0]!.detail
            }
          }
        })

      const memory = yield* exercise(memorySeed())
      const sqlite = yield* withSql((store) => exercise(store))

      expect(memory).toEqual(sqlite)
      expect(memory.first).toEqual({ nested: { value: "before" } })
      expect(memory.second).toEqual({ nested: { value: "before" } })
      expect(memory.invalid).toEqual({ code: "invalid", message: "audit patch contains unknown key id" })
      expect(memory.invalidStatus).toMatchObject({
        code: "invalid",
        message: "invalid audit patch: status \"bogus\" is not one of in_progress|completed|failed"
      })
      expect(memory.updated).toMatchObject({
        id: "audit",
        runId: "run",
        frame,
        status: "in_progress",
        rateLimit: { remaining: 2 },
        detail: { allowed: true }
      })
    }))

  it.effect("deep-copies memory receipts and reports non-cloneable writes as typed failures", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      const payload = { nested: { value: "before" } }
      yield* store.recordReceipt({ id: "receipt", auditId: "audit", effectId: "effect", receipt: payload })
      payload.nested.value = "mutated-after-write"
      const first = store.state()
      ;(first.receipts[0]!.receipt as { nested: { value: string } }).nested.value = "mutated-after-read"

      expect(store.state().receipts[0]!.receipt).toEqual({ nested: { value: "before" } })
      const failure = yield* Effect.flip(store.writeAudit({
        id: "not-cloneable",
        runId: "run",
        frame,
        status: "in_progress",
        detail: () => "not cloneable"
      }))
      expect(failure).toMatchObject({ code: "invalid", message: "could not clone audit" })
    }))

  for (
    const scenario of [
      { name: "beyond the tail", frame: { lineageId: "run/root", seq: 2 } },
      { name: "on the wrong lineage", frame: { lineageId: "run/other", seq: 1 } }
    ] as const
  ) {
    it.effect(`refuses a fork ${scenario.name} without writing any child evidence`, () =>
      Effect.gen(function*() {
        const memory = MemoryTimeTravelStore.make({
          records: [{ runId: "run", seq: 1, eventId: "run-1", lineageId: "run/root", payload: {} }]
        })
        const memoryBefore = memory.state()
        const memoryFailure = yield* Effect.flip(
          memory.createFork("run", scenario.frame, "refused-child")
        )
        expect(memoryFailure).toMatchObject({ code: "not_found" })
        expect(memory.state()).toEqual(memoryBefore)
        expect(memory.state().records.some((record) => record.eventType === forkCreatedEventType)).toBe(false)

        const sqlite = yield* withSql((store, sql) =>
          Effect.gen(function*() {
            yield* sql`
              INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
              VALUES ('run', 'suspended', 0,
                      ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})
            `
            yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                 event_type, payload_json, meta_json)
              VALUES ('run', 1, 'run-1', 'source', 1, 0, 'test', '{}',
                      ${JSON.stringify({ lineageId: "run/root" })})
            `
            const failure = yield* Effect.flip(
              store.createFork("run", scenario.frame, "refused-child")
            )
            const childRuns = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM flows_runs WHERE run_id = 'refused-child'
            `
            const copied = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM flows_journal_events WHERE run_id = 'refused-child'
            `
            const edges = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM flows_time_travel_edges WHERE child_run_id = 'refused-child'
            `
            const markers = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM flows_journal_events
              WHERE run_id = 'refused-child' AND event_type = ${forkCreatedEventType}
            `
            return {
              failure: { code: failure.code, message: failure.message },
              childRuns: Number(childRuns[0]!.count),
              copied: Number(copied[0]!.count),
              edges: Number(edges[0]!.count),
              markers: Number(markers[0]!.count)
            }
          })
        )

        expect(sqlite).toEqual({
          failure: { code: memoryFailure.code, message: memoryFailure.message },
          childRuns: 0,
          copied: 0,
          edges: 0,
          markers: 0
        })
      }))
  }
})

/**
 * A fork id is a durable reservation on both stores: consumed by the fork
 * that commits it, handed back once when abandoned, never reused.
 */
describe("TimeTravelStore fork intents", () => {
  it.effect("reserves, consumes, and reclaims fork intents identically", () =>
    Effect.gen(function*() {
      const at = { lineageId: "run/root", seq: 0 } as const
      const exercise = (store: TimeTravelStore.Service) =>
        Effect.gen(function*() {
          const abandoned = yield* store.nextForkId("run", at)
          const fresh = yield* store.abandonForkIntents(0)
          const stale = yield* store.abandonForkIntents(1)
          const again = yield* store.abandonForkIntents(1)
          const minted = yield* store.nextForkId("run", at)
          const fork = yield* store.createFork("run", at, minted)
          const consumed = yield* store.abandonForkIntents(Number.MAX_SAFE_INTEGER)
          return {
            ids: [abandoned, minted],
            distinct: abandoned !== minted,
            fresh,
            stale: stale.map((intent) => ({
              reclaimsAbandoned: intent.childRunId === abandoned,
              parentRunId: intent.parentRunId,
              parentSeq: intent.parentSeq,
              reservedAtMs: intent.reservedAtMs
            })),
            again,
            committed: fork.runId === minted,
            consumed
          }
        })

      const memory = yield* exercise(
        MemoryTimeTravelStore.make({
          records: [{ runId: "run", seq: 0, eventId: "run-0", lineageId: "run/root", payload: {} }]
        })
      )
      const sqlite = yield* withSql((store, sql) =>
        Effect.gen(function*() {
          yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('run', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})
          `
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('run', 0, 'run-0', 'source', 0, 0, 'test', '{}', ${JSON.stringify({ lineageId: "run/root" })})
          `
          return yield* exercise(store)
        })
      )

      expect(memory).toEqual(sqlite)
      expect(memory).toEqual({
        ids: ["run:fork:0:1", "run:fork:0:2"],
        distinct: true,
        fresh: [],
        stale: [{ reclaimsAbandoned: true, parentRunId: "run", parentSeq: 0, reservedAtMs: 0 }],
        again: [],
        committed: true,
        consumed: []
      })
    }))
})
