import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { AttemptStore } from "../src/AttemptStore.ts"
import * as AttemptStoreLive from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => effect

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | AttemptStore>
) =>
  run(
    effect.pipe(
      Effect.provide(AttemptStoreLive.layer),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer)
    )
  )

const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

const failingDatabase = (cause: unknown): Layer.Layer<DurableWriter.DurableWriter | SqlClient.SqlClient> => {
  const sql = new Proxy(
    () => Effect.fail(cause),
    {
      apply: () => Effect.fail(cause),
      // `in` builds a predicate fragment during construction, before any query runs.
      get: (target, property) => property === "in" ? () => "" : Reflect.get(target, property)
    }
  ) as unknown as SqlClient.SqlClient
  const write: DurableWriter.Service["write"] = () => Effect.die("unexpected write in read-only failure fixture")
  return Layer.merge(
    Layer.succeed(SqlClient.SqlClient)(sql),
    Layer.succeed(DurableWriter.DurableWriter)(DurableWriter.DurableWriter.of({ write }))
  )
}

const createRun = (runId = "run-1") =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (
        run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
      ) VALUES (${runId}, 'running', 1, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, '{}')
    `
  })

describe("AttemptStore", () => {
  it.effect("round-trips an attempt and its opaque metadata", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        const meta = { discardCheckpoint: true, nested: { value: "opaque" } }
        expect(
          yield* store.put({
            runId: "run-1",
            stepKeyDigest: "digest-1",
            attempt: 0,
            state: "running",
            startedAtMs: 10,
            heartbeatAtMs: 11,
            checkpoint: { cursor: 2 },
            meta
          }, owner)
        ).toEqual({ _tag: "Inserted" })
        return yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
      }))

      expect(Option.getOrThrow(result)).toEqual({
        runId: "run-1",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        heartbeatAtMs: 11,
        checkpoint: { cursor: 2 },
        meta: { discardCheckpoint: true, nested: { value: "opaque" } }
      })
    }))

  it.effect("preserves opaque metadata across terminal state rewrites when no replacement is supplied", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: { discardCheckpoint: true }
        }, owner)
        expect(
          yield* store.finish({
            runId: "run-1",
            stepKeyDigest: "digest-1",
            attempt: 0,
            state: "cancelled",
            finishedAtMs: 20,
            error: { reason: "lost" },
            outcome: { kind: "cancelled" }
          }, owner)
        ).toEqual({ _tag: "Finished" })
        return yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
      }))

      expect(Option.getOrThrow(result)).toMatchObject({
        state: "cancelled",
        meta: { discardCheckpoint: true },
        error: { reason: "lost" },
        outcome: { kind: "cancelled" }
      })
    }))

  it.effect("preserves an outcome recorded by patch when the terminal transition omits one", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: {}
        }, owner)
        expect(
          yield* store.patch({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 }, {
            outcome: { responseText: "partial", worktreeRef: "ref-1" }
          }, owner)
        ).toEqual({ _tag: "Patched" })
        expect(
          yield* store.finish({
            runId: "run-1",
            stepKeyDigest: "digest-1",
            attempt: 0,
            state: "failed",
            finishedAtMs: 20
          }, owner)
        ).toEqual({ _tag: "Finished" })
        return yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
      }))

      expect(Option.getOrThrow(result)).toMatchObject({
        state: "failed",
        finishedAtMs: 20,
        outcome: { responseText: "partial", worktreeRef: "ref-1" }
      })
    }))

  it.effect("replaces a recorded outcome when the terminal transition supplies one", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          outcome: { value: "mid-flight" },
          meta: {}
        }, owner)
        yield* store.finish({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "completed",
          finishedAtMs: 20,
          outcome: { value: "terminal" }
        }, owner)
        return yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
      }))

      expect(Option.getOrThrow(result)).toMatchObject({
        state: "completed",
        outcome: { value: "terminal" }
      })
    }))

  it.effect("atomically records failure metadata discovered at the terminal transition", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: { agentChainIndex: 1 }
        }, owner)
        expect(
          yield* store.finish({
            runId: "run-1",
            stepKeyDigest: "digest-1",
            attempt: 0,
            state: "failed",
            finishedAtMs: 20,
            meta: {
              agentChainIndex: 1,
              discardResumeSession: true
            }
          }, owner)
        ).toEqual({ _tag: "Finished" })
        return Option.getOrThrow(
          yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
        )
      }))

      expect(result.meta).toEqual({
        agentChainIndex: 1,
        discardResumeSession: true
      })
    }))

  it.effect("reports FenceLost when the run owner tuple changed", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: {}
        }, owner)
        yield* sql`
        UPDATE flows_runs SET owner_host_id = 'host-b', owner_pid = 43, owner_nonce = 'nonce-b'
        WHERE run_id = 'run-1'
      `
        return yield* store.heartbeat("run-1", "digest-1", 0, owner, 30)
      }))

      expect(result).toEqual({ _tag: "FenceLost" })
    }))

  it.effect("updates a running heartbeat and checkpoint while liveness-only pulses preserve the checkpoint", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: {}
        }, owner)
        const updated = yield* store.heartbeat(
          "run-1",
          "digest-1",
          0,
          owner,
          12,
          { agentEngine: "codex", agentResume: "session-1" }
        )
        const livenessOnly = yield* store.heartbeat("run-1", "digest-1", 0, owner, 13)
        const missing = yield* store.heartbeat("run-1", "missing", 0, owner, 12)
        const missingGet = yield* store.get({
          runId: "run-1",
          stepKeyDigest: "missing",
          attempt: 0
        })
        return {
          updated,
          livenessOnly,
          missing,
          missingGet,
          stored: Option.getOrThrow(
            yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
          )
        }
      }))

      expect(result.updated).toEqual({ _tag: "Updated" })
      expect(result.livenessOnly).toEqual({ _tag: "Updated" })
      expect(result.missing).toEqual({ _tag: "NotFound" })
      expect(Option.isNone(result.missingGet)).toBe(true)
      expect(result.stored.heartbeatAtMs).toBe(13)
      expect(result.stored.checkpoint).toEqual({
        agentEngine: "codex",
        agentResume: "session-1"
      })
    }))

  it.effect("keeps multiple attempts for one step", () =>
    Effect.gen(function*() {
      const attempts = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: {}
        }, owner)
        yield* store.finish({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "failed",
          finishedAtMs: 15
        }, owner)
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 1,
          state: "running",
          startedAtMs: 20,
          meta: {}
        }, owner)
        return yield* Effect.all([
          store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 }),
          store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 1 })
        ])
      }))

      expect(attempts.map(Option.getOrThrow).map((attempt) => attempt.state)).toEqual(["failed", "running"])
    }))

  it.effect("fences attempt creation and detects divergent retries", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        const attempt = {
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: { value: 1 }
        }
        const inserted = yield* store.put(attempt, owner)
        const same = yield* store.put(attempt, owner)
        const conflict = yield* store.put({ ...attempt, meta: { value: 2 } }, owner)
        const stale = yield* store.put(
          { ...attempt, stepKeyDigest: "digest-2" },
          { hostId: "host-b", pid: 7, nonce: "stale" }
        )
        return { inserted, same, conflict, stale }
      }))

      expect(result).toEqual({
        inserted: { _tag: "Inserted" },
        same: { _tag: "ExistingSame" },
        conflict: { _tag: "Conflict" },
        stale: { _tag: "FenceLost" }
      })
    }))

  it.effect("reports RunNotFound when creating an attempt for a missing run", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* AttemptStore
        return yield* store.put({
          runId: "missing",
          stepKeyDigest: "digest",
          attempt: 0,
          state: "running",
          startedAtMs: 0,
          meta: {}
        }, owner)
      }))

      expect(result).toEqual({ _tag: "RunNotFound" })
    }))

  it.effect("recognizes identical attempts with every optional field", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        const attempt = {
          runId: "run-1",
          stepKeyDigest: "digest",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          finishedAtMs: 11,
          heartbeatAtMs: 12,
          checkpoint: { cursor: 1 },
          error: { message: "recorded" },
          outcome: { value: 1 },
          meta: { opaque: true }
        }
        yield* store.put(attempt, owner)
        return yield* store.put(attempt, owner)
      }))

      expect(result).toEqual({ _tag: "ExistingSame" })
    }))

  it.effect("compares re-put JSON by content instead of object key order", () =>
    Effect.gen(function*() {
      const results = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        const attempt = (
          index: number,
          fields: Partial<AttemptStoreLive.Attempt>
        ): AttemptStoreLive.Attempt => ({
          runId: "run-1",
          stepKeyDigest: `digest-${index}`,
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: {},
          ...fields
        })
        const cases = [
          [
            attempt(0, { meta: { a: 1, b: 2 } }),
            attempt(0, { meta: { b: 2, a: 1 } })
          ],
          [
            attempt(1, {
              checkpoint: { nested: { a: 1, b: 2 }, entries: [{ c: 3, d: 4 }] }
            }),
            attempt(1, {
              checkpoint: { entries: [{ d: 4, c: 3 }], nested: { b: 2, a: 1 } }
            })
          ],
          [
            attempt(2, { meta: { value: 1 } }),
            attempt(2, { meta: { value: 2 } })
          ],
          [
            attempt(3, { meta: { value: 1 } }),
            attempt(3, { meta: { value: 1, extra: true } })
          ],
          [
            attempt(4, { checkpoint: [1, 2] }),
            attempt(4, { checkpoint: [2, 1] })
          ]
        ] as const

        return yield* Effect.forEach(cases, ([first, second]) =>
          Effect.gen(function*() {
            yield* store.put(first, owner)
            return yield* store.put(second, owner)
          }))
      }))

      expect(results).toEqual([
        { _tag: "ExistingSame" },
        { _tag: "ExistingSame" },
        { _tag: "Conflict" },
        { _tag: "Conflict" },
        { _tag: "Conflict" }
      ])
    }))

  it.effect("does not heartbeat terminal attempts", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          heartbeatAtMs: 11,
          meta: {}
        }, owner)
        yield* store.finish({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "completed",
          finishedAtMs: 20,
          outcome: { ok: true }
        }, owner)
        const heartbeat = yield* store.heartbeat("run-1", "digest-1", 0, owner, 30)
        const stored = Option.getOrThrow(
          yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
        )
        return { heartbeat, stored }
      }))

      expect(result.heartbeat).toEqual({ _tag: "StateChanged" })
      expect(result.stored.heartbeatAtMs).toBe(11)
    }))

  it.effect("reports missing, stale, and repeated terminal transitions", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        const terminal = {
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "completed",
          finishedAtMs: 20,
          outcome: { value: "first" }
        }
        const missing = yield* store.finish(terminal, owner)
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          meta: {}
        }, owner)
        const stale = yield* store.finish(terminal, { hostId: "host-b", pid: 7, nonce: "stale" })
        const finished = yield* store.finish(terminal, owner)
        const repeated = yield* store.finish(
          { ...terminal, outcome: { value: "second" } },
          owner
        )
        const stored = Option.getOrThrow(
          yield* store.get({ runId: "run-1", stepKeyDigest: "digest-1", attempt: 0 })
        )
        return { missing, stale, finished, repeated, stored }
      }))

      expect(result.missing).toEqual({ _tag: "NotFound" })
      expect(result.stale).toEqual({ _tag: "FenceLost" })
      expect(result.finished).toEqual({ _tag: "Finished" })
      expect(result.repeated).toEqual({ _tag: "StateChanged" })
      expect(result.stored.outcome).toEqual({ value: "first" })
    }))

  it.effect("attributes invalid identities to the refusing operation", () =>
    Effect.gen(function*() {
      const failures = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        const id = { runId: "run-1", stepKeyDigest: "digest", attempt: -1 }
        return yield* Effect.all([
          Effect.flip(store.get(id)),
          Effect.flip(store.put({ ...id, state: "running", startedAtMs: 0, meta: {} }, owner)),
          Effect.flip(store.heartbeat(id.runId, id.stepKeyDigest, id.attempt, owner, 1)),
          Effect.flip(store.finish({ ...id, state: "completed", finishedAtMs: 1 }, owner)),
          Effect.flip(store.patch(id, {}, owner))
        ])
      }))
      const expected = [
        ["get", "attempt identity violates the durable identifier contract"],
        ["put", "attempt violates the persistence contract"],
        ["heartbeat", "attempt identity violates the durable identifier contract"],
        ["finish", "finished attempt violates the contract"],
        ["patch", "attempt identity violates the durable identifier contract"]
      ] as const

      for (const [index, [method, detail]] of expected.entries()) {
        expect(failures[index]).toMatchObject({
          code: "invalid_attempt",
          method,
          message: `invalid_attempt: AttemptStore.${method}: ${detail}`
        })
      }
    }))

  it.effect("rejects invalid ids, timestamps, states, and JSON values with stable codes", () =>
    Effect.gen(function*() {
      const failures = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const store = yield* AttemptStore
        const base = {
          runId: "run-1",
          stepKeyDigest: "digest",
          attempt: 0,
          state: "running",
          startedAtMs: 0,
          meta: {}
        }
        const invalidPuts = [
          { ...base, runId: "" },
          { ...base, stepKeyDigest: "" },
          { ...base, attempt: Number.NaN },
          { ...base, attempt: -1 },
          { ...base, state: "" },
          { ...base, startedAtMs: Number.NaN },
          { ...base, startedAtMs: -1 },
          { ...base, finishedAtMs: Number.NaN },
          { ...base, finishedAtMs: -1 },
          { ...base, heartbeatAtMs: Number.NaN },
          { ...base, heartbeatAtMs: -1 },
          { ...base, checkpoint: undefined, meta: undefined },
          { ...base, checkpoint: BigInt(1) },
          { ...base, error: BigInt(1) },
          { ...base, outcome: BigInt(1) },
          { ...base, meta: BigInt(1) }
        ]
        const putFailures = yield* Effect.forEach(
          invalidPuts,
          (attempt) => Effect.flip(store.put(attempt as never, owner))
        )
        const heartbeatFailures = yield* Effect.forEach(
          [
            store.heartbeat("run-1", "digest", 0, owner, Number.NaN),
            store.heartbeat("run-1", "digest", 0, owner, -1),
            store.heartbeat("run-1", "digest", 0, owner, 1, BigInt(1) as never),
            store.heartbeat("run-1", "digest", 0, owner, 1, "x".repeat(1024 * 1024))
          ],
          Effect.flip
        )
        const invalidFinishes = [
          { ...base, state: "", finishedAtMs: 1 },
          { ...base, state: "running", finishedAtMs: 1 },
          { ...base, state: "completed", finishedAtMs: Number.NaN },
          { ...base, state: "completed", finishedAtMs: -1 },
          { ...base, state: "completed", finishedAtMs: 1, error: BigInt(1) },
          { ...base, state: "completed", finishedAtMs: 1, outcome: BigInt(1) },
          { ...base, state: "completed", finishedAtMs: 1, meta: BigInt(1) }
        ]
        const finishFailures = yield* Effect.forEach(
          invalidFinishes,
          (attempt) => Effect.flip(store.finish(attempt as never, owner))
        )
        return [...putFailures, ...heartbeatFailures, ...finishFailures]
      }))

      expect(failures.every((failure) => failure.code === "invalid_attempt")).toBe(true)
      expect(failures.every((failure) => failure.cause === undefined)).toBe(true)
    }))

  it.effect("reports decode_failed for corrupt durable attempt JSON", () =>
    Effect.gen(function*() {
      const codes = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest",
          attempt: 0,
          state: "running",
          startedAtMs: 0,
          meta: {}
        }, owner)
        yield* TestDatabase.checks(sql, false)
        const codes: Array<string> = []
        for (const column of ["checkpoint_json", "error_json", "outcome_json", "meta_json"] as const) {
          yield* sql.unsafe(
            `UPDATE flows_attempts SET ${column} = 'not-json' WHERE run_id = 'run-1'`
          )
          const failure = yield* Effect.flip(
            store.get({ runId: "run-1", stepKeyDigest: "digest", attempt: 0 })
          )
          codes.push(failure.code)
          yield* sql.unsafe(
            `UPDATE flows_attempts SET ${column} = ${column === "meta_json" ? "'{}'" : "NULL"} WHERE run_id = 'run-1'`
          )
        }
        return codes
      }))

      expect(codes).toEqual(["decode_failed", "decode_failed", "decode_failed", "decode_failed"])
    }))

  it.effect("decodes complete durable attempt rows before exposing numeric or state fields", () =>
    Effect.gen(function*() {
      const codes = yield* migrated(Effect.gen(function*() {
        yield* createRun()
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* AttemptStore
        yield* store.put({
          runId: "run-1",
          stepKeyDigest: "digest",
          attempt: 0,
          state: "running",
          startedAtMs: 0,
          heartbeatAtMs: 1,
          meta: {}
        }, owner)
        yield* TestDatabase.checks(sql, false)
        const corruptions = [
          ["state", "''", "'running'"],
          ["started_at_ms", "-1", "0"],
          ["finished_at_ms", "-1", "NULL"],
          ["heartbeat_at_ms", "-1", "1"]
        ] as const
        return yield* Effect.forEach(corruptions, ([column, value, restore]) =>
          Effect.gen(function*() {
            yield* sql.unsafe(
              `UPDATE flows_attempts SET ${column} = ${value} WHERE run_id = 'run-1'`
            )
            const failure = yield* Effect.flip(
              store.get({ runId: "run-1", stepKeyDigest: "digest", attempt: 0 })
            )
            yield* sql.unsafe(
              `UPDATE flows_attempts SET ${column} = ${restore} WHERE run_id = 'run-1'`
            )
            return failure.code
          }))
      }))

      expect(codes).toEqual(["decode_failed", "decode_failed", "decode_failed", "decode_failed"])
    }))

  it.effect("normalizes persistence failures into stable error codes", () =>
    Effect.gen(function*() {
      const existing = new AttemptStoreLive.AttemptStoreError({
        code: "unknown",
        method: "get",
        message: "unknown: AttemptStore.get: existing",
        cause: { category: "unknown" }
      })
      const causes: ReadonlyArray<unknown> = [
        existing,
        new SqlError.SqlError({
          reason: new SqlError.ConstraintError({ cause: new Error("constraint") })
        }),
        new SqlError.SqlError({
          reason: new SqlError.UniqueViolation({ cause: new Error("unique"), constraint: "attempt" })
        }),
        new DurableWriter.DatabaseError({ code: "constraint" }),
        { code: "other" },
        {},
        null,
        "failure"
      ]
      const failures = yield* (
        Effect.forEach(
          causes,
          (cause) =>
            Effect.gen(function*() {
              const store = yield* AttemptStore
              return yield* Effect.flip(
                store.get({ runId: "run", stepKeyDigest: "digest", attempt: 0 })
              )
            }).pipe(
              Effect.provide(AttemptStoreLive.layer),
              Effect.provide(failingDatabase(cause))
            )
        )
      )

      expect(failures.map((failure) => failure.code)).toEqual([
        "unknown",
        "constraint",
        "constraint",
        "constraint",
        "persistence_failed",
        "persistence_failed",
        "persistence_failed",
        "persistence_failed"
      ])
      expect(failures.every((failure) => failure.method === "get")).toBe(true)
      expect(failures.map((failure) => failure.message)).toEqual([
        "unknown: AttemptStore.get: existing",
        "constraint: AttemptStore.get: attempt persistence failed",
        "constraint: AttemptStore.get: attempt persistence failed",
        "constraint: AttemptStore.get: attempt persistence failed",
        "persistence_failed: AttemptStore.get: attempt persistence failed",
        "persistence_failed: AttemptStore.get: attempt persistence failed",
        "persistence_failed: AttemptStore.get: attempt persistence failed",
        "persistence_failed: AttemptStore.get: attempt persistence failed"
      ])
      expect(failures.map((failure) => failure.cause)).toEqual([
        { category: "unknown" },
        {
          category: "constraint",
          reason: "ConstraintError",
          cause: new DurableWriter.DatabaseError({ code: "constraint" })
        },
        {
          category: "constraint",
          reason: "UniqueViolation",
          cause: new DurableWriter.DatabaseError({ code: "constraint" })
        },
        {
          category: "constraint",
          reason: "constraint",
          cause: new DurableWriter.DatabaseError({ code: "constraint" })
        },
        { category: "persistence_failed", reason: "unknown" },
        { category: "persistence_failed", reason: "unknown" },
        { category: "persistence_failed", reason: "unknown" },
        { category: "persistence_failed", reason: "unknown" }
      ])
    }))
})

describe("AttemptStore structural id admission", () => {
  // [flows-run-store/api-design/1] Attempt extends AttemptId, so a stored
  // attempt must be accepted wherever an id is typed.
  it.effect("accepts an Attempt from put or get as the id of get and patch", () =>
    migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      const attempt = {
        runId: "run-1",
        stepKeyDigest: "digest-structural",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        heartbeatAtMs: 11,
        checkpoint: { cursor: 1 },
        meta: {}
      }
      expect(yield* store.put(attempt, owner)).toEqual({ _tag: "Inserted" })
      const stored = Option.getOrThrow(yield* store.get(attempt))
      expect(stored.stepKeyDigest).toBe("digest-structural")
      expect(yield* store.patch(stored, { checkpoint: { cursor: 2 } }, owner)).toEqual({ _tag: "Patched" })
      expect(Option.getOrThrow(yield* store.get(stored)).checkpoint).toEqual({ cursor: 2 })
    })))

  it.effect("still rejects accessors, prototype-carried fields, and missing id fields", () =>
    migrated(Effect.gen(function*() {
      yield* createRun()
      const store = yield* AttemptStore
      let calls = 0
      const id = { runId: "run-1", stepKeyDigest: "digest-structural", attempt: 0 }
      const accessor = Object.defineProperty({ ...id }, "attempt", {
        enumerable: true,
        get: () => {
          calls++
          return 0
        }
      })
      const extraAccessor = Object.defineProperty({ ...id, state: "running" }, "meta", {
        enumerable: true,
        get: () => {
          calls++
          return {}
        }
      })
      const inherited = Object.create(id) as typeof id
      const { attempt: _attempt, ...missing } = id
      const candidates = [accessor, extraAccessor, inherited, missing, new Date()]
      for (const [index, candidate] of candidates.entries()) {
        const failure = yield* Effect.flip(store.get(candidate as never))
        expect(failure.code, `candidate ${index}`).toBe("invalid_attempt")
      }
      expect(calls).toBe(0)
    })))
})
