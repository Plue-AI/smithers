import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"
import { awaitCheckpoint, jjInstalled, killHard, runReal, runState, withRealFixture } from "./RealTimeTravelHarness.ts"

const childFixture = fileURLToPath(new URL("./fixtures/rewind-crash-child.ts", import.meta.url))

describe.skipIf(!jjInstalled)("rewind crash recovery over file SQLite", () => {
  it.effect(
    "recovers the original tree after SIGKILL between jj.restore and the compensated audit write",
    () =>
      withRealFixture("flows-rewind-restore-crash-", (fixture) =>
        Effect.gen(function*() {
          const runId = "workspace-crash"
          const note = join(fixture.repository, "note.txt")
          yield* Effect.promise(() => writeFile(note, "target\n"))
          yield* runReal(
            fixture.databaseFile,
            Effect.gen(function*() {
              const jj = yield* Jj
              const target = yield* jj.snapshot("target")
              const store = yield* TimeTravelStore
              yield* store.recordSnapshot({
                runId,
                frame: { lineageId: `${runId}/root`, seq: 0 },
                changeId: target.commitId
              })
              const sql = yield* SqlClient.SqlClient
              yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES (${runId}, 'suspended', 0, ${runState("WorkspaceCrash")})
          `
              const meta = JSON.stringify({ lineageId: `${runId}/root` })
              const boundary = JSON.stringify({
                version: 1,
                effect: {
                  id: "write",
                  kind: "fs",
                  tier: "compensable",
                  status: "succeeded",
                  runId,
                  lineageId: `${runId}/root`,
                  durableBoundary: true,
                  providerStream: false
                }
              })
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES (${runId}, 0, 'workspace-base', 'crash', 0, 0, 'baseline', '{}', ${meta}),
                   (${runId}, 1, 'workspace-effect', 'crash', 1, 1, ${EffectBoundary.eventType}, ${boundary}, ${meta})
          `
            })
          )
          yield* Effect.promise(() => writeFile(note, "original\n"))
          const child = spawn(process.execPath, [childFixture, fixture.databaseFile, runId, "after-restore"], {
            cwd: fixture.repository,
            env: { ...process.env, JJ_EDITOR: "true" }
          })
          try {
            expect(yield* Effect.promise(() => awaitCheckpoint(child, "workspace crash child"))).toEqual({
              stage: "after-restore"
            })
            yield* Effect.promise(() => killHard(child))
            expect(yield* Effect.promise(() => readFile(note, "utf8"))).toBe("target\n")
            yield* runReal(
              fixture.databaseFile,
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                const audits = yield* sql<{ readonly detail_json: string }>`
              SELECT detail_json FROM flows_time_travel_audits WHERE id = ${`${runId}-audit`}
            `
                expect(JSON.parse(audits[0]!.detail_json)).toMatchObject({
                  phase: "preflight_complete",
                  compensation: {
                    workspace: { currentChangeId: expect.any(String), targetChangeId: expect.any(String) }
                  }
                })
                yield* sql`UPDATE flows_runs SET started_at_ms = 0, heartbeat_at_ms = 0 WHERE run_id = ${runId}`
                yield* sql`UPDATE flows_consensus_leases SET heartbeat_at_ms = 0 WHERE run_id = ${runId}`
              })
            )
            yield* TestClock.adjust("1 minute")
            yield* runReal(
              fixture.databaseFile,
              Effect.gen(function*() {
                yield* TimeTravel
                const sql = yield* SqlClient.SqlClient
                const audits = yield* sql<{ readonly status: string; readonly detail_json: string }>`
              SELECT status, detail_json FROM flows_time_travel_audits WHERE id = ${`${runId}-audit`}
            `
                expect(audits[0]!.status).toBe("failed")
                expect(JSON.parse(audits[0]!.detail_json).phase).toBe("rolled_back")
              })
            )
            expect(yield* Effect.promise(() => readFile(note, "utf8"))).toBe("original\n")
          } finally {
            yield* Effect.promise(() => killHard(child))
          }
        })),
    { timeout: 120_000 }
  )

  // The finite budget covers four real child processes, SIGKILL, and fresh recovery layers.
  it.effect("recovers real process deaths after audit write and archive commit", () =>
    Effect.gen(function*() {
      for (const stage of ["after-audit", "after-archive", "before-child-cancel", "before-commit"] as const) {
        yield* withRealFixture(`flows-rewind-${stage}-`, (fixture) =>
          Effect.gen(function*() {
            const runId = `run-${stage}`
            const hasChild = stage === "before-child-cancel" || stage === "before-commit"
            const committed = stage === "after-archive" || stage === "before-child-cancel"
            const held = stage !== "after-archive"
            yield* runReal(
              fixture.databaseFile,
              Effect.gen(function*() {
                const sql = yield* Effect.service(SqlClient.SqlClient)
                yield* sql`
              INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
              VALUES (${runId}, 'suspended', 0, ${runState("KilledRewind")})
            `
                yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
              VALUES (${runId}, 0, ${`${runId}-0`}, 'killed-rewind', 0, 0, 'baseline', '{}',
                      ${JSON.stringify({ lineageId: `${runId}/root` })}),
                     (${runId}, 1, ${`${runId}-1`}, 'killed-rewind', 1, 1, 'suffix', '{}',
                      ${JSON.stringify({ lineageId: `${runId}/root` })})
            `
                if (hasChild) {
                  yield* sql`
                    INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
                    VALUES (${`${runId}-child`}, 'suspended', 0, ${runState("RewindChild")})
                  `
                  yield* sql`
                    INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
                    VALUES (${runId}, 1, ${`${runId}-child`}, 'child', 0)
                  `
                }
              })
            )
            const child = spawn(process.execPath, [childFixture, fixture.databaseFile, runId, stage], {
              cwd: fixture.repository,
              env: { ...process.env, JJ_EDITOR: "true" }
            })
            try {
              expect(yield* Effect.promise(() => awaitCheckpoint<{ readonly stage: string }>(child, "crash child")))
                .toEqual({ stage })
              yield* Effect.promise(() => killHard(child))
              const recovered = yield* runReal(
                fixture.databaseFile,
                Effect.gen(function*() {
                  const timeTravel = yield* TimeTravel
                  void timeTravel
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  const audit = yield* sql<{ readonly status: string; readonly detail_json: string }>`
                SELECT status, detail_json FROM flows_time_travel_audits WHERE id = ${`${runId}-audit`}
              `
                  const live = yield* sql<{ readonly seq: number }>`
                SELECT seq FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq
              `
                  const archived = yield* sql<{ readonly seq: number }>`
                SELECT seq FROM flows_time_travel_archive WHERE run_id = ${runId} ORDER BY seq
              `
                  const children = yield* sql<{ readonly status: string; readonly owner_nonce: string | null }>`
                    SELECT status, owner_nonce FROM flows_runs WHERE run_id = ${`${runId}-child`}
                  `
                  return { archived, audit: audit[0]!, live, children }
                })
              )

              // `after-audit` dies holding the run, so the first pass finds it
              // `running` under an owner whose lease has not expired yet and
              // declines. Declining must not CLOSE the audit: marking it
              // `failed` dropped it out of `pendingAudits` forever, and a
              // rewind killed after its compensation would then never be
              // rolled back by anyone. `after-archive` dies after the run is
              // already suspended, so nothing blocks it.
              expect(recovered.children).toEqual(
                hasChild
                  ? [{ status: "running", owner_nonce: `crash-child:${child.pid}:rewind-child:${runId}-child` }]
                  : []
              )
              expect(recovered.audit.status).toBe(held ? "in_progress" : "completed")
              expect(JSON.parse(recovered.audit.detail_json).phase).toBe(
                stage === "after-audit" ? "audit_written" : held ? "compensated" : "completed"
              )
              expect(recovered.live).toEqual(committed ? [{ seq: 0 }] : [{ seq: 0 }, { seq: 1 }])
              expect(recovered.archived).toEqual(committed ? [{ seq: 1 }] : [])

              if (held) {
                // Expire the dead incarnation's lease: its last heartbeat
                // moves to the epoch and the clock moves past the staleness
                // window, which is exactly what wall-clock time does to a
                // process that stopped renewing. The audit is still pending,
                // so the next build steals the run and rolls the rewind back.
                // That is the whole point of declining rather than failing.
                //
                // `started_at_ms` moves with it. `flows_runs` is read back
                // through `RunStore`'s durable-invariant check, and one of
                // those invariants is `heartbeat_at_ms >= started_at_ms`: a
                // heartbeat alone at the epoch, under a start stamped with the
                // child's real wall clock, is a row RunStore refuses to decode
                // at all, so recovery failed reading the run instead of
                // stealing it.
                yield* runReal(
                  fixture.databaseFile,
                  Effect.gen(function*() {
                    const sql = yield* Effect.service(SqlClient.SqlClient)
                    yield* sql`
                  UPDATE flows_runs SET started_at_ms = 0, heartbeat_at_ms = 0 WHERE run_id IN (${runId}, ${`${runId}-child`})
                `
                    yield* sql`
                  UPDATE flows_consensus_leases SET heartbeat_at_ms = 0 WHERE run_id IN (${runId}, ${`${runId}-child`})
                `
                  })
                )
                yield* TestClock.adjust("1 minute")
                const settled = yield* runReal(
                  fixture.databaseFile,
                  Effect.gen(function*() {
                    const timeTravel = yield* TimeTravel
                    void timeTravel
                    const sql = yield* Effect.service(SqlClient.SqlClient)
                    const audit = yield* sql<{ readonly status: string; readonly detail_json: string }>`
                  SELECT status, detail_json FROM flows_time_travel_audits WHERE id = ${`${runId}-audit`}
                `
                    const run = yield* sql<{ readonly status: string }>`
                  SELECT status FROM flows_runs WHERE run_id = ${runId}
                `
                    const children = yield* sql<{ readonly status: string; readonly owner_nonce: string | null }>`
                      SELECT status, owner_nonce FROM flows_runs WHERE run_id = ${`${runId}-child`}
                    `
                    return { audit: audit[0]!, run: run[0]!, children }
                  })
                )

                expect(settled.audit.status).toBe(committed ? "completed" : "failed")
                expect(JSON.parse(settled.audit.detail_json).phase).toBe(committed ? "completed" : "rolled_back")
                expect(settled.run.status).toBe("suspended")
                expect(settled.children).toEqual(
                  hasChild
                    ? [{ status: committed ? "cancelled" : "suspended", owner_nonce: null }]
                    : []
                )
                if (hasChild) expect(JSON.parse(settled.audit.detail_json).pendingChildren).toEqual([])
              }
            } finally {
              yield* Effect.promise(() => killHard(child))
            }
          }))
      }
    }), { timeout: 120_000 })

  // These supplemental fixtures persist exact crash images directly so the
  // corruption variants stay independently nameable beside the SIGKILL cases.
  // The finite budget covers real jj discovery and three database lifetimes.
  it.effect("recovers audit-written and archive-committed crash images exactly once", () =>
    Effect.gen(function*() {
      yield* withRealFixture("flows-rewind-crash-", (fixture) =>
        Effect.gen(function*() {
          yield* runReal(
            fixture.databaseFile,
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              for (const runId of ["after-audit", "after-archive", "intended-only"]) {
                yield* sql`
              INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
              VALUES (${runId}, 'suspended', 0, ${runState("CrashRecovery")})
            `
                yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
              VALUES (${runId}, 0, ${`${runId}-0`}, 'crash', 0, 0, 'baseline',
                      ${JSON.stringify({ value: runId })},
                      ${JSON.stringify({ lineageId: `${runId}/root` })})
            `
              }
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('after-audit', 1, 'after-audit-1', 'crash', 1, 1, 'suffix', '{}',
                    ${JSON.stringify({ lineageId: "after-audit/root" })})
          `
              yield* sql`
            INSERT INTO flows_time_travel_archive
              (run_id, generation, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json, archived_at_ms)
            VALUES ('after-archive', 0, 1, 'after-archive-1', 'crash', 1, 1, 'suffix', '{}',
                    ${JSON.stringify({ lineageId: "after-archive/root" })}, 2)
          `
              const detail = (phase: "audit_written" | "compensated", suffixCount: number) =>
                JSON.stringify({
                  version: 1,
                  phase,
                  originalStatus: "suspended",
                  suffixCount,
                  ...(suffixCount === 0 ? {} : { suffixTailSeq: 1, compensation: { handlerReceipts: [] } }),
                  warnings: [],
                  cancelledChildren: []
                })
              yield* sql`
            INSERT INTO flows_time_travel_audits
              (id, run_id, lineage_id, seq, status, detail_json)
            VALUES
              ('audit-written', 'after-audit', 'after-audit/root', 0, 'in_progress',
               ${detail("audit_written", 0)}),
              ('archive-written', 'after-archive', 'after-archive/root', 0, 'in_progress',
               ${detail("compensated", 1)})
          `
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('intended-only', 1, 'intended-1', 'crash', 1, 1, ${EffectBoundary.eventType},
                    ${
                JSON.stringify({
                  version: 1,
                  effect: {
                    id: "unsettled-send",
                    kind: "mail/send",
                    tier: "irreversible",
                    status: "intended",
                    runId: "intended-only",
                    lineageId: "intended-only/root",
                    durableBoundary: true,
                    providerStream: false
                  }
                })
              }, ${JSON.stringify({ lineageId: "intended-only/root" })})
          `
            })
          )

          const recovered = yield* runReal(
            fixture.databaseFile,
            Effect.gen(function*() {
              // Acquiring TimeTravel is the startup recovery trigger.
              const timeTravel = yield* TimeTravel
              const refusal = yield* Effect.flip(timeTravel.rewind({
                runId: "intended-only",
                frame: { lineageId: "intended-only/root", seq: 0 }
              }))
              const projection = {
                initial: [] as Array<string>,
                reduce: (state: Array<string>, entry: { readonly payload: unknown }) => [
                  ...state,
                  String((entry.payload as { readonly value?: string }).value)
                ]
              }
              const position = {
                runId: "after-audit",
                frame: { lineageId: "after-audit/root", seq: 1 }
              } as const
              const first = yield* timeTravel.inspect(position, projection)
              const second = yield* timeTravel.inspect(position, projection)
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const audits = yield* sql<{ readonly id: string; readonly status: string; readonly detail_json: string }>`
            SELECT id, status, detail_json FROM flows_time_travel_audits
            WHERE id IN ('audit-written', 'archive-written') ORDER BY id
          `
              return { audits, first, refusal, second }
            })
          )

          expect(recovered.audits.map((audit) => ({ id: audit.id, status: audit.status }))).toEqual([
            { id: "archive-written", status: "completed" },
            { id: "audit-written", status: "failed" }
          ])
          expect(recovered.audits.map((audit) => JSON.parse(audit.detail_json).phase)).toEqual([
            "completed",
            "rolled_back"
          ])
          expect(recovered.refusal.code).toBe("irreversible")
          expect(recovered.first).toEqual(["after-audit", "undefined"])
          expect(recovered.second).toEqual(recovered.first)

          const reopened = yield* runReal(
            fixture.databaseFile,
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              return yield* sql<{ readonly status: string }>`
            SELECT status FROM flows_time_travel_audits
            WHERE id IN ('audit-written', 'archive-written') ORDER BY id
          `
            })
          )
          expect(reopened).toEqual([{ status: "completed" }, { status: "failed" }])
        }))
    }), { timeout: 60_000 })
})
