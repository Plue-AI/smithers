import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as DatabaseModule from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Frame from "../src/Frame.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import type * as TimeTravelStore from "../src/TimeTravelStore.ts"

const run = <A>(
  body: (
    store: TimeTravelStore.Service,
    sql: SqlClient.SqlClient
  ) => Effect.Effect<A, unknown, DatabaseModule.DurableWriter | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    yield* Migrations.run
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const store = yield* SqlTimeTravelStore.make
    return yield* body(store, sql)
  }).pipe(Effect.provide(TestDatabase.layer)) as Effect.Effect<A, unknown>

const fileHandle = <A>(
  filename: string,
  body: (
    store: TimeTravelStore.Service,
    sql: SqlClient.SqlClient
  ) => Effect.Effect<A, unknown, DatabaseModule.DurableWriter | SqlClient.SqlClient>
) => {
  const database = Layer.provideMerge(DatabaseModule.layer(), NodeDatabase.layer({ filename }))
  return Effect.scoped(
    Effect.gen(function*() {
      yield* Migrations.run
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const store = yield* SqlTimeTravelStore.make
      return yield* body(store, sql)
    }).pipe(Effect.provide(database))
  ) as Effect.Effect<A, unknown>
}

const insertRun = (
  sql: SqlClient.SqlClient,
  runId: string,
  options: {
    readonly status?: string
    readonly stateJson?: string
    readonly claimHostId?: string | null
  } = {}
) =>
  sql`
    INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, claim_host_id, claim_pid, claim_nonce, claimed_at_ms)
    VALUES (
      ${runId},
      ${options.status ?? "suspended"},
      0,
      ${options.stateJson ?? JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
      NULL,
      ${options.claimHostId ?? null},
      ${options.claimHostId === undefined ? null : 4321},
      ${options.claimHostId === undefined ? null : "claim-nonce"},
      ${options.claimHostId === undefined ? null : 0}
    )
  `

/** The run table constrains ownership columns, so a live run must be inserted whole. */
const insertRunningRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql`
    INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
    VALUES (${runId}, 'running', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
            'host-a', 1234, 'nonce', 0)
  `

const owner = { hostId: "host-a", pid: 1234, nonce: "nonce" } as const

/** A run row whose owner columns match {@link owner}, so the archive fence passes. */
const insertOwnedRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql`
    INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
    VALUES (${runId}, 'running', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
            ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)
  `

describe("SqlTimeTravelStore.snapshotAt", () => {
  it.effect("returns the newest snapshot at or before the frame, scoped to one lineage", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          for (
            const row of [
              { lineage: "main", seq: 0, changeId: "c0" },
              { lineage: "main", seq: 5, changeId: "c5" },
              { lineage: "other", seq: 7, changeId: "x7" }
            ]
          ) {
            yield* sql`
            INSERT INTO flows_time_travel_snapshots (run_id, lineage_id, seq, change_id)
            VALUES ('run', ${row.lineage}, ${row.seq}, ${row.changeId})
          `
          }
          return {
            exact: yield* store.snapshotAt("run", { lineageId: "main", seq: 5 }),
            between: yield* store.snapshotAt("run", { lineageId: "main", seq: 4 }),
            beforeAny: yield* store.snapshotAt("run", { lineageId: "main", seq: -1 }),
            otherLineage: yield* store.snapshotAt("run", { lineageId: "other", seq: 100 }),
            otherRun: yield* store.snapshotAt("missing", { lineageId: "main", seq: 100 })
          }
        })
      )

      expect(result.exact).toEqual({ runId: "run", frame: { lineageId: "main", seq: 5 }, changeId: "c5" })
      expect(result.between).toEqual({ runId: "run", frame: { lineageId: "main", seq: 0 }, changeId: "c0" })
      expect(result.beforeAny).toBeUndefined()
      expect(result.otherLineage?.changeId).toBe("x7")
      expect(result.otherRun).toBeUndefined()
    }))

  it.effect("round-trips a roughly one-megabyte state projection without truncation", () =>
    Effect.gen(function*() {
      const large = "x".repeat(1024 * 1024)
      const state = { version: 1, flowName: "Large", payload: { large } }
      const stateJson = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES ('large', 0, 'large-0', 'large', 0, 0, 'flows.engine.run-decision',
                  ${JSON.stringify({ state })}, ${JSON.stringify({ lineageId: "large/root" })})
        `
          return yield* store.stateAt("large", { lineageId: "large/root", seq: 0 })
        })
      )

      expect(stateJson).toBe(JSON.stringify(state))
      expect(stateJson?.length).toBeGreaterThan(1024 * 1024)
    }))

  it.effect("accepts MAX_SAFE_INTEGER and rejects one-past it at the SQL boundary", () =>
    Effect.gen(function*() {
      const result = yield* run((store) =>
        Effect.gen(function*() {
          yield* store.writeAudit({
            id: "safe",
            runId: "run",
            frame: { lineageId: "main", seq: Number.MAX_SAFE_INTEGER },
            status: "in_progress"
          })
          const unsafe = yield* Effect.flip(store.writeAudit({
            id: "unsafe",
            runId: "run",
            frame: { lineageId: "main", seq: Number.MAX_SAFE_INTEGER + 1 },
            status: "in_progress"
          }))
          return { pending: yield* store.pendingAudits(), unsafe }
        })
      )

      expect(result.pending).toMatchObject([{
        id: "safe",
        frame: { lineageId: "main", seq: 9007199254740991 }
      }])
      expect(result.unsafe).toMatchObject({ code: "unknown", message: "time-travel persistence failed" })
    }))

  it("keeps Frame schema parity with the MAX_SAFE_INTEGER SQL constraint", () => {
    expect(() => Schema.decodeUnknownSync(Frame.Frame)({ lineageId: "main", seq: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow()
  })
})

describe("SqlTimeTravelStore.descendants", () => {
  it.effect("probes journal lineage by reachable run in descendants and archive", () =>
    run((_store, sql) =>
      Effect.gen(function*() {
        const queries: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = []
        const instrumented = new Proxy(sql, {
          apply(target, thisArg, args) {
            const statement: Statement.Statement<unknown> = Reflect.apply(target, thisArg, args)
            // sql(name) constructs an identifier, including inside the migrator.
            if (typeof args[0] === "string") return statement
            const compiled = statement.compile()
            if (compiled[0].includes("WITH RECURSIVE") && compiled[0].includes("flows_time_travel_edges")) {
              queries.push(compiled)
            }
            return statement
          }
        })
        const store = yield* SqlTimeTravelStore.make.pipe(Effect.provideService(SqlClient.SqlClient, instrumented))
        yield* insertOwnedRun(sql, "parent")
        yield* store.descendants("parent", { lineageId: "main", seq: 0 })
        yield* store.archiveAndTruncate("parent", { lineageId: "main", seq: 0 }, [], owner)
        expect(queries).toHaveLength(2)
        for (const [query, parameters] of queries) {
          const plan = yield* TestDatabase.explain(sql, sql.unsafe(query, parameters))
          if (Dialect.isPostgres(sql)) {
            expect(plan.map((row) => row.detail).join("\n")).toMatch(/Index.*flows_/)
            continue
          }
          const journalReads = plan.map((row) => row.detail).filter((detail) => detail.includes("flows_journal_events"))
          expect(journalReads).toHaveLength(4)
          expect(journalReads.filter((detail) => detail.includes("flows_journal_events_child_spawn_idx"))).toHaveLength(
            2
          )
          expect(journalReads.filter((detail) => detail.includes("flows_journal_events_handoff_idx"))).toHaveLength(2)
          const forkReads = plan.map((row) => row.detail).filter((detail) => detail.includes("flows_time_travel_edges"))
          expect(forkReads).toHaveLength(2)
          for (const detail of forkReads) {
            expect(detail).toContain("flows_time_travel_edges_parent_idx (parent_run_id=?)")
          }
          for (const detail of journalReads) {
            expect(detail).toMatch(/SEARCH .*\(run_id=\?\)/)
          }
        }
      })
    ))

  it.effect("derives the detached spawn edge from the engine boundary payload at its journal seq", () =>
    run((store, sql) =>
      Effect.gen(function*() {
        // EffectRecords.boundary as emitted by RunDriver.create for a detached child.
        const payload = {
          version: 1,
          effect: {
            id: "parent:spawn:child",
            kind: "flows/engine-store/child-spawn",
            tier: "irreversible",
            status: "succeeded",
            runId: "parent",
            lineageId: "parent/root",
            attempt: 1,
            durableBoundary: true,
            providerStream: false,
            output: { childRunId: "child", flowName: "Child", attached: false },
            residue: "Child run child exists and keeps its own journal; rewinding past its spawn orphans it."
          }
        }
        yield* sql`INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES ('parent', 4, 'spawn', 'engine:effect:parent:spawn:child:succeeded', 0, 0,
            'flows.time-travel.effect-boundary', ${JSON.stringify(payload)},
            ${
          JSON.stringify({
            lineageId: "parent/root",
            timeTravel: {
              effectId: payload.effect.id,
              kind: payload.effect.kind,
              tier: payload.effect.tier,
              status: payload.effect.status
            }
          })
        })`
        expect(yield* store.descendants("parent", { lineageId: "parent/root", seq: 3 })).toEqual({
          attached: [],
          detached: [{ parentRunId: "parent", parentSeq: 4, childRunId: "child", kind: "child", attached: false }]
        })
        expect(yield* store.descendants("parent", { lineageId: "parent/root", seq: 4 })).toEqual({
          attached: [],
          detached: []
        })
      })
    ))

  it.effect("walks attached descendants transitively and reports detached edges separately", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          const edges = [
            ["parent", 1, "before", "child", 1],
            ["parent", 3, "attached", "child", 1],
            ["attached", 0, "grandchild", "continuation", 1],
            ["parent", 4, "detached", "fork", 0]
          ] as const
          for (const [parentRunId, parentSeq, childRunId, kind, attached] of edges) {
            yield* sql`
            INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, ${parentSeq}, ${childRunId}, ${kind}, ${attached})
          `
          }
          return yield* store.descendants("parent", { lineageId: "main", seq: 2 })
        })
      )

      expect(result.attached.map((edge) => edge.childRunId)).toEqual(["attached", "grandchild"])
      expect(result.detached.map((edge) => edge.childRunId)).toEqual(["detached"])
      expect(result.attached[0]).toEqual({
        parentRunId: "parent",
        parentSeq: 3,
        childRunId: "attached",
        kind: "child",
        attached: true
      })
    }))

  it.effect("deduplicates an attached cycle while preserving every reachable edge", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          for (
            const [parentRunId, childRunId] of [
              ["parent", "child"],
              ["child", "parent"]
            ] as const
          ) {
            yield* sql`
            INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, 1, ${childRunId}, 'continuation', 1)
          `
          }
          return yield* store.descendants("parent", { lineageId: "main", seq: 0 })
        })
      )

      expect(result.attached.map((edge) => edge.childRunId)).toEqual(["child", "parent"])
      expect(result.detached).toEqual([])
    }))
  it.effect("derives a continuation edge from the round the parent handed off to", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          // Exactly what `@smthrs/engine-store` writes when a trampoline round
          // hands off: a `handed-off` decision on the round that finished,
          // naming the round that follows it.
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('round-0', 4, 'round-0-4', 'engine', 0, 0,
                    'flows.engine.run-decision',
                    ${
            JSON.stringify({
              decision: "handed-off",
              status: "completed",
              lineageId: "round-0",
              roundOrdinal: 1,
              nextExecutionId: "round-1"
            })
          },
                    '{}')
          `
          // A decision that is not a handoff must contribute no edge.
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('round-0', 5, 'round-0-5', 'engine', 1, 0,
                    'flows.engine.run-decision',
                    ${JSON.stringify({ decision: "transitioned", status: "completed" })},
                    '{}')
          `
          return yield* store.descendants("round-0", { lineageId: "round-0/root", seq: 3 })
        })
      )

      // A round is its own run row with its own claim and its own journal, so
      // rewinding past the handoff orphans it rather than having to cancel it.
      expect(result.detached).toEqual([{
        parentRunId: "round-0",
        parentSeq: 4,
        childRunId: "round-1",
        kind: "continuation",
        attached: false
      }])
      expect(result.attached).toEqual([])
    }))

  it.effect("leaves a handoff recorded before the frame out of the descendants", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('round-0', 2, 'round-0-2', 'engine', 0, 0,
                    'flows.engine.run-decision',
                    ${JSON.stringify({ decision: "handed-off", nextExecutionId: "round-1" })},
                    '{}')
          `
          return yield* store.descendants("round-0", { lineageId: "round-0/root", seq: 3 })
        })
      )

      expect(result).toEqual({ attached: [], detached: [] })
    }))
})

describe("SqlTimeTravelStore audits", () => {
  it.effect("round-trips optional rate limit and detail payloads through pendingAudits", () =>
    Effect.gen(function*() {
      const result = yield* run((store) =>
        Effect.gen(function*() {
          yield* store.writeAudit({
            id: "audit-1",
            runId: "run",
            frame: { lineageId: "main", seq: 2 },
            status: "in_progress",
            rateLimit: { remaining: 3 },
            detail: { phase: "preflight" }
          })
          yield* store.writeAudit({
            id: "audit-2",
            runId: "run",
            frame: { lineageId: "main", seq: 9 },
            status: "completed"
          })
          return yield* store.pendingAudits()
        })
      )

      expect(result).toEqual([
        {
          id: "audit-1",
          runId: "run",
          frame: { lineageId: "main", seq: 2 },
          status: "in_progress",
          rateLimit: { remaining: 3 },
          detail: { phase: "preflight" }
        }
      ])
    }))

  it.effect("patches only the supplied fields and drops the audit out of the pending set", () =>
    Effect.gen(function*() {
      const result = yield* run((store) =>
        Effect.gen(function*() {
          yield* store.writeAudit({
            id: "audit",
            runId: "run",
            frame: { lineageId: "main", seq: 1 },
            status: "in_progress",
            rateLimit: { remaining: 1 }
          })
          yield* store.updateAudit("audit", { status: "failed" })
          const pending = yield* store.pendingAudits()
          yield* store.updateAudit("audit", { status: "in_progress", detail: { reason: "retry" } })
          const reopened = yield* store.pendingAudits()
          return { pending, reopened }
        })
      )

      expect(result.pending).toEqual([])
      expect(result.reopened).toEqual([
        {
          id: "audit",
          runId: "run",
          frame: { lineageId: "main", seq: 1 },
          status: "in_progress",
          rateLimit: { remaining: 1 },
          detail: { reason: "retry" }
        }
      ])
    }))

  it.effect("fails updateAudit for an unknown id", () =>
    Effect.gen(function*() {
      const error = yield* run((store) => Effect.flip(store.updateAudit("nope", { status: "completed" })))

      expect(error).toMatchObject({ code: "not_found", message: "audit nope was not found" })
    }))

  it.effect("keeps absent optional fields absent when an audit is updated", () =>
    Effect.gen(function*() {
      const [audit] = yield* run((store) =>
        Effect.gen(function*() {
          yield* store.writeAudit({
            id: "audit-empty",
            runId: "run",
            frame: { lineageId: "main", seq: 0 },
            status: "in_progress"
          })
          yield* store.updateAudit("audit-empty", { status: "in_progress" })
          return yield* store.pendingAudits()
        })
      )

      expect(audit).toEqual({
        id: "audit-empty",
        runId: "run",
        frame: { lineageId: "main", seq: 0 },
        status: "in_progress",
        rateLimit: undefined,
        detail: undefined
      })
    }))

  it.effect("returns a typed persistence failure for malformed persisted audit JSON", () =>
    Effect.gen(function*() {
      const failure = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* TestDatabase.checks(sql, false)
          yield* sql`
          INSERT INTO flows_time_travel_audits
            (id, run_id, lineage_id, seq, status, rate_limit_json, detail_json)
          VALUES ('malformed', 'run', 'main', 0, 'in_progress', NULL, '{')
        `
          return yield* Effect.flip(store.pendingAudits())
        })
      )

      expect(failure).toMatchObject({
        code: "unknown",
        message: "time-travel persistence failed",
        cause: expect.anything()
      })
    }))

  it.effect("rejects rows outside every durable time-travel boundary", () =>
    Effect.gen(function*() {
      const outcomes = yield* run((_store, sql) => {
        const invalidStatements = [
          `INSERT INTO flows_time_travel_audits(id,run_id,lineage_id,seq,status,rate_limit_json,detail_json) VALUES ('', 'run', 'main', 0, 'in_progress', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits(id,run_id,lineage_id,seq,status,rate_limit_json,detail_json) VALUES ('audit-negative', 'run', 'main', -1, 'in_progress', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits(id,run_id,lineage_id,seq,status,rate_limit_json,detail_json) VALUES ('audit-fractional', 'run', 'main', 0.5, 'in_progress', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits(id,run_id,lineage_id,seq,status,rate_limit_json,detail_json) VALUES ('audit-unsafe', 'run', 'main', 9007199254740992, 'in_progress', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits(id,run_id,lineage_id,seq,status,rate_limit_json,detail_json) VALUES ('audit-status', 'run', 'main', 0, 'unknown', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits(id,run_id,lineage_id,seq,status,rate_limit_json,detail_json) VALUES ('audit-json', 'run', 'main', 0, 'in_progress', '{', NULL)`,
          `INSERT INTO flows_time_travel_receipts VALUES ('', 'audit', 'effect', '{}')`,
          `INSERT INTO flows_time_travel_receipts VALUES ('receipt-audit', '', 'effect', '{}')`,
          `INSERT INTO flows_time_travel_receipts VALUES ('receipt-effect', 'audit', '', '{}')`,
          `INSERT INTO flows_time_travel_receipts VALUES ('receipt-json', 'audit', 'effect', '{')`,
          `INSERT INTO flows_time_travel_snapshots VALUES ('', 'main', 0, 'change')`,
          `INSERT INTO flows_time_travel_snapshots VALUES ('run', '', 0, 'change')`,
          `INSERT INTO flows_time_travel_snapshots VALUES ('run', 'main', -1, 'change')`,
          `INSERT INTO flows_time_travel_snapshots VALUES ('run', 'main', 0, '')`,
          `INSERT INTO flows_time_travel_edges(parent_run_id,parent_seq,child_run_id,kind,attached) VALUES ('', 0, 'child', 'child', 1)`,
          `INSERT INTO flows_time_travel_edges(parent_run_id,parent_seq,child_run_id,kind,attached) VALUES ('parent', -1, 'child', 'child', 1)`,
          `INSERT INTO flows_time_travel_edges(parent_run_id,parent_seq,child_run_id,kind,attached) VALUES ('parent', 0, '', 'child', 1)`,
          `INSERT INTO flows_time_travel_edges(parent_run_id,parent_seq,child_run_id,kind,attached) VALUES ('parent', 0, 'child-kind', 'unknown', 1)`,
          `INSERT INTO flows_time_travel_edges(parent_run_id,parent_seq,child_run_id,kind,attached) VALUES ('parent', 0, 'child-attached', 'child', 2)`,
          `INSERT INTO flows_time_travel_edges(parent_run_id,parent_seq,child_run_id,kind,attached) VALUES ('same', 0, 'same', 'child', 1)`,
          `INSERT INTO flows_time_travel_archive VALUES ('', 0, 0, 'event', 'source', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', -1, 0, 'event-gen', 'source', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, -1, 'event', 'source', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 0, '', 'source', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 0, 'event-source', '', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 0, 'event-seq', 'source', -1, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 0, 'event-emitted', 'source', 0, -1, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 0, 'event-type', 'source', 0, 0, '', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 0, 'event-payload', 'source', 0, 0, 'type', '{', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 0, 'event-meta', 'source', 0, 0, 'type', '{}', '{', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 0, 'event-archived', 'source', 0, 0, 'type', '{}', '{}', -1)`,
          `INSERT INTO flows_time_travel_fork_intents VALUES ('', 'parent', 0, 0, NULL)`,
          `INSERT INTO flows_time_travel_fork_intents VALUES ('intent-parent', '', 0, 0, NULL)`,
          `INSERT INTO flows_time_travel_fork_intents VALUES ('intent-seq', 'parent', -1, 0, NULL)`,
          `INSERT INTO flows_time_travel_fork_intents VALUES ('intent-seq-fractional', 'parent', 0.5, 0, NULL)`,
          `INSERT INTO flows_time_travel_fork_intents VALUES ('intent-reserved', 'parent', 0, -1, NULL)`,
          `INSERT INTO flows_time_travel_fork_intents VALUES ('intent-reclaimed', 'parent', 0, 0, -1)`
        ] as const
        return Effect.forEach(invalidStatements, (statement) => Effect.exit(sql.unsafe(statement)))
      })

      expect(outcomes.every((outcome) => outcome._tag === "Failure")).toBe(true)
    }))
})

describe("SqlTimeTravelStore construction", () => {
  it.effect("dies before exposing a store when its migration cannot run", () =>
    Effect.gen(function*() {
      const failingSql = new Proxy(
        () => Effect.fail("no database"),
        { apply: () => Effect.fail("no database") }
      ) as unknown as SqlClient.SqlClient
      const exit = yield* (
        Effect.exit(SqlTimeTravelStore.make.pipe(
          Effect.provideService(SqlClient.SqlClient, failingSql),
          Effect.provide(DatabaseModule.layerNoop)
        ))
      )

      expect(exit._tag).toBe("Failure")
    }))
})

describe("SqlTimeTravelStore persistence fault matrix", () => {
  const audit: TimeTravelStore.Audit = {
    id: "audit",
    runId: "run",
    frame: { lineageId: "main", seq: 0 },
    status: "in_progress"
  }

  for (
    const scenario of [
      {
        method: "snapshotAt",
        table: "flows_time_travel_snapshots",
        invoke: (store: TimeTravelStore.Service) => store.snapshotAt("run", audit.frame)
      },
      {
        method: "descendants",
        table: "flows_time_travel_edges",
        invoke: (store: TimeTravelStore.Service) => store.descendants("run", audit.frame)
      },
      {
        method: "writeAudit",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.writeAudit(audit)
      },
      {
        method: "updateAudit",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.updateAudit("audit", { status: "failed" })
      },
      {
        method: "pendingAudits",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.pendingAudits()
      },
      {
        method: "archiveAndTruncate",
        table: "flows_time_travel_edges",
        // The fence guard reads `flows_runs` before the dropped table is
        // touched, so the run must exist under the fence's owner first.
        prepare: (sql: SqlClient.SqlClient) => insertOwnedRun(sql, "run"),
        invoke: (store: TimeTravelStore.Service) => store.archiveAndTruncate("run", audit.frame, [], owner)
      },
      {
        method: "createFork",
        table: "flows_runs",
        invoke: (store: TimeTravelStore.Service) => store.createFork("run", audit.frame)
      },
      {
        method: "nextForkId",
        table: "flows_time_travel_fork_intents",
        invoke: (store: TimeTravelStore.Service) => store.nextForkId("run", audit.frame)
      },
      {
        method: "abandonForkIntents",
        table: "flows_time_travel_fork_intents",
        invoke: (store: TimeTravelStore.Service) => store.abandonForkIntents(1)
      },
      {
        method: "recordReceipt",
        table: "flows_time_travel_receipts",
        invoke: (store: TimeTravelStore.Service) =>
          store.recordReceipt({ id: "receipt", auditId: "audit", effectId: "effect", receipt: {} })
      }
    ] as const
  ) {
    it.effect(`maps a ${scenario.method} database failure to the store's typed error`, () =>
      Effect.gen(function*() {
        const failure = yield* run((store, sql) =>
          Effect.gen(function*() {
            if ("prepare" in scenario) {
              yield* scenario.prepare(sql)
            }
            yield* sql.unsafe(`DROP TABLE ${scenario.table}${Dialect.isPostgres(sql) ? " CASCADE" : ""}`)
            return yield* Effect.flip(scenario.invoke(store))
          })
        )

        expect(failure).toMatchObject({
          code: "unknown",
          message: "time-travel persistence failed",
          cause: expect.anything()
        })
      }))
  }

  it.effect("rolls journal archival back when receipt persistence fails at commit", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* insertOwnedRun(sql, "run")
          for (const seq of [0, 2]) {
            yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('run', ${seq}, ${`event-${seq}`}, 'source', ${seq}, 0, 'test', '{}', '{}')
            `
          }
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES
              ('run', 3, 'deferred-3', 'source', 3, 0,
               'flows.engine.deferred-completed',
               ${JSON.stringify({ flowName: "Demo", executionId: "run", deferredName: "answer" })}, '{}'),
              ('run', 4, 'clock-4', 'source', 4, 0,
               'flows.engine.clock-scheduled',
               ${
            JSON.stringify({
              flowName: "Demo",
              executionId: "run",
              clockName: "wake",
              deferredName: "wake-deferred",
              dueAtMs: 10
            })
          }, '{}')
          `
          yield* sql`
            INSERT INTO flows_deferred_completions
              (flow_name, execution_id, deferred_name, exit_json, completed_at_ms)
            VALUES ('Demo', 'run', 'answer', '{"_tag":"Success"}', 0)
          `
          yield* sql`
            INSERT INTO flows_clock_deadlines
              (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
            VALUES ('Demo', 'run', 'wake', 'wake-deferred', 10, NULL)
          `
          yield* store.recordReceipt({
            id: "duplicate",
            auditId: "audit",
            effectId: "existing",
            receipt: { existing: true }
          })

          const failure = yield* Effect.flip(
            store.archiveAndTruncate("run", { lineageId: "main", seq: 0 }, [{
              id: "duplicate",
              auditId: "audit",
              effectId: "new",
              receipt: { existing: false }
            }], owner)
          )
          const journal = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events WHERE run_id = 'run' ORDER BY seq
        `
          const archive = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_time_travel_archive WHERE run_id = 'run' ORDER BY seq
        `
          const receipts = yield* sql<{ readonly id: string; readonly effect_id: string }>`
          SELECT id, effect_id FROM flows_time_travel_receipts ORDER BY id
        `
          const deferreds = yield* sql<{ readonly deferred_name: string }>`
            SELECT deferred_name FROM flows_deferred_completions WHERE execution_id = 'run'
          `
          const clocks = yield* sql<{ readonly clock_name: string }>`
            SELECT clock_name FROM flows_clock_deadlines WHERE execution_id = 'run'
          `
          return { failure, journal, archive, receipts, deferreds, clocks }
        })
      )

      expect(result.failure).toMatchObject({ code: "unknown", message: "time-travel persistence failed" })
      expect(result.journal).toEqual([{ seq: 0 }, { seq: 2 }, { seq: 3 }, { seq: 4 }])
      expect(result.archive).toEqual([])
      expect(result.receipts).toEqual([{ id: "duplicate", effect_id: "existing" }])
      expect(result.deferreds).toEqual([{ deferred_name: "answer" }])
      expect(result.clocks).toEqual([{ clock_name: "wake" }])
    }))
})

describe("SqlTimeTravelStore.archiveAndTruncate attempts", () => {
  it.effect("keeps only parent attempts named by the surviving prefix and removes attached-child attempts", () =>
    Effect.gen(function*() {
      const rows = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* insertOwnedRun(sql, "attempt-parent")
          yield* insertRun(sql, "attempt-child", { status: "completed" })
          for (const [seq, digest] of [[1, "survives"], [5, "future"]] as const) {
            yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                 event_type, payload_json, meta_json)
              VALUES (
                'attempt-parent', ${seq}, ${`attempt-${seq}`}, 'source', ${seq}, 0,
                'flows.engine.attempt-started',
                ${JSON.stringify({ stepKeyDigest: digest, attempt: 1 })},
                ${JSON.stringify({ lineageId: "main" })}
              )
            `
            yield* sql`
              INSERT INTO flows_attempts
                (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
              VALUES ('attempt-parent', ${digest}, 1, 'succeeded', 0, '{}')
            `
          }
          yield* sql`
            INSERT INTO flows_time_travel_edges
              (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES ('attempt-parent', 5, 'attempt-child', 'child', 1)
          `
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('attempt-child', 0, 'child-0', 'source', 0, 0, 'test', '{}', '{}')
          `
          yield* sql`
            INSERT INTO flows_attempts
              (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
            VALUES ('attempt-child', 'child-future', 1, 'succeeded', 0, '{}')
          `

          yield* store.archiveAndTruncate(
            "attempt-parent",
            { lineageId: "main", seq: 1 },
            [],
            owner
          )
          return yield* sql<{
            readonly run_id: string
            readonly step_key_digest: string
            readonly attempt: number
          }>`
            SELECT run_id, step_key_digest, attempt
            FROM flows_attempts
            WHERE run_id IN ('attempt-parent', 'attempt-child')
            ORDER BY run_id, step_key_digest
          `
        })
      )

      expect(rows).toEqual([{ run_id: "attempt-parent", step_key_digest: "survives", attempt: 1 }])
    }))
})

describe("SqlTimeTravelStore.archiveAndTruncate durable waits", () => {
  it.effect("removes only archived wait projections and lets a re-reached clock schedule anew", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* insertOwnedRun(sql, "wait-run")
          for (
            const record of [
              {
                seq: 1,
                eventType: "flows.engine.deferred-completed",
                payload: { flowName: "Demo", executionId: "wait-run", deferredName: "kept-deferred" }
              },
              {
                seq: 2,
                eventType: "flows.engine.clock-scheduled",
                payload: {
                  flowName: "Demo",
                  executionId: "wait-run",
                  clockName: "kept-clock",
                  deferredName: "kept-clock-deferred",
                  dueAtMs: 10
                }
              },
              {
                seq: 3,
                eventType: "flows.engine.deferred-completed",
                payload: { flowName: "Demo", executionId: "wait-run", deferredName: "future-deferred" }
              },
              {
                seq: 4,
                eventType: "flows.engine.clock-scheduled",
                payload: {
                  flowName: "Demo",
                  executionId: "wait-run",
                  clockName: "future-clock",
                  deferredName: "future-clock-deferred",
                  dueAtMs: 20
                }
              }
            ] as const
          ) {
            yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                 event_type, payload_json, meta_json)
              VALUES (
                'wait-run', ${record.seq}, ${`wait-${record.seq}`}, 'source', ${record.seq}, 0,
                ${record.eventType}, ${JSON.stringify(record.payload)}, ${JSON.stringify({ lineageId: "main" })}
              )
            `
          }
          for (const deferredName of ["kept-deferred", "future-deferred", "unrecorded-deferred"]) {
            yield* sql`
              INSERT INTO flows_deferred_completions
                (flow_name, execution_id, deferred_name, exit_json, completed_at_ms)
              VALUES ('Demo', 'wait-run', ${deferredName}, '{"_tag":"Success"}', 0)
            `
          }
          for (
            const [clockName, deferredName] of [
              ["kept-clock", "kept-clock-deferred"],
              ["future-clock", "future-clock-deferred"],
              ["unrecorded-clock", "unrecorded-clock-deferred"]
            ] as const
          ) {
            yield* sql`
              INSERT INTO flows_clock_deadlines
                (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
              VALUES ('Demo', 'wait-run', ${clockName}, ${deferredName}, 10, NULL)
            `
          }

          yield* store.archiveAndTruncate("wait-run", { lineageId: "main", seq: 2 }, [], owner)

          const deferreds = yield* sql<{ readonly deferred_name: string }>`
              SELECT deferred_name FROM flows_deferred_completions
              WHERE execution_id = 'wait-run' ORDER BY deferred_name
            `
          const clocks = yield* sql<{ readonly clock_name: string }>`
              SELECT clock_name FROM flows_clock_deadlines
              WHERE execution_id = 'wait-run' ORDER BY clock_name
            `
          // Reaching the clock again must insert a fresh deadline. Before the
          // cleanup this loses the primary-key race to the discarded future's
          // old row and the sleep is immediately due once wall time passes it.
          yield* sql`
            INSERT INTO flows_clock_deadlines
              (flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms)
            VALUES ('Demo', 'wait-run', 'future-clock', 'future-clock-deferred', 999, NULL)
            ON CONFLICT (flow_name, execution_id, clock_name) DO NOTHING
          `
          const rescheduled = yield* sql<{ readonly due_at_ms: number }>`
            SELECT due_at_ms FROM flows_clock_deadlines
            WHERE execution_id = 'wait-run' AND clock_name = 'future-clock'
          `
          return {
            deferreds,
            clocks,
            rescheduled
          }
        })
      )

      expect(result.deferreds).toEqual([
        { deferred_name: "kept-deferred" },
        { deferred_name: "unrecorded-deferred" }
      ])
      expect(result.clocks).toEqual([
        { clock_name: "kept-clock" },
        { clock_name: "unrecorded-clock" }
      ])
      expect(result.rescheduled).toEqual([{ due_at_ms: 999 }])
    }))
})

describe("SqlTimeTravelStore.recordReceipt", () => {
  it.effect("persists a receipt row that archiveAndTruncate can then append to", () =>
    Effect.gen(function*() {
      const rows = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* store.recordReceipt({ id: "r1", auditId: "audit", effectId: "effect-a", receipt: { undone: true } })
          yield* insertOwnedRun(sql, "run")
          yield* store.archiveAndTruncate("run", { lineageId: "main", seq: 0 }, [
            { id: "r2", auditId: "audit", effectId: "effect-b", receipt: { undone: false } }
          ], owner)
          return yield* sql<
            { readonly id: string; readonly effect_id: string; readonly receipt_json: string }
          >`SELECT id, effect_id, receipt_json FROM flows_time_travel_receipts ORDER BY id`
        })
      )

      expect(rows).toEqual([
        { id: "r1", effect_id: "effect-a", receipt_json: JSON.stringify({ undone: true }) },
        { id: "r2", effect_id: "effect-b", receipt_json: JSON.stringify({ undone: false }) }
      ])
    }))
})

describe("SqlTimeTravelStore derived reads", () => {
  it.effect("reads back the plan digest an anchor recorded, and refuses an attempt record it cannot decode", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* store.recordSnapshot({
            runId: "derived",
            frame: { lineageId: "derived/root", seq: 1 },
            changeId: "change-1",
            planDigest: "plan-a"
          })
          yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES
            ('derived', 0, 'd0', 's', 0, 0, 'flows.engine.attempt-started',
             ${JSON.stringify({ stepKeyDigest: "a", attempt: 1 })}, ${JSON.stringify({ lineageId: "derived/root" })}),
            ('derived', 1, 'd1', 's', 1, 0, 'flows.engine.attempt-started',
             ${JSON.stringify({ nothing: true })}, ${JSON.stringify({ lineageId: "derived/root" })})
        `
          return {
            anchor: yield* store.snapshotAt("derived", { lineageId: "derived/root", seq: 2 }),
            attempts: yield* Effect.flip(store.attemptsAt("derived", { lineageId: "derived/root", seq: 2 })),
            absent: yield* store.stateAt("derived", { lineageId: "derived/root", seq: 2 })
          }
        })
      )

      expect(result.anchor).toEqual({
        runId: "derived",
        frame: { lineageId: "derived/root", seq: 1 },
        changeId: "change-1",
        planDigest: "plan-a"
      })
      // Corrupt known history cannot become a shorter, apparently healthy state.
      expect(result.attempts.code).toBe("invalid")
      expect(result.attempts.cause).toBeDefined()
      expect(result.absent).toBeUndefined()
    }))
})

describe("SqlTimeTravelStore.nextForkId", () => {
  const frame = { lineageId: "mint/root", seq: 0 } as const

  const seedParent = (sql: SqlClient.SqlClient) =>
    Effect.gen(function*() {
      yield* insertRun(sql, "mint")
      yield* sql`
        INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
           event_type, payload_json, meta_json)
        VALUES ('mint', 0, 'mint-0', 'source', 0, 0,
                'flows.engine.run-decision',
                ${JSON.stringify({ state: { version: 1, flowName: "Demo", payload: {} } })},
                ${JSON.stringify({ lineageId: "mint/root" })})
      `
    })

  // The store operation the fork verb calls before it provisions a workspace.
  // A mint is a durable reservation: it used to repeat the id until a fork
  // committed, so a process that died between provisioning the lane and
  // committing retried under the same id and jj refused its own leftover.
  it.effect("advances on every mint, and a committed fork consumes its reservation", () =>
    run((store, sql) =>
      Effect.gen(function*() {
        yield* seedParent(sql)

        const first = yield* store.nextForkId("mint", frame)
        const again = yield* store.nextForkId("mint", frame)
        const child = yield* store.createFork("mint", frame, first)
        const afterCommit = yield* store.nextForkId("mint", frame)
        const reserved = yield* sql<{ readonly child_run_id: string }>`
          SELECT child_run_id FROM flows_time_travel_fork_intents ORDER BY child_run_id
        `

        expect(first).toBe("mint:fork:0:1")
        expect(again).toBe("mint:fork:0:2")
        expect(child.runId).toBe(first)
        expect(afterCommit).toBe("mint:fork:0:3")
        // The committed fork's reservation became its edge; the other two stand.
        expect(reserved.map((row) => row.child_run_id)).toEqual(["mint:fork:0:2", "mint:fork:0:3"])
      })
    ))

  it.effect("writes only a reservation, so an abandoned mint leaves no run and no edge", () =>
    run((store, sql) =>
      Effect.gen(function*() {
        yield* seedParent(sql)

        const minted = yield* store.nextForkId("mint", frame)

        const runs = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM flows_runs`
        const edges = yield* sql<
          { readonly child_run_id: string }
        >`SELECT child_run_id FROM flows_time_travel_edges`
        const intents = yield* sql<{
          readonly child_run_id: string
          readonly parent_run_id: string
          readonly parent_seq: number
          readonly reclaimed_at_ms: number | null
        }>`SELECT child_run_id, parent_run_id, parent_seq, reclaimed_at_ms FROM flows_time_travel_fork_intents`
        expect(runs.map((row) => row.run_id)).toEqual(["mint"])
        expect(edges).toEqual([])
        expect(intents).toEqual([
          { child_run_id: minted, parent_run_id: "mint", parent_seq: 0, reclaimed_at_ms: null }
        ])
      })
    ))

  it.effect("hands a stale reservation back exactly once and keeps its ordinal taken", () =>
    run((store, sql) =>
      Effect.gen(function*() {
        yield* seedParent(sql)
        const minted = yield* store.nextForkId("mint", frame)

        // Reserved at the test clock's zero: "before 0" names nothing, and
        // "before 1" names it.
        const fresh = yield* store.abandonForkIntents(0)
        const stale = yield* store.abandonForkIntents(1)
        const again = yield* store.abandonForkIntents(1)
        const next = yield* store.nextForkId("mint", frame)
        const rows = yield* sql<{ readonly child_run_id: string; readonly reclaimed_at_ms: number | null }>`
          SELECT child_run_id, reclaimed_at_ms FROM flows_time_travel_fork_intents ORDER BY child_run_id
        `

        expect(fresh).toEqual([])
        expect(stale).toEqual([{ childRunId: minted, parentRunId: "mint", parentSeq: 0, reservedAtMs: 0 }])
        expect(again).toEqual([])
        // The reclaimed lane may still exist on disk, so its number is never
        // handed to a fresh lane.
        expect(next).toBe("mint:fork:0:2")
        expect(rows).toEqual([
          { child_run_id: "mint:fork:0:1", reclaimed_at_ms: 0 },
          { child_run_id: "mint:fork:0:2", reclaimed_at_ms: null }
        ])
      })
    ))
})

describe("SqlTimeTravelStore.createFork", () => {
  it.effect("creates distinct coherent forks when two store handles race at one parent frame", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-store-race-")))
      const filename = join(directory, "store.sqlite")
      try {
        yield* (
          fileHandle(filename, (_store, sql) =>
            Effect.gen(function*() {
              yield* insertRun(sql, "concurrent-parent")
              yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                 event_type, payload_json, meta_json)
              VALUES ('concurrent-parent', 0, 'concurrent-0', 'source', 0, 0,
                      'flows.engine.run-decision',
                      ${JSON.stringify({ state: { version: 1, flowName: "Demo", payload: {} } })},
                      ${JSON.stringify({ lineageId: "concurrent-parent/root" })})
            `
            }))
        )

        const result = yield* (
          Effect.gen(function*() {
            const readyA = yield* Deferred.make<void>()
            const readyB = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const race = (ready: Deferred.Deferred<void>) =>
              fileHandle(filename, (store) =>
                Deferred.succeed(ready, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    store.createFork("concurrent-parent", { lineageId: "concurrent-parent/root", seq: 0 })
                  )
                ))
            // Each child scope constructs its own NodeDatabase, SqlClient,
            // DurableWriter, and SqlTimeTravelStore over the same file.
            const fiberA = yield* Effect.forkChild(race(readyA), { startImmediately: true })
            const fiberB = yield* Effect.forkChild(race(readyB), { startImmediately: true })
            yield* Deferred.await(readyA)
            yield* Deferred.await(readyB)
            yield* Deferred.succeed(release, undefined)
            return { first: yield* Fiber.join(fiberA), second: yield* Fiber.join(fiberB) }
          })
        )
        const edges = yield* (
          fileHandle(filename, (_store, sql) =>
            sql<{
              readonly parent_run_id: string
              readonly parent_seq: number
              readonly child_run_id: string
            }>`
            SELECT parent_run_id, parent_seq, child_run_id
            FROM flows_time_travel_edges
            WHERE parent_run_id = 'concurrent-parent'
            ORDER BY child_run_id
          `)
        )

        expect(result.first.runId).not.toBe(result.second.runId)
        expect(edges).toEqual([
          { parent_run_id: "concurrent-parent", parent_seq: 0, child_run_id: result.first.runId },
          { parent_run_id: "concurrent-parent", parent_seq: 0, child_run_id: result.second.runId }
        ].sort((left, right) => left.child_run_id.localeCompare(right.child_run_id)))
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  it.effect("derives state and attempts AT the frame, marks the fork, and numbers repeated forks", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          // The run row holds the run's state NOW — terminal, with a result and a
          // cancellation. The fork must not inherit any of it; it must rebuild
          // the state the frame recorded.
          yield* insertRun(sql, "parent", {
            stateJson: JSON.stringify({
              version: 1,
              flowName: "Demo",
              payload: { seed: "final" },
              result: { _tag: "Success" },
              cancellation: { interruptedAtMs: 1 }
            })
          })
          const event = (seq: number, eventType: string, payload: unknown) =>
            sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES (
              'parent', ${seq}, ${`e${seq}`}, 'source', ${seq}, 0, ${eventType},
              ${JSON.stringify(payload)}, ${JSON.stringify({ lineageId: "main" })}
            )
          `
          yield* event(0, "flows.engine.run-decision", {
            decision: "created",
            state: { version: 1, flowName: "Demo", payload: { seed: "at-frame" } }
          })
          yield* event(1, "flows.engine.attempt-started", { stepKeyDigest: "digest", attempt: 1 })
          // Everything below the fork frame: a later state the child must not
          // inherit, and a later attempt its copied journal cannot explain.
          yield* event(2, "flows.engine.attempt-started", { stepKeyDigest: "later", attempt: 1 })
          yield* event(3, "flows.engine.run-decision", {
            decision: "transitioned",
            state: { version: 1, flowName: "Demo", payload: { seed: "final" } }
          })
          for (const digest of ["digest", "later"]) {
            yield* sql`
            INSERT INTO flows_attempts
              (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
               heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json)
            VALUES ('parent', ${digest}, 1, 'succeeded', 0, 1, 1, NULL, NULL, '{}', '{}')
          `
          }

          const first = yield* store.createFork("parent", { lineageId: "main", seq: 1 })
          const second = yield* store.createFork("parent", { lineageId: "main", seq: 1 })
          const forkEvents = yield* sql<
            {
              readonly seq: number
              readonly event_id: string
              readonly event_type: string
              readonly payload_json: string
            }
          >`
          SELECT seq, event_id, event_type, payload_json
          FROM flows_journal_events WHERE run_id = ${first.runId} ORDER BY seq
        `
          const forkRun = yield* sql<{ readonly status: string; readonly state_json: string }>`
          SELECT status, state_json FROM flows_runs WHERE run_id = ${first.runId}
        `
          const forkAttempts = yield* sql<{ readonly step_key_digest: string }>`
          SELECT step_key_digest FROM flows_attempts WHERE run_id = ${first.runId} ORDER BY step_key_digest
        `
          const parentAttempts = yield* sql<{ readonly step_key_digest: string }>`
          SELECT step_key_digest FROM flows_attempts WHERE run_id = 'parent' ORDER BY step_key_digest
        `
          return { first, second, forkEvents, forkRun, forkAttempts, parentAttempts }
        })
      )

      expect(result.first.runId).toBe("parent:fork:1:1")
      expect(result.second.runId).toBe("parent:fork:1:2")
      // The store commits the row and nothing else: the warnings a fork
      // discloses are computed above it and ride `TimeTravel.ForkResult`.
      expect(Object.keys(result.first).sort()).toEqual(["edge", "runId"])
      expect(result.first.edge).toEqual({
        parentRunId: "parent",
        parentSeq: 1,
        childRunId: "parent:fork:1:1",
        kind: "fork",
        attached: false
      })
      // The copied prefix, then the fork-created marker directly above it.
      expect(result.forkEvents.map((row) => row.seq)).toEqual([0, 1, 2])
      expect(result.forkEvents[0]!.event_id).toBe("fork:parent:fork:1:1:e0")
      expect(result.forkEvents[2]!.event_type).toBe(Frame.forkCreatedEventType)
      expect(JSON.parse(result.forkEvents[2]!.payload_json)).toEqual({
        parentRunId: "parent",
        forkJournalOffset: 1,
        childRunId: "parent:fork:1:1"
      })
      expect(result.forkRun[0]!.status).toBe("pending")
      // The state AT the frame, not the parent's current state.
      expect(JSON.parse(result.forkRun[0]!.state_json)).toEqual({
        version: 1,
        flowName: "Demo",
        payload: { seed: "at-frame" }
      })
      // Filtered to the frame: `later` started after it and is not inherited,
      // while the parent keeps both.
      expect(result.forkAttempts).toEqual([{ step_key_digest: "digest" }])
      expect(result.parentAttempts).toEqual([{ step_key_digest: "digest" }, { step_key_digest: "later" }])
    }))

  it.effect("surfaces a missing parent as a typed `not_found` failure", () =>
    Effect.gen(function*() {
      const error = yield* run((store) => Effect.flip(store.createFork("ghost", { lineageId: "main", seq: 0 })))

      expect(error).toMatchObject({ code: "not_found", message: "parent ghost was not found" })
    }))

  for (
    const scenario of [
      { name: "is running and owned", running: true },
      { name: "is only claimed by another host", running: false }
    ] as const
  ) {
    it.effect(`refuses to fork when the parent ${scenario.name}`, () =>
      Effect.gen(function*() {
        const error = yield* run((store, sql) =>
          Effect.gen(function*() {
            yield* scenario.running
              ? insertRunningRun(sql, "parent")
              : insertRun(sql, "parent", { claimHostId: "host-b" })
            return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
          })
        )

        expect(error).toMatchObject({ code: "live_parent", message: "parent parent is live" })
      }))
  }

  it.effect("refuses to fork when a transitive ancestor is live", () =>
    Effect.gen(function*() {
      const error = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* insertRunningRun(sql, "grandparent")
          yield* insertRun(sql, "parent")
          yield* sql`
          INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('grandparent', 0, 'parent', 'fork', 0)
        `
          return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
        })
      )

      expect(error).toMatchObject({ code: "live_parent", message: "ancestor run grandparent is live" })
    }))

  it.effect("rejects malformed JSON as a restartable parent state", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "time-travel-corrupt-state-")))
      const filename = join(directory, "state.db")
      const encoded = JSON.stringify({ version: 1, flowName: "CorruptStateFixtureA2", payload: {} })
      yield* Effect.gen(function*() {
        yield* fileHandle(filename, (_store, sql) => insertRun(sql, "parent", { stateJson: encoded }))
        // Generated JSON columns correctly refuse malformed writes even with
        // CHECK constraints disabled. Model actual disk corruption after the
        // writer closes, without changing the production schema or indexes.
        yield* Effect.promise(async () => {
          const bytes = await readFile(filename)
          const needle = Buffer.from(encoded)
          const offset = bytes.indexOf(needle)
          expect(offset).toBeGreaterThanOrEqual(0)
          expect(bytes.lastIndexOf(needle)).toBe(offset)
          bytes[offset] = "!".charCodeAt(0)
          await writeFile(filename, bytes)
        })
        const failure = yield* fileHandle(filename, (store) =>
          Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 })))
        expect(failure).toMatchObject({ code: "unknown", message: "could not materialize executable fork state" })
        expect(failure.cause).toBeDefined()
      }).pipe(Effect.ensuring(Effect.promise(() =>
        rm(directory, { recursive: true, force: true })
      )))
    }))

  for (
    const [name, stateJson] of [
      ["null", JSON.stringify(null)],
      ["an array", JSON.stringify([])],
      ["a missing version", JSON.stringify({ flowName: "Demo", payload: {} })],
      ["a newer version", JSON.stringify({ version: 2, flowName: "Demo", payload: {} })],
      ["a non-string flow name", JSON.stringify({ version: 1, flowName: 1, payload: {} })],
      ["a missing payload", JSON.stringify({ version: 1, flowName: "Demo" })]
    ] as const
  ) {
    it.effect(`rejects ${name} as a restartable parent state`, () =>
      Effect.gen(function*() {
        const failure = yield* run((store, sql) =>
          Effect.gen(function*() {
            yield* TestDatabase.checks(sql, false)
            yield* insertRun(sql, "parent", { stateJson })
            return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
          })
        )

        expect(failure).toMatchObject({ code: "unknown", message: "could not materialize executable fork state" })
      }))
  }
})

describe("SqlTimeTravelStore attempt statements", () => {
  /** Records every compiled statement that names `flows_attempts`. */
  const recordAttemptStatements = (sql: SqlClient.SqlClient) => {
    const statements: Array<string> = []
    const instrumented = new Proxy(sql, {
      apply(target, thisArg, args) {
        const statement: Statement.Statement<unknown> = Reflect.apply(target, thisArg, args)
        if (typeof args[0] === "string") return statement
        const [text] = statement.compile()
        if (text.includes("flows_attempts")) statements.push(text.replace(/\s+/g, " ").trim())
        return statement
      }
    })
    return { statements, instrumented }
  }

  const insertAttempts = (sql: SqlClient.SqlClient, runId: string, digests: ReadonlyArray<string>) =>
    Effect.forEach(digests, (digest, index) =>
      Effect.gen(function*() {
        const seq = index + 1
        yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
             event_type, payload_json, meta_json)
          VALUES (
            ${runId}, ${seq}, ${`attempt-${seq}`}, 'source', ${seq}, 0,
            'flows.engine.attempt-started',
            ${JSON.stringify({ stepKeyDigest: digest, attempt: 1 })},
            ${JSON.stringify({ lineageId: "main" })}
          )
        `
        yield* sql`
          INSERT INTO flows_attempts
            (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
          VALUES (${runId}, ${digest}, 1, 'succeeded', 0, '{}')
        `
      }))

  it.effect("createFork copies every surviving attempt with one set-based statement", () =>
    run((_store, sql) =>
      Effect.gen(function*() {
        const { instrumented, statements } = recordAttemptStatements(sql)
        const store = yield* SqlTimeTravelStore.make.pipe(Effect.provideService(SqlClient.SqlClient, instrumented))
        yield* insertRun(sql, "set-parent")
        yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
             event_type, payload_json, meta_json)
          VALUES ('set-parent', 0, 'set-0', 'source', 0, 0, 'flows.engine.run-decision',
                  ${JSON.stringify({ state: { version: 1, flowName: "Demo", payload: {} } })},
                  ${JSON.stringify({ lineageId: "main" })})
        `
        yield* insertAttempts(sql, "set-parent", ["a", "b", "c", "future"])
        statements.length = 0
        yield* store.createFork("set-parent", { lineageId: "main", seq: 3 }, "set-child")
        const copied = yield* sql<{ readonly step_key_digest: string; readonly attempt: number }>`
          SELECT step_key_digest, attempt FROM flows_attempts WHERE run_id = 'set-child' ORDER BY step_key_digest
        `
        expect(copied).toEqual([
          { step_key_digest: "a", attempt: 1 },
          { step_key_digest: "b", attempt: 1 },
          { step_key_digest: "c", attempt: 1 }
        ])
        const inserts = statements.filter((text) => text.startsWith("INSERT INTO flows_attempts"))
        expect(inserts).toHaveLength(1)
        expect(inserts[0]).toMatch(/json_each|jsonb_array_elements/)
      })
    ))

  it.effect("archiveAndTruncate removes every unexplained attempt with one set-based statement", () =>
    run((_store, sql) =>
      Effect.gen(function*() {
        const { instrumented, statements } = recordAttemptStatements(sql)
        const store = yield* SqlTimeTravelStore.make.pipe(Effect.provideService(SqlClient.SqlClient, instrumented))
        yield* insertOwnedRun(sql, "set-truncate")
        yield* insertAttempts(sql, "set-truncate", ["a", "b", "c", "d"])
        statements.length = 0
        yield* store.archiveAndTruncate("set-truncate", { lineageId: "main", seq: 1 }, [], owner)
        const kept = yield* sql<{ readonly step_key_digest: string; readonly attempt: number }>`
          SELECT step_key_digest, attempt FROM flows_attempts WHERE run_id = 'set-truncate'
        `
        expect(kept).toEqual([{ step_key_digest: "a", attempt: 1 }])
        expect(statements.filter((text) => text.startsWith("SELECT step_key_digest, attempt FROM flows_attempts")))
          .toHaveLength(0)
        const deletes = statements.filter((text) => text.startsWith("DELETE FROM flows_attempts"))
        expect(deletes).toHaveLength(1)
        expect(deletes[0]).toMatch(/json_each|jsonb_array_elements/)
      })
    ))
})
