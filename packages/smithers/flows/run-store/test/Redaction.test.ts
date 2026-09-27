/**
 * Executable state must survive the durable round trip verbatim: journal
 * payloads are redacted, but the stores that hold resumable state are not.
 * Split out of `@smthrs/journal`'s redaction suite when the stores moved into
 * their own packages; see `docs/pages/concepts/journal.md`.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"

describe("durable run state redaction", () => {
  // Executable state must round-trip verbatim: a field whose name merely ends
  // in `token`/`secret` is ordinary flow data, and a non-string value replaced
  // by a placeholder string breaks schema decode on resume (issue #72).
  const executable = {
    pageToken: "page-2",
    clientSecret: { rotationMs: 900, scopes: ["read"] },
    retries: 3
  }

  const storeLayers = Layer.mergeAll(
    RunStore.layer,
    AttemptStore.layer
  ).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

  const withStores = <A, E>(
    body: Effect.Effect<
      A,
      E,
      RunStore.RunStore | AttemptStore.AttemptStore | DurableWriter | SqlClient.SqlClient
    >
  ) => body.pipe(Effect.provide(storeLayers), Effect.provide(TestClock.layer()))

  it.effect("persists default Redacted schema JSON encoding verbatim", () =>
    Effect.gen(function*() {
      const secret = "synthetic-credential"
      const stateSchema = Schema.Struct({ apiKey: Schema.Redacted(Schema.String) })
      const encoded = Schema.encodeSync(Schema.toCodecJson(stateSchema))({ apiKey: Redacted.make(secret) })
      expect(encoded).toEqual({ apiKey: secret })
      const stateJson = JSON.stringify(encoded)
      const persisted = yield* withStores(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* store.create("redacted-json", stateJson)
        return (yield* store.get("redacted-json")).stateJson
      }))
      expect(persisted).toBe(stateJson)
    }))

  it("refuses Redacted schema JSON encoding when disallowJsonEncode is set", () => {
    const stateSchema = Schema.Struct({
      apiKey: Schema.Redacted(Schema.String, { disallowJsonEncode: true })
    })
    expect(() => Schema.encodeSync(Schema.toCodecJson(stateSchema))({ apiKey: Redacted.make("synthetic-credential") }))
      .toThrow()
  })

  it.effect("round-trips a run's durable state verbatim", () =>
    Effect.gen(function*() {
      const stateJson = yield* withStores(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* store.create("run-redaction", JSON.stringify({ payload: executable }))
        return (yield* store.get("run-redaction")).stateJson
      }))

      expect(JSON.parse(stateJson)).toEqual({ payload: executable })
    }))

  it.effect("round-trips durable state written by transitionOwned verbatim", () =>
    Effect.gen(function*() {
      const stateJson = yield* withStores(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, started_at_ms,
          owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-transition', 'running', 1, 1, 'host-a', 42, 'nonce-a', 1, '{}')
      `
        const store = yield* RunStore.RunStore
        const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }
        const outcome = yield* store.transitionOwned(
          "run-transition",
          owner,
          "running",
          JSON.stringify({ payload: executable })
        )
        expect(outcome._tag).toBe("Transitioned")
        return (yield* store.get("run-transition")).stateJson
      }))

      expect(JSON.parse(stateJson)).toEqual({ payload: executable })
    }))

  it.effect("round-trips attempt checkpoints, errors, outcomes, and meta verbatim", () =>
    Effect.gen(function*() {
      const attempt = yield* withStores(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-attempt', 'running', 1, 'host-a', 42, 'nonce-a', 1, '{}')
      `
        const store = yield* AttemptStore.AttemptStore
        const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }
        yield* store.put({
          runId: "run-attempt",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "running",
          startedAtMs: 10,
          checkpoint: executable,
          meta: executable
        }, owner)
        yield* store.finish({
          runId: "run-attempt",
          stepKeyDigest: "digest-1",
          attempt: 0,
          state: "failed",
          finishedAtMs: 20,
          error: executable,
          outcome: executable
        }, owner)
        return yield* store.get({ runId: "run-attempt", stepKeyDigest: "digest-1", attempt: 0 })
      }))

      expect(Option.getOrThrow(attempt)).toMatchObject({
        checkpoint: executable,
        error: executable,
        outcome: executable,
        meta: executable
      })
    }))

  it.effect("round-trips attempt fields written by patch verbatim", () =>
    Effect.gen(function*() {
      const attempt = yield* withStores(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-patch', 'running', 1, 'host-a', 42, 'nonce-a', 1, '{}')
      `
        const store = yield* AttemptStore.AttemptStore
        const id = { runId: "run-patch", stepKeyDigest: "digest-2", attempt: 0 }
        yield* store.put({ ...id, state: "running", startedAtMs: 10, meta: null }, {
          hostId: "host-a",
          pid: 42,
          nonce: "nonce-a"
        })
        yield* store.patch(id, { checkpoint: executable }, {
          hostId: "host-a",
          pid: 42,
          nonce: "nonce-a"
        })
        return yield* store.get(id)
      }))

      expect(Option.getOrThrow(attempt)).toMatchObject({ checkpoint: executable })
    }))

  describe("RunStore error-cause hygiene", () => {
    const secret = "sk-live-DO-NOT-LOG"
    const invalidStateJson = `{"apiKey":"${secret}","padding":"${"x".repeat(200_000)}"`

    const errorOf = <A>(exit: Exit.Exit<A, RunStore.RunStoreError>): RunStore.RunStoreError => {
      if (Exit.isSuccess(exit)) throw new Error("expected RunStore failure")
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      if (failure === undefined) throw new Error("expected typed RunStore failure")
      return failure.error
    }

    const expectHygienic = <A>(
      exit: Exit.Exit<A, RunStore.RunStoreError>,
      runId: string
    ): RunStore.RunStoreError => {
      const error = errorOf(exit)
      const serialized = JSON.stringify(error)
      const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
      for (const rendered of [serialized, pretty]) {
        expect(rendered).not.toContain(secret)
        expect(rendered).not.toContain("xxxxxxxxxx")
        expect(rendered).toContain(runId)
      }
      expect(serialized.length).toBeLessThan(2_000)
      return error
    }

    for (const [kind, input] of [["string", secret], ["object", { apiKey: secret }]] as const) {
      it.effect(`keeps rejected ${kind} timestamps out of published diagnostics`, () =>
        withStores(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const runId = "timestamp-hygiene"
          const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }
          const pending = { status: "pending", owner: null, heartbeatAtMs: null } as const
          const evidence = { expectedOwner: owner, checkedAtMs: 0, kind: "lease-expired" } as const
          const timestamp = input as unknown as number
          const operations: ReadonlyArray<readonly [string, string, Effect.Effect<unknown, RunStore.RunStoreError>]> = [
            ["requestCancel", "nowMs", store.requestCancel(runId, timestamp)],
            ["requestCancelLineage", "nowMs", store.requestCancelLineage(runId, timestamp)],
            ["claim", "nowMs", store.claim(runId, pending, owner, timestamp)],
            ["claimAndOwn", "nowMs", store.claimAndOwn(runId, pending, owner, timestamp)],
            ["heartbeat", "nowMs", store.heartbeat(runId, owner, timestamp)],
            ["activate", "claimedAtMs", store.activate(runId, owner, timestamp, pending)],
            ["abandonClaim", "claimedAtMs", store.abandonClaim(runId, owner, timestamp)],
            ["recoverClaim", "claimedAtMs", store.recoverClaim(runId, owner, timestamp, owner, 0, evidence)],
            ["recoverClaim", "nowMs", store.recoverClaim(runId, owner, 0, owner, timestamp, evidence)],
            ["steal", "nowMs", store.steal(runId, pending, owner, timestamp, evidence)],
            ["acknowledgeCancel", "nowMs", store.acknowledgeCancel(runId, owner, timestamp)]
          ]
          for (const [method, field, operation] of operations) {
            const exit = yield* Effect.exit(operation)
            const error = errorOf(exit)
            expect(error).toMatchObject({ code: "invalid_run", method })
            for (
              const rendered of [
                JSON.stringify(error),
                JSON.stringify(error.cause),
                error.message,
                Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""
              ]
            ) {
              expect(rendered).not.toContain(secret)
            }
            expect(error.cause).toEqual({ field, detail: "must be a non-negative safe integer" })
          }
        })))
    }

    it.effect("keeps create's published error cause free of executable state", () =>
      Effect.gen(function*() {
        const exit = yield* withStores(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          return yield* Effect.exit(store.create("run-cause-hygiene", invalidStateJson))
        }))

        const error = expectHygienic(exit, "run-cause-hygiene")
        expect(error.cause).toMatchObject({
          runId: "run-cause-hygiene",
          stateJsonLength: invalidStateJson.length,
          stateJsonValid: false
        })
      }))

    it.effect("keeps transitionOwned's published error cause free of executable state", () =>
      Effect.gen(function*() {
        const exit = yield* withStores(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }
          yield* store.create("run-transition-cause-hygiene", "{}")
          yield* store.claimAndOwn(
            "run-transition-cause-hygiene",
            { status: "pending", owner: null, heartbeatAtMs: null },
            owner,
            1
          )
          return yield* Effect.exit(
            store.transitionOwned("run-transition-cause-hygiene", owner, "completed", invalidStateJson)
          )
        }))

        const error = expectHygienic(exit, "run-transition-cause-hygiene")
        expect(error.cause).toMatchObject({
          runId: "run-transition-cause-hygiene",
          stateJsonLength: invalidStateJson.length,
          stateJsonValid: false
        })
      }))

    it.effect("keeps decodeRunRow's published error cause free of executable state", () =>
      Effect.gen(function*() {
        const stateJson = JSON.stringify({ apiKey: secret, padding: "x".repeat(200_000) })
        const exit = yield* withStores(Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* TestDatabase.checks(sql, false)
          yield* sql`
            INSERT INTO flows_runs (
              run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
            ) VALUES (
              'run-decode-cause-hygiene', 'suspended', 1, 'host-a', 42, 'nonce-a', 1, ${stateJson}
            )
          `
          yield* TestDatabase.checks(sql, true)
          const store = yield* RunStore.RunStore
          return yield* Effect.exit(store.get("run-decode-cause-hygiene"))
        }))

        const error = expectHygienic(exit, "run-decode-cause-hygiene")
        expect(error).toMatchObject({ code: "decode_failed", method: "get" })
        expect(error.cause).toMatchObject({
          hasClaimColumns: false,
          hasOwnerColumns: true,
          stateJsonValid: true
        })
      }))
  })
})
