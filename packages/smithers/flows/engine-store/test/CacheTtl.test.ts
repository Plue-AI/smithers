/**
 * The caller-declared cache policy at the dispatch seam: how long a recorded
 * sealed result may be served, and how far it may travel.
 *
 * Both halves are durable decisions, not process-local ones. An expired row is
 * journalled and evicted, so a replay reads the recorded verdict instead of
 * re-judging the age against a fresh clock; a narrowed scope is folded into
 * the digest the row is addressed by, so a sibling run simply never finds it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Digest, Effects } from "@smthrs/core"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as WithCache from "@smthrs/patterns/WithCache"
import { Node } from "@smthrs/plan"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as AttemptProbe from "../src/internal/AttemptProbe.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "cache-ttl-host", pid: 7, nonce: "cache-ttl-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "input.txt", digest: "D1" }],
  writeSet: [],
  boundaryMode: "hard"
}

const evidence: StepBoundary.BoundaryEvidence = {
  declaredOutputs: { outputs: [] },
  diffIdentity: "cache-ttl-diff",
  wholeTreeWritesVerified: true,
  hermeticReadsVerified: true
}

const boundaryLayer = Layer.succeed(
  StepBoundary.StepBoundary,
  StepBoundary.make({
    prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
    settle: () => Effect.succeed(evidence),
    replayOutputs: () => Effect.void
  })
)

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "cache-ttl-snapshot" as never, changeId: "cache-ttl-snapshot" as never }),
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
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

/** The one opaque step the inner flow performs. */
const readStep = Action.make("cache-ttl/read-step", {
  payload: { path: Schema.String },
  success: Schema.String,
  error: Schema.Never
})

/**
 * The inner flow every `WithCache` declaration in this suite wraps: hermetic,
 * sealed, and otherwise featureless, so the only thing that varies between two
 * declarations is the policy the test declares.
 */
const inner = Flow.make("cache-ttl/read", {
  payload: { path: Schema.String },
  success: Schema.String,
  error: Schema.Never,
  effects: Effects.make({ reads: [], writes: [], mode: "hermetic", onConflict: "serialize" }),
  body: Node.capture({}, ({ path }: { readonly path: string }) => readStep.call({ path }))
}) as unknown as Flow.Any

/**
 * A real `WithCache` declaration's annotation bag, in the shape the dispatch
 * seam reads it out of.
 *
 * The bag is not fabricated here. `WithCache.withCache` builds it, and
 * `ActionPersistence` reads it back through
 * `CacheEnvironment.CachePolicyAnnotation`, so these tests fail if the two
 * halves of the policy ever stop naming one key — which is the whole of what
 * makes a declared policy reach the engine.
 */
const declaredBy = (options: WithCache.Options) => ({
  annotations: WithCache.withCache(inner, options).annotations
})

/**
 * The canonical digest of everything `/keys` hashes for a declaration.
 *
 * `@smthrs/flow` publishes the material one node at a time rather than as an
 * aggregate, so the digest is taken over the built graph's nodes in order.
 */
const declaredKey = (options: WithCache.Options): string =>
  Digest.canonical(
    Graph.nodes(Graph.build(WithCache.withCache(inner, options), { path: "file" })).map((node) => node.draft.material)
  )

/**
 * Dispatches under a NAMED journal source.
 *
 * `sourceId` is the only thing a process contributes to a producer identity:
 * `EngineStore` sets it from `Options.journalSource`, so two names here are two
 * engine incarnations driving one run — which is what a resume after a crash
 * is.
 */
const dispatchFrom = (
  sourceId: string,
  runId: string,
  key: string,
  execute: () => Effect.Effect<unknown, unknown>,
  policy?: WithCache.Options,
  attempt = 1
) =>
  ActionPersistence.make({ runId, owner, sourceId, execute })({
    action: policy === undefined ? {} : declaredBy(policy),
    attempt,
    key,
    tier: "sealed",
    metadata: declared
  })

const dispatch = (
  runId: string,
  key: string,
  execute: () => Effect.Effect<unknown, unknown>,
  policy?: WithCache.Options,
  attempt = 1
) => dispatchFrom(`cache-ttl-${runId}`, runId, key, execute, policy, attempt)

/** A flow whose only role is to name the executing instance. */
const flowNamed = (tag: string) =>
  Flow.make(tag, {
    payload: {},
    success: Schema.String,
    body: () => Node.succeed("unused")
  })

/** Dispatches under the executing instance of `flow`, the way the engine does. */
const dispatchInFlow = (
  flow: Flow.Any,
  runId: string,
  key: string,
  execute: () => Effect.Effect<unknown, unknown>,
  policy: WithCache.Options
) =>
  dispatch(runId, key, execute, policy).pipe(
    Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, runId))
  )

/**
 * A wall clock fixed at `millis`, for a dispatch that runs on another host.
 *
 * Two incarnations of one run do not share a clock. A corrected system clock,
 * or simply a second machine, hands the resuming engine a reading the previous
 * one had already passed, and the whole point of journalling the admission
 * verdict is that the run's decision survives that. `TestClock` only moves
 * forward, so the second reading is supplied directly.
 */
const clockAt = (millis: number): Clock.Clock => {
  const nanos = BigInt(millis) * 1_000_000n
  return {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.succeed(millis),
    currentTimeNanosUnsafe: () => nanos,
    currentTimeNanos: Effect.succeed(nanos),
    monotonicTimeNanosUnsafe: () => nanos,
    monotonicTimeNanos: Effect.succeed(nanos),
    sleep: () => Effect.void
  }
}

/** Every cache-provenance record the run journalled, newest last. */
const provenance = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
      .map((entry) =>
        entry.payload as {
          readonly action?: string
          readonly ageMs?: number
          readonly ttlMs?: number
          readonly verdict?: string
        }
      )
  })

const layers = Layer.mergeAll(TestStores.layer(), jjLayer, boundaryLayer)

describe("declared time to live", () => {
  it.effect("serves the recorded result inside the bound without dispatching again", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () =>
          Effect.sync(() => {
            executions++
            return "recorded"
          })
        yield* activate("ttl-fresh-first")
        yield* dispatch("ttl-fresh-first", "ttl/fresh", body, { ttlMs: 1000 })
        yield* TestClock.adjust("1 second")
        yield* activate("ttl-fresh-second")
        const replayed = yield* dispatch("ttl-fresh-second", "ttl/fresh", body, { ttlMs: 1000 })
        expect(replayed).toBe("recorded")
        expect(executions).toBe(1)
        // The admission verdict is journalled before the hit is served, so the
        // replay reads a recorded decision rather than re-judging the age.
        expect((yield* provenance("ttl-fresh-second")).map((record) => record.action)).toEqual(["ttl", undefined])
        expect((yield* provenance("ttl-fresh-second"))[0]!.verdict).toBe("admitted")
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("re-executes past the bound and journals the expiry", () =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        let executions = 0
        const body = () =>
          Effect.sync(() => {
            executions++
            return `recorded-${executions}`
          })
        yield* activate("ttl-stale-first")
        yield* dispatch("ttl-stale-first", "ttl/stale", body, { ttlMs: 1000 })
        yield* TestClock.adjust("1001 millis")
        yield* activate("ttl-stale-second")
        const fresh = yield* dispatch("ttl-stale-second", "ttl/stale", body, { ttlMs: 1000 })
        expect(executions).toBe(2)
        expect(fresh).toBe("recorded-2")
        const expired = (yield* provenance("ttl-stale-second")).filter((record) => record.action === "expired")
        expect(expired.length).toBe(1)
        expect(expired[0]!.ttlMs).toBe(1000)
        expect(expired[0]!.ageMs).toBe(1001)
        // The stale row was evicted, so the re-execution records cleanly under
        // the same key instead of colliding with the value it replaced.
        const row = yield* cache.get(sha256("ttl/stale"))
        expect(Option.isSome(row) ? row.value.result : undefined).toBe("recorded-2")
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("leaves an undeclared policy unbounded", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, "recorded"))
        yield* activate("ttl-none-first")
        yield* dispatch("ttl-none-first", "ttl/none", body)
        yield* TestClock.adjust("1 hour")
        yield* activate("ttl-none-second")
        yield* dispatch("ttl-none-second", "ttl/none", body)
        expect(executions).toBe(1)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))
})

describe("the journalled admission verdict", () => {
  for (const scenario of ["larger TTL", "smaller TTL", "copied lineage"] as const) {
    it.effect(`refuses incompatible recorded decisions for ${scenario} without changing durable state`, () =>
      withCrypto(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const cache = yield* CacheStore.CacheStore
          const attempts = yield* AttemptStore.AttemptStore
          const boundary = yield* StepBoundary.StepBoundary
          const key = "verdict/policy-conflict"
          const digest = sha256(key)
          let executions = 0
          let replays = 0
          let evictions = 0
          const body = () => Effect.sync(() => (executions++, "recorded"))
          // Exercise the public Action annotation. TTL changes do not change
          // the engine's action key, so this dispatch retains its identity.
          const action = Action.make({
            name: "CacheTtl/PolicyConflict",
            success: Schema.String,
            tier: "sealed",
            idempotencyKey: "same-input",
            metadata: declared,
            execute: body()
          })
          const execute = (runId: string, ttlMs: number) =>
            ActionPersistence.make({ runId, owner, sourceId: "policy-conflict", execute: body })({
              action: CacheEnvironment.withCache(action, { ttlMs }),
              attempt: 1,
              key,
              tier: "sealed",
              metadata: declared
            })
          yield* activate("policy-producer")
          yield* execute("policy-producer", 1000)
          yield* TestClock.adjust("500 millis")
          yield* activate("policy-consumer")
          expect(yield* execute("policy-consumer", 1000)).toBe("recorded")
          const runId = JournalEvent.RunId.make(scenario === "copied lineage" ? "policy-child" : "policy-consumer")
          if (scenario === "copied lineage") {
            yield* journal.flush
            const parent = yield* journal.entries({ runId: JournalEvent.RunId.make("policy-consumer"), limit: 50 })
            const ttl = parent.entries.find((entry) =>
              entry.eventType === "flows.engine.cache-provenance" &&
              (entry.payload as { readonly action?: string }).action === "ttl"
            )!
            yield* activate(runId)
            // Time-travel copies retain producer identity, payload and parent
            // lineage metadata. An exact verdict with different meta conflicts.
            yield* journal.emitDurable({
              runId,
              sourceId: ttl.sourceId,
              sourceSeq: ttl.sourceSeq,
              eventType: ttl.eventType,
              payload: ttl.payload,
              meta: ttl.meta
            }, owner)
          }
          yield* journal.flush
          const beforeJournal = yield* journal.entries({ runId, limit: 50 })
          const beforeCache = yield* cache.get(digest)
          const producerId = { runId: "policy-producer", stepKeyDigest: digest, attempt: 1 }
          const consumerId = { runId, stepKeyDigest: digest, attempt: 1 }
          const beforeProducer = yield* attempts.get(producerId)
          expect(Option.isSome(beforeProducer)).toBe(true)
          expect(Option.isNone(yield* attempts.get(consumerId))).toBe(true)
          const ttlMs = scenario === "larger TTL" ? 2000 : scenario === "smaller TTL" ? 100 : 1000
          const result = yield* execute(runId, ttlMs).pipe(
            Effect.provideService(StepBoundary.StepBoundary, {
              ...boundary,
              replayOutputs: (output) =>
                Effect.sync(() => replays++).pipe(Effect.andThen(boundary.replayOutputs(output)))
            }),
            Effect.provideService(CacheStore.CacheStore, {
              ...cache,
              evict: (cacheKey, options) =>
                Effect.sync(() => evictions++).pipe(Effect.andThen(cache.evict(cacheKey, options)))
            }),
            Effect.result
          )
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(Journal.JournalError)
            expect(result.failure).toMatchObject({
              code: "idempotency_conflict",
              message: expect.stringContaining("incompatible recorded cache-age decision"),
              cause: expect.anything()
            })
          }
          expect(executions).toBe(1)
          expect(replays).toBe(0)
          expect(evictions).toBe(0)
          expect(yield* cache.get(digest)).toEqual(beforeCache)
          expect(yield* attempts.get(producerId)).toEqual(beforeProducer)
          expect(Option.isNone(yield* attempts.get(consumerId))).toBe(true)
          yield* journal.flush
          const afterJournal = yield* journal.entries({ runId, limit: 50 })
          expect(afterJournal.entries.slice(0, beforeJournal.entries.length)).toEqual(beforeJournal.entries)
          expect(afterJournal.entries.slice(beforeJournal.entries.length).map((entry) => entry.payload)).toEqual([{
            keyDigest: digest,
            action: "replay_failed",
            reason: "incompatible-age-history",
            recordedRunId: "policy-producer",
            recordedEventSeq: Option.getOrThrow(beforeCache).recordedEventSeq
          }])
          if (scenario !== "copied lineage") {
            expect(yield* execute(runId, 1000)).toBe("recorded")
            expect(executions).toBe(1)
          }
        }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
      ))
  }

  for (const response of ["sink_failed", "fence_lost", "Accepted"] as const) {
    it.effect(`requires historical proof of the opposite verdict when the journal returns ${response}`, () =>
      withCrypto(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const cache = yield* CacheStore.CacheStore
          const attempts = yield* AttemptStore.AttemptStore
          const boundary = yield* StepBoundary.StepBoundary
          const key = "verdict/opposite-proof"
          const digest = sha256(key)
          let executions = 0
          let replays = 0
          let oppositeProbes = 0
          const body = () => Effect.sync(() => (executions++, "recorded"))
          yield* activate("proof-producer")
          yield* dispatch("proof-producer", key, body, { ttlMs: 1000 })
          yield* activate("proof-consumer")
          yield* dispatch("proof-consumer", key, body, { ttlMs: 1000 })
          const beforeCache = yield* cache.get(digest)
          yield* journal.flush
          const beforeJournal = yield* journal.entries({ runId: JournalEvent.RunId.make("proof-consumer"), limit: 50 })
          const ttl = beforeJournal.entries.find((entry) =>
            entry.eventType === "flows.engine.cache-provenance" &&
            (entry.payload as { readonly action?: string }).action === "ttl"
          )!
          const sinkError = new Journal.JournalError({ code: "sink_failed", message: "opposite probe unavailable" })
          const failing: Journal.Service = {
            ...journal,
            emitDurable: (record, emitOwner) => {
              const payload = record.payload as { readonly action?: string; readonly verdict?: string }
              if (
                record.eventType === "flows.engine.cache-provenance" && payload.action === "ttl" &&
                payload.verdict === "admitted"
              ) {
                oppositeProbes++
                return response === "Accepted"
                  ? Effect.succeed({ _tag: "Accepted", seq: ttl.seq, sourceSeq: ttl.sourceSeq })
                  : Effect.fail(
                    response === "sink_failed"
                      ? sinkError
                      : new Journal.JournalError({ code: "fence_lost", message: "owner changed during probe" })
                  )
              }
              return journal.emitDurable(record, emitOwner)
            }
          }
          yield* TestClock.adjust("1001 millis")
          const result = yield* dispatch("proof-consumer", key, body, { ttlMs: 1000 }).pipe(
            Effect.provideService(Journal.Journal, failing),
            Effect.provideService(StepBoundary.StepBoundary, {
              ...boundary,
              replayOutputs: (output) =>
                Effect.sync(() => replays++).pipe(Effect.andThen(boundary.replayOutputs(output)))
            }),
            Effect.result,
            Effect.exit
          )
          expect(oppositeProbes).toBe(1)
          if (response === "fence_lost") {
            expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
          } else {
            expect(Exit.isSuccess(result) && Result.isFailure(result.value)).toBe(true)
            if (Exit.isSuccess(result) && Result.isFailure(result.value)) {
              if (response === "sink_failed") expect(result.value.failure).toBe(sinkError)
              else expect(result.value.failure).toMatchObject({ code: "idempotency_conflict" })
            }
          }
          expect(executions).toBe(1)
          expect(replays).toBe(0)
          expect(yield* cache.get(digest)).toEqual(beforeCache)
          expect(Option.isNone(yield* attempts.get({ runId: "proof-consumer", stepKeyDigest: digest, attempt: 1 })))
            .toBe(true)
          yield* journal.flush
          expect(yield* journal.entries({ runId: JournalEvent.RunId.make("proof-consumer"), limit: 50 })).toEqual(
            beforeJournal
          )
        }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
      ))
  }

  it.effect("keeps serving a row it already admitted after the clock crosses the bound", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, `recorded-${executions}`))
        yield* activate("verdict-hit-first")
        yield* dispatch("verdict-hit-first", "verdict/hit", body, { ttlMs: 1000 })

        // The second run admits the row at 900 ms and serves it.
        yield* TestClock.adjust("900 millis")
        yield* activate("verdict-hit-second")
        const served = yield* dispatch("verdict-hit-second", "verdict/hit", body, { ttlMs: 1000 })
        expect(served).toBe("recorded-1")

        // Its process dies before anything else becomes durable, and the driver
        // re-dispatches the same step past the bound. The verdict is already
        // journalled, so the replay reads "admitted" and serves the same row
        // instead of expiring a result the run has already consumed.
        yield* TestClock.adjust("200 millis")
        const replayed = yield* dispatch("verdict-hit-second", "verdict/hit", body, { ttlMs: 1000 })
        expect(replayed).toBe("recorded-1")
        expect(executions).toBe(1)
        const records = yield* provenance("verdict-hit-second")
        expect(records.filter((record) => record.action === "expired").length).toBe(0)
        expect(records.filter((record) => record.action === "ttl").map((record) => record.verdict)).toEqual([
          "admitted"
        ])
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("keeps a provenance it already expired expired when a copy is re-recorded", () =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        let executions = 0
        const body = () => Effect.sync(() => (executions++, `recorded-${executions}`))
        yield* activate("verdict-expiry-first")
        yield* dispatch("verdict-expiry-first", "verdict/expiry", body, { ttlMs: 1000 })
        const original = yield* cache.get(sha256("verdict/expiry"))
        if (Option.isNone(original)) return yield* Effect.die(new Error("the first dispatch recorded no row"))
        const recorded = original.value

        // The second run expires that provenance and records the verdict.
        yield* TestClock.adjust("1001 millis")
        yield* activate("verdict-expiry-second")
        yield* dispatch("verdict-expiry-second", "verdict/expiry", body, { ttlMs: 1000 })
        expect(executions).toBe(2)

        // A copy of the SAME recorded event lands again — a shared-tier
        // write-back, or a fork replaying the parent's rows. The provenance
        // ledger is immutable, so only a byte-identical copy restores the head,
        // and this is that copy.
        yield* cache.evict(sha256("verdict/expiry"))
        expect((yield* cache.put(recorded))._tag).toBe("Inserted")

        // The dispatch is re-driven on a host whose clock reads a moment inside
        // the bound, so its own measurement would admit the restored row. The
        // run already decided that provenance is expired, so the decision holds
        // and the fresh-looking copy is not served.
        const after = yield* dispatch("verdict-expiry-second", "verdict/expiry", body, { ttlMs: 1000 }).pipe(
          Effect.provideService(Clock.Clock, clockAt(1000))
        )
        // Not the restored copy: the recorded verdict refused it, so the
        // dispatch fell through to this attempt's own durable outcome.
        expect(after).toBe("recorded-2")
        expect(executions).toBe(2)
        expect(
          (yield* provenance("verdict-expiry-second")).filter((record) => record.action === "ttl").map((record) =>
            record.verdict
          )
        ).toEqual(["expired"])
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("reads a verdict another journal source recorded rather than taking a second one", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, `recorded-${executions}`))
        yield* activate("verdict-source-first")
        yield* dispatch("verdict-source-first", "verdict/source", body, { ttlMs: 1000 })

        // Engine A admits the row at 900 ms and serves it.
        yield* TestClock.adjust("900 millis")
        yield* activate("verdict-source-second")
        const served = yield* dispatchFrom(
          "engine-a",
          "verdict-source-second",
          "verdict/source",
          body,
          { ttlMs: 1000 }
        )
        expect(served).toBe("recorded-1")

        // Engine A dies. Engine B resumes the SAME run past the bound, and B is
        // a different process, so its `journalSource` is a different string.
        // The verdict belongs to the run, not to the incarnation that took it:
        // B reads A's decision instead of re-judging the age against its own
        // clock and expiring a result the run has already consumed.
        yield* TestClock.adjust("200 millis")
        const replayed = yield* dispatchFrom(
          "engine-b",
          "verdict-source-second",
          "verdict/source",
          body,
          { ttlMs: 1000 }
        )
        expect(replayed).toBe("recorded-1")
        expect(executions).toBe(1)
        const records = yield* provenance("verdict-source-second")
        // One verdict, not one per incarnation.
        expect(records.filter((record) => record.action === "ttl").map((record) => record.verdict)).toEqual([
          "admitted"
        ])
        expect(records.filter((record) => record.action === "expired").length).toBe(0)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("keeps an expiry another journal source recorded", () =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        let executions = 0
        const body = () => Effect.sync(() => (executions++, `recorded-${executions}`))
        yield* activate("verdict-source-expiry-first")
        yield* dispatch("verdict-source-expiry-first", "verdict/source-expiry", body, { ttlMs: 1000 })
        const original = yield* cache.get(sha256("verdict/source-expiry"))
        if (Option.isNone(original)) return yield* Effect.die(new Error("the first dispatch recorded no row"))
        const recorded = original.value

        // Engine A expires that provenance past the bound and records the
        // verdict.
        yield* TestClock.adjust("1001 millis")
        yield* activate("verdict-source-expiry-second")
        yield* dispatchFrom(
          "engine-a",
          "verdict-source-expiry-second",
          "verdict/source-expiry",
          body,
          { ttlMs: 1000 }
        )
        expect(executions).toBe(2)

        // A byte-identical copy of the same recorded event lands again, which
        // is the only copy the immutable provenance ledger admits.
        yield* cache.evict(sha256("verdict/source-expiry"))
        expect((yield* cache.put(recorded))._tag).toBe("Inserted")

        // Engine B resumes the run on a host whose clock is behind A's, so its
        // own measurement admits the restored row. The refusal is as durable as
        // the admission: B reads the expiry A recorded and does not serve it.
        const after = yield* dispatchFrom(
          "engine-b",
          "verdict-source-expiry-second",
          "verdict/source-expiry",
          body,
          { ttlMs: 1000 }
        ).pipe(Effect.provideService(Clock.Clock, clockAt(1000)))
        expect(after).toBe("recorded-2")
        expect(executions).toBe(2)
        expect(
          (yield* provenance("verdict-source-expiry-second")).filter((record) => record.action === "ttl").map(
            (record) => record.verdict
          )
        ).toEqual(["expired"])
        // B evicted the restored copy under the recorded verdict, so the row a
        // later reader finds is this attempt's own durable outcome, never the
        // one the run had already refused.
        const surviving = yield* cache.get(sha256("verdict/source-expiry"))
        expect(Option.isSome(surviving) ? surviving.value.result : undefined).toBe("recorded-2")
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("fails the dispatch when the verdict cannot be journalled at all", () =>
    withCrypto(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        let executions = 0
        const body = () => Effect.sync(() => (executions++, "recorded"))
        yield* activate("verdict-sink-first")
        yield* dispatch("verdict-sink-first", "verdict/sink", body, { ttlMs: 1000 })

        // A journal that cannot take the verdict is not a reason to guess one:
        // the dispatch fails rather than serving or expiring a row whose
        // admission nothing recorded.
        const failing: Journal.Service = {
          ...journal,
          emitDurable: (record, emitOwner) =>
            record.eventType === "flows.engine.cache-provenance"
              ? Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "journal sink down" }))
              : journal.emitDurable(record, emitOwner)
        }
        yield* activate("verdict-sink-second")
        const failure = yield* dispatch("verdict-sink-second", "verdict/sink", body, { ttlMs: 1000 }).pipe(
          Effect.provideService(Journal.Journal, failing),
          Effect.flip
        )
        expect((failure as { readonly code?: string }).code).toBe("sink_failed")
        expect(executions).toBe(1)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))
})

describe("declared scope", () => {
  it.effect("keeps a run-scoped result inside its own run", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, "recorded"))
        yield* activate("scope-run-first")
        yield* dispatch("scope-run-first", "scope/run", body, { scope: "run" })
        yield* activate("scope-run-second")
        yield* dispatch("scope-run-second", "scope/run", body, { scope: "run" })
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("shares a shared-scoped result across runs", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, "recorded"))
        yield* activate("scope-shared-first")
        yield* dispatch("scope-shared-first", "scope/shared", body, { scope: "shared" })
        yield* activate("scope-shared-second")
        yield* dispatch("scope-shared-second", "scope/shared", body, { scope: "shared" })
        expect(executions).toBe(1)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("addresses a run-scoped row under a digest no sibling derives", () =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("scope-digest")
        yield* dispatch("scope-digest", "scope/digest", () => Effect.succeed("recorded"), { scope: "run" })
        // The unscoped digest is what every other run derives; the row is not
        // under it.
        expect(Option.isNone(yield* cache.get(sha256("scope/digest")))).toBe(true)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))
})

/**
 * A narrowed scope moves the CACHE ROW, and nothing else.
 *
 * The attempt rows a dispatch writes are addressed by `(runId,
 * sha256(input.key), attempt)`, and every seam that reads them back derives
 * that digest from the key alone: `EngineStore.actionRetryOrigin` (the durable
 * schedule-to-close origin, issue #45), `EngineStore.actionLatestAttempt` (the
 * durable attempt counter, issue #59), and `PlanScheduler`, which maps an
 * attempt's `stepKeyDigest` back to the node that dispatched it. None of them
 * can see a declaration's annotations, so a scoped step whose attempts landed
 * under a narrowed digest would be invisible to all three: a resumed run would
 * restart numbering at 1, re-measure its expiration budget, and drop the step's
 * expected-set deviations on the floor.
 */
describe("the attempt rows of a scoped step", () => {
  /** Exactly what `EngineStore` probes with: the key, and nothing else. */
  const probe = (runId: string, key: string) =>
    Effect.flatMap(
      AttemptStore.AttemptStore,
      (attempts) => AttemptProbe.probeAttempts(attempts, undefined, runId, sha256(key))
    )

  it.effect("stay under the digest the engine probes, and number the retry from them", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        yield* activate("scope-attempts")
        // Attempt 1 fails, which is what makes the attempt row worth finding.
        const failure = yield* dispatch(
          "scope-attempts",
          "scope/attempts",
          () => Effect.sync(() => executions++).pipe(Effect.andThen(Effect.fail("boom"))),
          { scope: "run" }
        ).pipe(Effect.flip)
        expect(failure).toBe("boom")

        const first = yield* probe("scope-attempts", "scope/attempts")
        expect(Option.isSome(first)).toBe(true)
        expect(Option.getOrUndefined(first)?.latest).toBe(1)

        // The retry is attempt 2 because the counter found attempt 1. Its row
        // lands under the same digest, so the next resume finds both.
        const recovered = yield* dispatch(
          "scope-attempts",
          "scope/attempts",
          () => Effect.sync(() => (executions++, "recorded")),
          { scope: "run" },
          2
        )
        expect(recovered).toBe("recorded")
        expect(executions).toBe(2)
        const second = yield* probe("scope-attempts", "scope/attempts")
        expect(Option.getOrUndefined(second)?.latest).toBe(2)
        expect(Option.getOrUndefined(second)?.earliestAttempt).toBe(1)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("still address the cache row under the narrowed digest", () =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        yield* activate("scope-attempts-row")
        yield* dispatch("scope-attempts-row", "scope/attempts-row", () => Effect.succeed("recorded"), {
          scope: "run"
        })
        // The attempt row is under the plain digest and the cache row is not:
        // the two identities moved apart, which is the whole of what the scope
        // asked for.
        expect(Option.isSome(yield* probe("scope-attempts-row", "scope/attempts-row"))).toBe(true)
        expect(Option.isNone(yield* cache.get(sha256("scope/attempts-row")))).toBe(true)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))
})

describe("flow scope", () => {
  it.effect("shares a row between two runs of the same flow", () =>
    withCrypto(
      Effect.gen(function*() {
        const flow = flowNamed("CacheTtl/Shared")
        let executions = 0
        const body = () => Effect.sync(() => (executions++, "recorded"))
        yield* activate("scope-flow-first")
        yield* dispatchInFlow(flow, "scope-flow-first", "scope/flow", body, { scope: "flow" })
        yield* activate("scope-flow-second")
        yield* dispatchInFlow(flow, "scope-flow-second", "scope/flow", body, { scope: "flow" })
        expect(executions).toBe(1)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("keeps a second flow out of the first flow's row", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, `recorded-${executions}`))
        yield* activate("scope-flow-a")
        yield* dispatchInFlow(flowNamed("CacheTtl/A"), "scope-flow-a", "scope/flow-pair", body, { scope: "flow" })
        yield* activate("scope-flow-b")
        const second = yield* dispatchInFlow(
          flowNamed("CacheTtl/B"),
          "scope-flow-b",
          "scope/flow-pair",
          body,
          { scope: "flow" }
        )
        expect(executions).toBe(2)
        expect(second).toBe("recorded-2")
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("narrows to the run when no instance names a flow", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, "recorded"))
        yield* activate("scope-flowless-first")
        yield* dispatch("scope-flowless-first", "scope/flowless", body, { scope: "flow" })
        yield* activate("scope-flowless-second")
        yield* dispatch("scope-flowless-second", "scope/flowless", body, { scope: "flow" })
        expect(executions).toBe(2)
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))
})

describe("declared version", () => {
  it.effect("reuses a row across runs of one declared version", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, `recorded-${executions}`))
        const options = { scope: "shared", version: "v1" } as const
        const key = declaredKey(options)
        yield* activate("version-one-first")
        yield* dispatch("version-one-first", key, body, options)
        yield* activate("version-one-second")
        const replayed = yield* dispatch("version-one-second", key, body, options)
        expect(executions).toBe(1)
        expect(replayed).toBe("recorded-1")
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))

  it.effect("misses when only the declared version changes", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const body = () => Effect.sync(() => (executions++, `recorded-${executions}`))
        // Both step keys come from the real declarations, through the key
        // material `/keys` hashes, so this is the version dial doing the work
        // and not two hand-written strings.
        const first = { scope: "shared", version: "v1" } as const
        const second = { scope: "shared", version: "v2" } as const
        expect(declaredKey(first)).not.toBe(declaredKey(second))
        yield* activate("version-change-first")
        yield* dispatch("version-change-first", declaredKey(first), body, first)
        yield* activate("version-change-second")
        const fresh = yield* dispatch("version-change-second", declaredKey(second), body, second)
        expect(executions).toBe(2)
        expect(fresh).toBe("recorded-2")
      }).pipe(Effect.provide(layers), Effect.provide(TestClock.layer()), Effect.scoped)
    ))
})

/**
 * The same policy, on a real engine.
 *
 * Everything above drives `ActionPersistence` directly, which is the right
 * altitude for the seam's own rules. This suite is the end-to-end claim: a
 * sealed `@smthrs/flow` action carrying a declared cache policy, executed by
 * `EngineStore` over real SQLite, actually stops dispatching inside the bound
 * and starts again past it.
 *
 * The policy is declared with `CacheEnvironment.withCache`, the action form,
 * because that is the form the engine executes at HEAD. The core-flow form,
 * `@smthrs/patterns`' `WithCache`, writes the same policy under the same
 * annotation identifier: `packages/smithers/flows/patterns/test/WithCache.test.ts` reads a
 * real `WithCache` wrapper's bag back with `@smthrs/flow`'s own reader, and the
 * seam suites above dispatch bags that a real `WithCache` declaration
 * produced. What is missing between the two is the descriptor-to-interpreter
 * bridge, which no flows HEAD has: a `@smthrs/core` flow is a declaration the
 * durable engine cannot run yet, so its policy is honored once that bridge
 * lowers it onto the dispatched action.
 */
describe("a WithCache policy on the durable engine", () => {
  const Bundle = Action.make("cache-ttl/bundle", {
    payload: { target: Schema.String },
    success: Schema.String
  })

  const Build = Flow.make("cache-ttl/build", {
    payload: { target: Schema.String },
    success: Schema.String,
    body: (payload) => Bundle.call(payload)
  })

  /**
   * The sealed step whose result travels. It needs an idempotency key (an
   * identity another run can derive), a HARD file boundary (only a hermetic
   * step is reusable across runs), and the policy annotation a real
   * `WithCache` declaration carries.
   *
   * `version` is that identity's revision, and it is the caller's dial for
   * "the inputs did not change but the meaning did". It rides the idempotency
   * key rather than the policy annotation because on this side of the seam a
   * version is declaration identity and nothing else: `@smthrs/engine`'s
   * `ActionKey` folds a sealed action's `idempotencyKey` into the step key, so
   * a revised version addresses a different row. `@smthrs/patterns`' `WithCache`
   * spells the same thing for a `@smthrs/core` flow — `Options.version` enters
   * the wrapper's captured key material and is deliberately absent from the
   * `Policy` the engine reads, for exactly this reason.
   */
  const compile = (policy: CacheEnvironment.CachePolicy, onExecute: () => void, version = "v1") =>
    CacheEnvironment.withCache(
      Action.make({
        name: "cache-ttl/compile",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: `cache-ttl/compile@${version}`,
        metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
        execute: Effect.sync(() => {
          onExecute()
          return "dist/server.js"
        })
      }),
      policy
    )

  // Every durable service over ONE database, the way `EngineStore` composes in
  // production. `TestStores.layer()` above does the same for the four stores
  // the seam tests need; a full engine also needs `DurableEngineState`, so the
  // graph is written out here rather than layered on top of a second database.
  const engineLayers = Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(
    Layer.provideMerge(TestStores.database),
    Layer.merge(OwnerIdentity.layer),
    Layer.merge(jjLayer),
    Layer.merge(boundaryLayer),
    Layer.merge(Action.layerCacheEnvironment({ layers: [], capabilities: {} }))
  )

  /** One run of `Build` on a fresh engine incarnation over the shared stores. */
  const runOn = (
    hostId: string,
    executionId: string,
    policy: CacheEnvironment.CachePolicy,
    onExecute: () => void,
    version?: string
  ) =>
    Effect.gen(function*() {
      const engine = yield* EngineStore.make({
        owner: { hostId },
        journalSource: `cache-ttl-${hostId}`,
        isAlive: () => Effect.succeed(false)
      })
      const wiring = Layer.mergeAll(
        Bundle.toLayer(({ target }) =>
          Effect.map(compile(policy, onExecute, version), (built) => `${built}?target=${target}`)
        ),
        Interpreter.layer(Build)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
      )
      return yield* Build.execute({ target: "server" }, { executionId }).pipe(Effect.provide(wiring))
    })

  it.effect("shares incremental age history across the engine's per-dispatch executors", () =>
    withCrypto(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        let pages = 0
        const reads: Array<number> = []
        const counting: Journal.Service = {
          ...journal,
          entries: (options) =>
            journal.entries(options).pipe(Effect.tap(() =>
              Effect.sync(() => {
                pages++
              })
            ))
        }
        const engine = yield* EngineStore.make({
          owner: { hostId: "incremental-engine" },
          journalSource: "incremental-engine",
          isAlive: () => Effect.succeed(false)
        }).pipe(Effect.provideService(Journal.Journal, counting))
        const wiring = Layer.mergeAll(
          Bundle.toLayer(() =>
            Effect.gen(function*() {
              for (let index = 0; index < 50; index++) {
                pages = 0
                yield* compile({}, () => {}, `incremental-${index}`)
                reads.push(pages)
              }
              return "built"
            })
          ),
          Interpreter.layer(Build)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        expect(
          yield* Build.execute({ target: "server" }, { executionId: "incremental-engine" }).pipe(
            Effect.provide(wiring)
          )
        ).toBe("built")
        expect(reads).toHaveLength(50)
        expect(Math.max(...reads)).toBeLessThanOrEqual(1)
      }).pipe(Effect.scoped, Effect.provide(engineLayers))
    ))

  it.effect("replays inside the declared bound and dispatches again past it", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const count = () => {
          executions++
        }
        const policy = { ttlMs: 1000, scope: "shared" } as const
        const first = yield* runOn("ttl-engine-a", "ttl-engine-a", policy, count)
        expect(first).toBe("dist/server.js?target=server")
        expect(executions).toBe(1)

        // Inside the bound: a second engine over the same database reads the
        // recorded row and never reaches the body.
        yield* TestClock.adjust("900 millis")
        const replayed = yield* runOn("ttl-engine-b", "ttl-engine-b", policy, count)
        expect(replayed).toBe("dist/server.js?target=server")
        expect(executions).toBe(1)

        // Past it: the row is expired, journalled, and replaced.
        yield* TestClock.adjust("200 millis")
        const rebuilt = yield* runOn("ttl-engine-c", "ttl-engine-c", policy, count)
        expect(rebuilt).toBe("dist/server.js?target=server")
        expect(executions).toBe(2)
        const expired = (yield* provenance("ttl-engine-c")).filter((record) => record.action === "expired")
        expect(expired.length).toBe(1)
        expect(expired[0]!.ttlMs).toBe(1000)
      }).pipe(Effect.scoped, Effect.provide(engineLayers), Effect.provide(TestClock.layer()))
    ))

  it.effect("re-executes when only the declared version changes", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const count = () => {
          executions++
        }
        const policy = { scope: "shared" } as const
        const first = yield* runOn("version-engine-a", "version-engine-a", policy, count, "v1")
        expect(first).toBe("dist/server.js?target=server")
        expect(executions).toBe(1)

        // The control: a second run of the SAME declared version, over the same
        // database, replays the recorded row and never reaches the body.
        const replayed = yield* runOn("version-engine-b", "version-engine-b", policy, count, "v1")
        expect(replayed).toBe("dist/server.js?target=server")
        expect(executions).toBe(1)

        // The dial: nothing about the inputs, the policy, or the clock moved —
        // only the caller's revision of the body. A version is declaration
        // identity, so it changes the key the step is addressed by, and the row
        // recorded under the old revision is simply not this step's row.
        const rebuilt = yield* runOn("version-engine-c", "version-engine-c", policy, count, "v2")
        expect(rebuilt).toBe("dist/server.js?target=server")
        expect(executions).toBe(2)
      }).pipe(Effect.scoped, Effect.provide(engineLayers), Effect.provide(TestClock.layer()))
    ))

  it.effect("keeps dispatching an undeclared policy at every age", () =>
    withCrypto(
      Effect.gen(function*() {
        let executions = 0
        const count = () => {
          executions++
        }
        yield* runOn("ttl-engine-plain-a", "ttl-engine-plain-a", { scope: "shared" }, count)
        yield* TestClock.adjust("1 hour")
        yield* runOn("ttl-engine-plain-b", "ttl-engine-plain-b", { scope: "shared" }, count)
        // No time to live, so age never refuses the row: one execution total,
        // an hour apart.
        expect(executions).toBe(1)
      }).pipe(Effect.scoped, Effect.provide(engineLayers), Effect.provide(TestClock.layer()))
    ))
})
