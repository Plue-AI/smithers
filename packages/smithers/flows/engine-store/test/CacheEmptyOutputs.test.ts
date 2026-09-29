import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Crypto, Effect, Layer, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, jj, owner } from "./CachePolicyFixtures.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const descriptor = { readSet: [], writeSet: [], boundaryMode: "hard" } as const
const key = "empty-output-policy"
const keyDigest = createHash("sha256").update(key).digest("hex")
const id = { runId: "empty-run", stepKeyDigest: keyDigest, attempt: 1 }
const EmptyFlow = Flow.make("EmptyOutputPolicy", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const stateJson = JSON.stringify({ version: 1, flowName: "EmptyOutputPolicy", payload: {} })
const dispatch = (
  runId: string,
  execute: ActionPersistence.Dependencies["execute"],
  metadata: ActionPersistence.BoundaryMetadata = descriptor
) =>
  ActionPersistence.make({ runId, owner, sourceId: "empty-output-policy", execute })({
    action: {},
    key,
    attempt: 1,
    tier: "sealed",
    metadata
  })

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layerAt>>
  | Jj.Jj
  | StepBoundary.Service
  | Crypto.Crypto
  | Scope.Scope
  | TestClock.TestClock
const onDatabase = <A, E>(file: string, boundary: StepBoundary.Service, body: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(withCrypto(body.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(
      TestStores.layerAt(file),
      jj,
      TestClock.layer(),
      Layer.succeed(StepBoundary.StepBoundary, boundary)
    ))
  )))

const withDatabase = async (body: (file: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-empty-outputs-"))
  try {
    await body(join(root, "engine.sqlite"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("empty output evidence is eligible and still checked for corruption", () => {
  for (const declaredOutputs of [{ outputs: [] }, { paths: [] }]) {
    const format = Object.hasOwn(declaredOutputs, "outputs") ? "filesystem" : "abstract"
    const evidence = {
      declaredOutputs,
      diffIdentity: "empty-diff",
      wholeTreeWritesVerified: true,
      hermeticReadsVerified: true
    } satisfies StepBoundary.BoundaryEvidence
    const meta = { tier: "sealed", boundary: evidence, readSetVerified: true }
    const boundary = StepBoundary.make({
      prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: [] }),
      settle: () => Effect.succeed(evidence),
      replayOutputs: () => Effect.void
    })

    it(`${format}: publishes a fresh completion and serves a different run after reopening`, () =>
      withDatabase(async (file) => {
        let bodies = 0
        let replays = 0
        await onDatabase(
          file,
          boundary,
          Effect.gen(function*() {
            yield* activate("empty-run")
            yield* TestClock.adjust("1234 millis")
            expect(
              yield* dispatch("empty-run", () =>
                Effect.sync(() => {
                  bodies++
                  return "durable-empty-result"
                }))
            ).toBe("durable-empty-result")
            const cache = yield* CacheStore.CacheStore
            expect(Option.getOrThrow(yield* cache.get(keyDigest))).toMatchObject({
              result: "durable-empty-result",
              createdAtMs: 1234,
              meta
            })
          })
        )
        await onDatabase(
          file,
          {
            ...boundary,
            replayOutputs: (recorded) =>
              Effect.sync(() => {
                replays++
                expect(recorded).toEqual(evidence)
              })
          },
          Effect.gen(function*() {
            yield* activate("empty-consumer")
            expect(yield* dispatch("empty-consumer", () => Effect.die("cached body repeated")))
              .toBe("durable-empty-result")
          })
        )
        expect(bodies).toBe(1)
        expect(replays).toBe(1)
      }))

    it(`${format}: converges a reopened completion without a finish timestamp at the current clock`, () =>
      withDatabase(async (file) => {
        await onDatabase(
          file,
          boundary,
          Effect.gen(function*() {
            yield* activate("empty-run")
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO flows_attempts
            (run_id, step_key_digest, attempt, state, started_at_ms, outcome_json, meta_json)
            VALUES ('empty-run', ${keyDigest}, 1, 'succeeded', 0, '"durable-empty-result"', ${JSON.stringify(meta)})`
          })
        )
        await onDatabase(
          file,
          boundary,
          Effect.gen(function*() {
            const attempts = yield* AttemptStore.AttemptStore
            const before = yield* attempts.get(id)
            expect(Option.getOrThrow(before).finishedAtMs).toBeUndefined()
            yield* TestClock.adjust("4321 millis")
            expect(yield* dispatch("empty-run", () => Effect.die("durable body repeated")))
              .toBe("durable-empty-result")
            expect(yield* attempts.get(id)).toEqual(before)
          })
        )
        await onDatabase(
          file,
          boundary,
          Effect.gen(function*() {
            const cache = yield* CacheStore.CacheStore
            expect(Option.getOrThrow(yield* cache.get(keyDigest))).toMatchObject({
              result: "durable-empty-result",
              createdAtMs: 4321,
              recordedRunId: "empty-run",
              meta
            })
          })
        )
      }))

    it(`${format}: parks corrupt evidence once and resumes its outcome through fresh SQLite connections`, () =>
      withDatabase(async (file) => {
        let replays = 0
        const corruption = new StepBoundary.BoundaryCorruption({
          code: "boundary_corruption",
          path: "boundary-metadata",
          recordedDigest: "before",
          measuredDigest: "after"
        })
        const corruptBoundary = {
          ...boundary,
          replayOutputs: (recorded: StepBoundary.BoundaryEvidence) =>
            Effect.suspend(() => {
              replays++
              expect(recorded.diffIdentity).toBe("corrupt-empty-diff")
              return Effect.fail(corruption)
            })
        }
        await onDatabase(
          file,
          boundary,
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const attempts = yield* AttemptStore.AttemptStore
            yield* runs.create("empty-run", stateJson, { lineageId: "empty-run", roundOrdinal: 0 })
            const row = yield* runs.get("empty-run")
            yield* runs.claimAndOwn(
              "empty-run",
              {
                status: row.status,
                owner: row.owner,
                heartbeatAtMs: row.heartbeatAtMs
              },
              owner,
              0
            )
            yield* attempts.put({ ...id, state: "running", startedAtMs: 0, meta: { tier: "sealed" } }, owner)
            yield* attempts.finish({
              ...id,
              state: "succeeded",
              finishedAtMs: 1,
              outcome: "durable-empty-result",
              meta
            }, owner)
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE flows_attempts
              SET meta_json = json_set(meta_json, '$.boundary.diffIdentity', 'corrupt-empty-diff')
              WHERE run_id = 'empty-run' AND step_key_digest = ${keyDigest} AND attempt = 1`
            yield* runs.transitionOwned("empty-run", owner, "suspended", stateJson)
          })
        )
        const drive = (recover = false) =>
          Effect.gen(function*() {
            const services = yield* Effect.context<Services>()
            const driver = yield* RunDriver.make({
              owner,
              journalSource: "empty-output-policy",
              isAlive: () => Effect.succeed(false),
              engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
            })
            yield* driver.register(
              EmptyFlow,
              () => dispatch("empty-run", () => Effect.die("durable body repeated")).pipe(Effect.provide(services))
            )
            if (recover) yield* driver.resume(EmptyFlow, "empty-run")
            else yield* driver.execute(EmptyFlow, { executionId: "empty-run", payload: {}, discard: true })
          })
        await onDatabase(file, corruptBoundary, drive())
        // Reopening and submitting again cannot authorize quarantine recovery.
        await onDatabase(file, corruptBoundary, drive())
        // Read the parked state from a connection that did not drive it.
        await onDatabase(
          file,
          corruptBoundary,
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const state = yield* DurableEngineState.DurableEngineState
            const attempts = yield* AttemptStore.AttemptStore
            const cache = yield* CacheStore.CacheStore
            const journal = yield* Journal.Journal
            expect((yield* runs.get("empty-run")).status).toBe("suspended")
            expect(Option.getOrThrow(yield* state.waiting("empty-run"))).toMatchObject({
              reason: "quarantine",
              token: keyDigest
            })
            expect(Option.getOrThrow(yield* attempts.get(id))).toMatchObject({
              state: "succeeded",
              outcome: "durable-empty-result",
              meta: { tier: "sealed", boundaryQuarantined: true }
            })
            expect(Option.getOrThrow(yield* attempts.get(id)).meta).toEqual({
              tier: "sealed",
              boundaryQuarantined: true
            })
            expect(Option.isNone(yield* cache.get(keyDigest))).toBe(true)
            const page = yield* journal.entries({ runId: "empty-run" as never, limit: 100 })
            expect(page.entries.some((entry) => {
              const payload = entry.payload as { path?: string; recordedDigest?: string; measuredDigest?: string }
              return payload.path === "boundary-metadata" && payload.recordedDigest === "before" &&
                payload.measuredDigest === "after"
            })).toBe(true)
          })
        )
        expect(replays).toBe(1)
        await onDatabase(file, corruptBoundary, drive(true))
        await onDatabase(
          file,
          corruptBoundary,
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const state = yield* DurableEngineState.DurableEngineState
            const cache = yield* CacheStore.CacheStore
            const attempts = yield* AttemptStore.AttemptStore
            expect((yield* runs.get("empty-run")).status).toBe("completed")
            expect(Option.isNone(yield* state.waiting("empty-run"))).toBe(true)
            expect(Option.getOrThrow(yield* attempts.get(id)).outcome).toBe("durable-empty-result")
            expect(Option.isNone(yield* cache.get(keyDigest))).toBe(true)
          })
        )
        expect(replays).toBe(1)
      }))
  }

  for (
    const [label, declaredOutputs, writeSet, reason] of [
      ["opaque object", {}, [], "unsupported-output-evidence"],
      ["omitted declared output", { outputs: [] }, ["required.txt"], "output-boundary-mismatch"]
    ] as const
  ) {
    it(`${label}: refuses convergence without replay or corruption quarantine`, () =>
      withDatabase(async (file) => {
        const meta = {
          tier: "sealed",
          readSetVerified: true,
          boundary: {
            declaredOutputs,
            diffIdentity: "empty-diff",
            wholeTreeWritesVerified: true,
            hermeticReadsVerified: true
          }
        }
        const boundary = StepBoundary.make({
          prepare: () => Effect.die("must not measure"),
          settle: () => Effect.die("must not settle"),
          replayOutputs: () => Effect.die("must not replay")
        })
        await onDatabase(
          file,
          boundary,
          Effect.gen(function*() {
            yield* activate("empty-run")
            const sql = yield* SqlClient.SqlClient
            yield* sql`INSERT INTO flows_attempts
            (run_id, step_key_digest, attempt, state, started_at_ms, outcome_json, meta_json)
            VALUES ('empty-run', ${keyDigest}, 1, 'succeeded', 0, '"durable-empty-result"', ${JSON.stringify(meta)})`
          })
        )
        await onDatabase(
          file,
          boundary,
          Effect.gen(function*() {
            const attempts = yield* AttemptStore.AttemptStore
            const cache = yield* CacheStore.CacheStore
            const journal = yield* Journal.Journal
            expect(yield* dispatch("empty-run", () => Effect.die("durable body repeated"), { ...descriptor, writeSet }))
              .toBe("durable-empty-result")
            expect(Option.getOrThrow(yield* attempts.get(id)).meta).toEqual(meta)
            expect(Option.isNone(yield* cache.get(keyDigest))).toBe(true)
            const page = yield* journal.entries({ runId: "empty-run" as never, limit: 100 })
            expect(
              page.entries.filter((entry) => (entry.payload as { action?: string }).action === "replay_failed")
                .map((entry) => entry.payload)
            ).toEqual([{ keyDigest, action: "replay_failed", reason }])
          })
        )
      }))
  }
})
