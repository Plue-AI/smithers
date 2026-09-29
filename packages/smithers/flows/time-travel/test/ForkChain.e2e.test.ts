import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { workspaceNameFor } from "../src/internal/Fork.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import { jjInstalled, runReal, runState, withRealFixture } from "./RealTimeTravelHarness.ts"

describe.skipIf(!jjInstalled)("real public fork chain", () => {
  // Every fork-created marker keeps `source_seq = seq`, so a fork-of-fork whose
  // copied prefix reaches the parent's own marker never collides with the new
  // child's on the journal's source-identity constraint.
  // The finite budget covers two public fork lifetimes and real workspace creation.
  it.effect(
    "keeps parent evidence immutable across a fork-of-fork with distinct jj workspaces",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-fork-chain-", (fixture) =>
          Effect.gen(function*() {
            const workspaceRoot = join(fixture.directory, "forks")
            yield* Effect.promise(() => mkdir(workspaceRoot))
            const parentFile = join(fixture.repository, "parent.txt")
            yield* Effect.promise(() => writeFile(parentFile, "parent\n"))

            const first = yield* runReal(
              fixture.databaseFile,
              Effect.gen(function*() {
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const cache = yield* CacheStore.CacheStore
                const jj = yield* Jj.Jj
                const anchor = yield* jj.snapshot("fork-chain root anchor")
                yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('fork-root', 'suspended', 0, ${runState("ForkChain")})
          `
                for (
                  const [seq, eventType, payload] of [
                    [0, "flows.engine.run-decision", { state: { version: 1, flowName: "ForkChain", payload: {} } }],
                    [1, "flows.engine.snapshot-identified", { snapshotId: anchor.changeId }],
                    [2, "flows.engine.attempt-started", { stepKeyDigest: "sealed-digest", attempt: 0 }],
                    [3, "flows.engine.attempt-finished", {
                      stepKeyDigest: "sealed-digest",
                      attempt: 0,
                      state: "succeeded"
                    }]
                  ] as const
                ) {
                  yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
              VALUES ('fork-root', ${seq}, ${`root-${seq}`}, 'fork-chain', ${seq}, 0,
                      ${eventType}, ${JSON.stringify(payload)},
                      ${
                    JSON.stringify({ lineageId: "fork-root/root", ...(seq === 2 ? { cacheKey: "sealed-digest" } : {}) })
                  })
            `
                }
                yield* sql`
            INSERT INTO flows_attempts
              (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
               heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json)
            VALUES ('fork-root', 'sealed-digest', 0, 'succeeded', 0, 1, 1,
                    NULL, NULL, ${JSON.stringify({ value: "cached" })}, '{}')
          `
                yield* cache.put({
                  keyDigest: "sealed-digest",
                  result: { value: "cached" },
                  meta: { identity: "fork-chain" },
                  createdAtMs: 0,
                  recordedRunId: "fork-root",
                  recordedEventSeq: 2
                })
                const parentRows = yield* sql<{ readonly event_id: string }>`
            SELECT event_id FROM flows_journal_events WHERE run_id = 'fork-root' ORDER BY seq
          `
                const timeTravel = yield* TimeTravel
                const child = yield* timeTravel.fork({
                  runId: "fork-root",
                  frame: { lineageId: "fork-root/root", seq: 3 }
                }, { workspaceRoot })
                const cached = yield* cache.get("sealed-digest")
                return { cached: Option.getOrThrow(cached), child, parentRows }
              })
            )

            const childWorkspace = join(workspaceRoot, workspaceNameFor(first.child.runId))
            expect(existsSync(childWorkspace)).toBe(true)
            expect(first.cached.result).toEqual({ value: "cached" })

            const second = yield* runReal(
              fixture.databaseFile,
              Effect.gen(function*() {
                const timeTravel = yield* TimeTravel
                const grandchild = yield* timeTravel.fork({
                  runId: first.child.runId,
                  frame: { lineageId: "fork-root/root", seq: 4 }
                }, { workspaceRoot })
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const cache = yield* CacheStore.CacheStore
                const attempts = yield* sql<{ readonly run_id: string; readonly outcome_json: string | null }>`
            SELECT run_id, outcome_json FROM flows_attempts
            WHERE run_id IN ('fork-root', ${first.child.runId}, ${grandchild.runId})
            ORDER BY run_id
          `
                const edges = yield* sql<{
                  readonly parent_run_id: string
                  readonly parent_seq: number
                  readonly child_run_id: string
                }>`
            SELECT parent_run_id, parent_seq, child_run_id
            FROM flows_time_travel_edges ORDER BY child_run_id
          `
                const parentRows = yield* sql<{ readonly event_id: string }>`
            SELECT event_id FROM flows_journal_events WHERE run_id = 'fork-root' ORDER BY seq
          `
                return {
                  attempts,
                  cached: Option.getOrThrow(yield* cache.get("sealed-digest")),
                  edges,
                  grandchild,
                  parentRows
                }
              })
            )

            const grandchildWorkspace = join(workspaceRoot, workspaceNameFor(second.grandchild.runId))
            expect(existsSync(grandchildWorkspace)).toBe(true)
            expect(grandchildWorkspace).not.toBe(childWorkspace)
            expect(second.parentRows).toEqual(first.parentRows)
            expect(yield* Effect.promise(() => readFile(parentFile, "utf8"))).toBe("parent\n")
            expect(second.attempts).toHaveLength(3)
            expect(second.attempts.map((row) => JSON.parse(row.outcome_json ?? "null"))).toEqual([
              { value: "cached" },
              { value: "cached" },
              { value: "cached" }
            ])
            expect(second.cached).toEqual(first.cached)
            expect(second.edges).toEqual([
              { parent_run_id: "fork-root", parent_seq: 3, child_run_id: first.child.runId },
              { parent_run_id: first.child.runId, parent_seq: 4, child_run_id: second.grandchild.runId }
            ])
          }))
      }),
    { timeout: 60_000 }
  )
})
