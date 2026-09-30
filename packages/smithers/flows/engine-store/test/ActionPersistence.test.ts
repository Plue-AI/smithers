import { describe, expect, it } from "@effect/vitest"
import { Action } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Errors from "../src/Errors.ts"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "action-host", pid: 11, nonce: "action-process" }

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "action-snapshot" as never, changeId: "action-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") {
      return yield* Effect.die(new Error(`run ${runId} claim was lost`))
    }
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") {
      return yield* Effect.die(new Error(`run ${runId} activation was lost`))
    }
  })

const layer = Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)

/**
 * These cases assert the *cache row* outcome of a lost put race, not the
 * run-level verdict, so they opt into the tolerant inconsistency receiver.
 * The shipped core default is `Inconsistency.layerStrict` — covered by
 * `test/Inconsistency.test.ts`.
 */
const tolerantLayer = Layer.provideMerge(Inconsistency.layerTolerant(owner), layer)

describe("ActionPersistence", () => {
  it.effect("finds the earliest persisted boundary across missing attempt rows", () =>
    Effect.gen(function*() {
      yield* activate("sparse-boundaries")
      const attempts = yield* AttemptStore.AttemptStore
      const digest = sha256("sparse-boundary-key")
      expect(
        yield* ActionPersistence.earliestBoundarySnapshot(attempts, "sparse-boundaries", digest, {
          earliest: 1,
          latest: 2
        })
      ).toEqual(Option.none())
      for (const attempt of [2, 4]) {
        yield* attempts.put({
          runId: "sparse-boundaries",
          stepKeyDigest: digest,
          attempt,
          state: "running",
          startedAtMs: attempt,
          meta: { tier: "sealed", boundarySnapshot: { handle: `snapshot-${attempt}` } }
        }, owner)
      }
      expect(
        yield* ActionPersistence.earliestBoundarySnapshot(attempts, "sparse-boundaries", digest, {
          earliest: 1,
          latest: 4
        })
      ).toEqual(Option.some("snapshot-2"))
      expect(
        yield* ActionPersistence.earliestBoundarySnapshot(attempts, "sparse-boundaries", digest, {
          earliest: 3,
          latest: 4
        })
      ).toEqual(Option.some("snapshot-4"))
    }).pipe(Effect.provide(layer), withCrypto))

  it.effect("bounds default cache history reads per dispatch as the run grows", () =>
    withCrypto(
      Effect.gen(function*() {
        yield* activate("incremental-cache-history")
        const journal = yield* Journal.Journal
        let pages = 0
        let rows = 0
        const counting: Journal.Service = {
          ...journal,
          entries: (options) =>
            journal.entries(options).pipe(Effect.tap((page) =>
              Effect.sync(() => {
                pages++
                rows += page.entries.length
              })
            ))
        }
        const makeExecute = () =>
          ActionPersistence.make({
            runId: "incremental-cache-history",
            owner,
            sourceId: "action-test",
            execute: () => Effect.succeed("result")
          })
        const execute = makeExecute()
        const reads: Array<{ pages: number; rows: number }> = []
        for (let index = 0; index < 200; index++) {
          pages = 0
          rows = 0
          yield* execute({
            action: {},
            attempt: 1,
            key: `incremental-cache-history/${index}`,
            tier: "sealed",
            metadata: boundary
          }).pipe(Effect.provideService(Journal.Journal, counting))
          reads.push({ pages, rows })
        }
        expect(Math.max(...reads.map((read) => read.pages))).toBeLessThanOrEqual(1)
        expect(Math.max(...reads.map((read) => read.rows))).toBeLessThanOrEqual(4)
        expect(reads.reduce((total, read) => total + read.rows, 0)).toBeLessThanOrEqual(4 * 199)
        const resumed = makeExecute()
        for (let index = 200; index < 202; index++) {
          pages = 0
          rows = 0
          yield* resumed({
            action: {},
            attempt: 1,
            key: `incremental-cache-history/${index}`,
            tier: "sealed",
            metadata: boundary
          }).pipe(Effect.provideService(Journal.Journal, counting))
          // A new executor rebuilds once, then returns to incremental reads.
          expect(pages).toBe(index === 200 ? 7 : 1)
          expect(rows).toBe(index === 200 ? 800 : 4)
        }
      }).pipe(Effect.provide(layer), Effect.scoped)
    ))

  it.effect("does not dispatch when attempt admission reports an existing or conflicting row", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("admission-rejected")
          const base = yield* AttemptStore.AttemptStore
          const execute = () =>
            Effect.sync(() => {
              dispatches++
              return "unexpected"
            })
          const run = (outcome: AttemptStore.PutResult) =>
            Effect.exit(
              Effect.provideService(
                ActionPersistence.make({
                  runId: "admission-rejected",
                  owner,
                  sourceId: "action-test",
                  execute
                })({
                  action: {},
                  attempt: 1,
                  key: `admission/${outcome._tag}`,
                  tier: "sealed"
                }),
                AttemptStore.AttemptStore,
                AttemptStore.makeNoop({ ...base, put: () => Effect.succeed(outcome) })
              )
            )
          return yield* Effect.all([
            run({ _tag: "ExistingSame" }),
            run({ _tag: "Conflict" })
          ])
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      expect(dispatches).toBe(0)
      expect(result.every(Exit.isFailure)).toBe(true)
    }))

  it.effect("suppresses terminal and cache writes after every rejected attempt finish", () =>
    Effect.gen(function*() {
      const outcomes: ReadonlyArray<AttemptStore.FinishResult> = [
        { _tag: "FenceLost" },
        { _tag: "NotFound" },
        { _tag: "StateChanged" }
      ]
      let dispatches = 0
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("finish-rejected")
          const base = yield* AttemptStore.AttemptStore
          const exits = yield* Effect.forEach(outcomes, (outcome, index) =>
            Effect.exit(
              Effect.provideService(
                ActionPersistence.make({
                  runId: "finish-rejected",
                  owner,
                  sourceId: "action-test",
                  execute: () =>
                    Effect.sync(() => {
                      dispatches++
                      return index
                    })
                })({
                  action: {},
                  attempt: index + 1,
                  key: `finish-rejected/${index}`,
                  tier: "sealed",
                  metadata: boundary
                }),
                AttemptStore.AttemptStore,
                AttemptStore.makeNoop({
                  ...base,
                  get: () => Effect.succeedNone,
                  put: () => Effect.succeed({ _tag: "Inserted" }),
                  finish: () => Effect.succeed(outcome)
                })
              )
            ))
          const journal = yield* Journal.Journal
          yield* journal.flush
          return {
            exits,
            entries: yield* journal.entries({ runId: "finish-rejected" as never, limit: 20 })
          }
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      expect(dispatches).toBe(3)
      expect(
        result.exits.every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
      ).toBe(true)
      // A rejected finish still leaves the attempt's admission and its tier-2
      // frame anchor on the journal; what it must not leave is a terminal record.
      expect(result.entries.entries.map((entry) => entry.eventType)).toEqual([
        "flows.engine.attempt-started",
        "flows.engine.snapshot-identified",
        "flows.engine.attempt-started",
        "flows.engine.snapshot-identified",
        "flows.engine.attempt-started",
        "flows.engine.snapshot-identified"
      ])
    }))

  it.effect("preserves the first global cache writer when a concurrent miss loses the put race", () =>
    Effect.gen(function*() {
      const key = "cache-conflict"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("cache-conflict-run")
          const cache = yield* CacheStore.CacheStore
          yield* cache.put({
            keyDigest,
            result: "first",
            meta: { tier: "sealed", boundary: { declaredOutputs: {}, diffIdentity: "first" } },
            createdAtMs: 1,
            recordedRunId: "winning-run",
            recordedEventSeq: 0
          })
          const value = yield* Effect.provideService(
            ActionPersistence.make({
              runId: "cache-conflict-run",
              owner,
              sourceId: "action-test",
              execute: () => Effect.succeed("second")
            })({
              action: {},
              attempt: 1,
              key,
              tier: "sealed",
              metadata: boundary
            }),
            CacheStore.CacheStore,
            CacheStore.makeNoop({
              ...cache,
              get: () => Effect.succeedNone
            })
          )
          return { value, cached: yield* cache.get(keyDigest) }
        }).pipe(Effect.provide(tolerantLayer), Effect.scoped)
      )

      expect(result.value).toBe("second")
      expect(Option.getOrThrow(result.cached).result).toBe("first")
    }))

  it.effect("ignores cache rows without schema-valid hard-boundary evidence", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const values = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("malformed-cache-run")
          const cache = yield* CacheStore.CacheStore
          const malformed = [
            { tier: "sealed" },
            { tier: "sealed", boundary: { declaredOutputs: {}, diffIdentity: "" } },
            {
              tier: "sealed",
              boundary: { declaredOutputs: {}, diffIdentity: "legacy-without-whole-tree-proof" },
              readSetVerified: true
            },
            {
              tier: "sealed",
              boundary: {
                declaredOutputs: {},
                diffIdentity: "d",
                deviation: {
                  _tag: "ExpectedSetDeviation",
                  paths: ["undeclared"],
                  diffIdentity: "d"
                }
              }
            }
          ]
          for (const [index, meta] of malformed.entries()) {
            yield* cache.put({
              keyDigest: sha256(`malformed-cache/${index}`),
              result: "untrusted",
              meta,
              createdAtMs: 1,
              recordedRunId: "external-run",
              recordedEventSeq: index
            })
          }
          return yield* Effect.forEach(malformed, (_, index) =>
            ActionPersistence.make({
              runId: "malformed-cache-run",
              owner,
              sourceId: "action-test",
              execute: () =>
                Effect.sync(() => {
                  dispatches++
                  return `fresh-${index}`
                })
            })({
              action: {},
              attempt: index + 1,
              key: `malformed-cache/${index}`,
              tier: "sealed",
              metadata: boundary
            }))
        }).pipe(Effect.provide(tolerantLayer), Effect.scoped)
      )

      expect(values).toEqual(["fresh-0", "fresh-1", "fresh-2", "fresh-3"])
      expect(dispatches).toBe(4)
    }))

  it.effect("does not publish a hard-boundary result without whole-tree write proof", () =>
    Effect.gen(function*() {
      const key = "cache/no-whole-tree-proof"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("no-whole-tree-proof")
          const value = yield* ActionPersistence.make({
            runId: "no-whole-tree-proof",
            owner,
            sourceId: "action-test",
            execute: () => Effect.succeed("run-local")
          })({ action: {}, attempt: 1, key, tier: "sealed", metadata: boundary })
          const cache = yield* CacheStore.CacheStore
          return { value, cached: yield* cache.get(keyDigest) }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              TestStores.layer(),
              StepBoundary.layerTest({ wholeTreeWriteDetection: false }),
              jj
            )
          ),
          Effect.scoped
        )
      )

      expect(result.value).toBe("run-local")
      expect(Option.isNone(result.cached)).toBe(true)
    }))

  it.effect("does not publish a hard-boundary result without hermetic read proof", () =>
    Effect.gen(function*() {
      // The converse of the whole-tree case: publication fails closed on BOTH
      // proofs. Write verification alone describes what the body changed, not
      // what it observed — a row persisted by an unsandboxed producer must stay
      // run-local.
      const key = "cache/no-hermetic-read-proof"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("no-hermetic-read-proof")
          const value = yield* ActionPersistence.make({
            runId: "no-hermetic-read-proof",
            owner,
            sourceId: "action-test",
            execute: () => Effect.succeed("run-local")
          })({ action: {}, attempt: 1, key, tier: "sealed", metadata: boundary })
          const cache = yield* CacheStore.CacheStore
          return { value, cached: yield* cache.get(keyDigest) }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              TestStores.layer(),
              StepBoundary.layerTest({ hermeticReadDetection: false }),
              jj
            )
          ),
          Effect.scoped
        )
      )

      expect(result.value).toBe("run-local")
      expect(Option.isNone(result.cached)).toBe(true)
    }))

  it("decodes a persisted row carrying the write proof alone, and refuses to serve it", async () => {
    // The pre-sandbox evidence shape: `wholeTreeWritesVerified` only. The row
    // must keep decoding forever (the LegacyInlineOutput rule), and the hit
    // gate must refuse it for want of the read proof.
    const legacy = {
      declaredOutputs: { outputs: [{ path: "out.txt", digest: sha256("built") }] },
      diffIdentity: "legacy-diff",
      wholeTreeWritesVerified: true
    }
    const decoded = Schema.decodeUnknownResult(StepBoundary.BoundaryEvidence)(legacy)
    expect(decoded._tag).toBe("Success")
    if (decoded._tag === "Success") {
      expect(decoded.success.wholeTreeWritesVerified).toBe(true)
      expect(decoded.success.hermeticReadsVerified).toBeUndefined()
    }
  })
})

describe("engine-store error barrel", () => {
  it("exports every tagged-error class exposed by ActionPersistence", () => {
    let checked = 0
    for (const [name, value] of Object.entries(ActionPersistence)) {
      if (typeof value !== "function") continue
      const identifier = (value as { readonly identifier?: unknown }).identifier
      if (typeof identifier !== "string" || !identifier.startsWith("@smthrs/")) continue
      checked++
      expect(Reflect.get(Errors, name)).toBe(value)
    }
    expect(checked).toBeGreaterThan(0)
    expect(Errors.IrreversibleRetryRequiresIdempotencyKey)
      .toBe(Action.IrreversibleRetryRequiresIdempotencyKey)
  })
})
