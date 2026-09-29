import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { FlowEngine } from "@smthrs/engine"
import { DurableEngineState, EngineStore, OwnerIdentity, StepBoundary } from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

/**
 * The one sealed atom the fork replays. It is a DECLARED action, so the same
 * value addresses the recorded result in the parent's composition and in the
 * restarted one; only the implementation is attached per composition.
 */
const ForkOnce = Action.make("fork-once", {
  payload: {},
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "fork-execution-v1"
})

const ForkFlow = Flow.make("TimeTravel/ExecutableFork", {
  payload: {},
  success: Schema.String,
  body: (payload) => ForkOnce.call(payload)
})

const PrefixSealed = Action.make("fork-prefix-sealed", {
  payload: {},
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "fork-prefix-sealed-v1"
})
const ForkSuffix = Action.make("fork-suffix", {
  payload: {},
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "fork-suffix-v1"
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "fork-execution" as never, changeId: "fork-execution" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const requirements = (filename: string, sharedCache: boolean) => {
  const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  const migratedDatabase = Layer.provideMerge(Migrations.layer, database)
  const sqlServices = Layer.provideMerge(
    Layer.mergeAll(
      AttemptStore.layer,
      CacheStore.layer,
      RunStore.layer,
      DurableEngineState.layer,
      SqlJournal.layer({ capacity: 64, overflow: "reject" })
    ),
    migratedDatabase
  )
  // NodeCrypto feeds the merged stack rather than sitting beside it:
  // OwnerIdentity.layer consumes the Crypto service at construction.
  return Layer.mergeAll(
    sqlServices,
    StepBoundary.layerTest(),
    Layer.succeed(FlowEngine.SnapshotBoundary, {
      snapshot: () => Effect.succeed({}),
      restore: () => Effect.void,
      diff: () => Effect.succeed({})
    }),
    OwnerIdentity.layer,
    Layer.succeed(Jj.Jj, jj),
    // Both cache environments must reuse a sealed result copied into the fork.
    sharedCache ? Action.layerCacheEnvironment({ layers: [], capabilities: {} }) : Layer.empty
  ).pipe(Layer.provideMerge(NodeCrypto.layer))
}

describe("SQL fork execution", () => {
  it.effect.each([
    { sharedCache: false, behavior: "run-scoped prefix reuse" },
    { sharedCache: true, behavior: "shared cache reuse" }
  ])("drives a fork after restart with $behavior", ({ sharedCache }) =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-fork-execution-")))
      const filename = join(directory, "fork.sqlite")
      let dispatches = 0
      /** The implementation, plus the body that names it, over one table. */
      const wiring = (engine: FlowRuntime.FlowRuntime["Service"]) =>
        Layer.mergeAll(
          ForkOnce.toLayer(() =>
            Effect.sync(() => {
              dispatches++
              return "action-result"
            })
          ),
          Interpreter.layer(ForkFlow)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )

      try {
        const created = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId: "fork-parent" },
                journalSource: "fork-execution",
                isAlive: () => Effect.succeed(false)
              })
              const parentResult = yield* ForkFlow.execute({}, { executionId: "fork-parent" }).pipe(
                Effect.provide(wiring(engine))
              )
              const journal = yield* Journal.Journal
              yield* journal.flush
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const maximum = yield* sql<{ readonly seq: number | null }>`
              SELECT MAX(seq) AS seq
              FROM flows_journal_events
              WHERE run_id = 'fork-parent'
            `
              const store = yield* SqlTimeTravelStore.make
              // The frame's lineage comes from the constructor that mints it. Re-derived on
              // 2026-09-01: `FlowEngine.Lineage` moved the root address from `<runId>/root`
              // to a versioned encoded tuple, so the old literal named a lineage the engine
              // no longer writes.
              const fork = yield* store.createFork("fork-parent", {
                lineageId: FlowEngine.Lineage.root("fork-parent"),
                seq: maximum[0]?.seq ?? 0
              })
              const states = yield* sql<{ readonly run_id: string; readonly state_json: string }>`
              SELECT run_id, state_json
              FROM flows_runs
              WHERE run_id IN ('fork-parent', ${fork.runId})
              ORDER BY run_id
            `
              const attempts = yield* sql<{ readonly run_id: string; readonly count: number }>`
              SELECT run_id, COUNT(*) AS count
              FROM flows_attempts
              WHERE run_id IN ('fork-parent', ${fork.runId})
              GROUP BY run_id
              ORDER BY run_id
            `
              return { fork, parentResult, states, attempts }
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        )

        const childState = JSON.parse(
          created.states.find((row) => row.run_id === created.fork.runId)!.state_json
        ) as Record<string, unknown>
        const parentState = JSON.parse(
          created.states.find((row) => row.run_id === "fork-parent")!.state_json
        ) as Record<string, unknown>
        expect(created.parentResult).toBe("action-result")
        expect(parentState.result).toEqual({
          _tag: "Complete",
          exit: { _tag: "Success", value: "action-result" }
        })
        expect(childState).toMatchObject({
          version: 1,
          flowName: ForkFlow._tag,
          payload: {}
        })
        expect(childState).not.toHaveProperty("result")
        expect(childState).not.toHaveProperty("cancellation")
        expect(created.attempts).toEqual([
          { run_id: "fork-parent", count: 1 },
          { run_id: created.fork.runId, count: 1 }
        ])

        const restarted = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId: "fork-restart" },
                journalSource: "fork-execution",
                isAlive: () => Effect.succeed(false)
              })
              const value = yield* ForkFlow.execute({}, { executionId: created.fork.runId }).pipe(
                Effect.provide(wiring(engine))
              )
              const row = yield* (yield* RunStore.RunStore).get(created.fork.runId)
              return { value, row }
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        )

        expect(restarted.value).toBe("action-result")
        expect(restarted.row.status).toBe("completed")
        expect(dispatches).toBe(1)
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }), 15_000)

  it.effect.each([
    { tier: "compensable" as const, sharedCache: false },
    { tier: "irreversible" as const, sharedCache: false },
    { tier: "compensable" as const, sharedCache: true },
    { tier: "irreversible" as const, sharedCache: true }
  ])(
    "reuses a sealed and $tier prefix, reruns its suffix, then reuses the child's suffix (shared cache: $sharedCache)",
    ({ tier, sharedCache }) =>
      Effect.gen(function*() {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-fork-sequence-")))
        const filename = join(directory, "fork.sqlite")
        const parentId = "fork-sequence-parent"
        const middle = Action.make("fork-prefix-middle", {
          payload: {},
          success: Schema.String,
          tier,
          idempotencyKey: "fork-prefix-middle-v1"
        })
        const flow = Flow.make("TimeTravel/ForkSequence", {
          payload: {},
          success: Schema.String,
          body: (payload) =>
            PrefixSealed.call(payload).pipe(
              Node.bindPlanned(() => middle.call(payload)),
              Node.bindPlanned(() => ForkSuffix.call(payload))
            )
        })
        const dispatches = { sealed: 0, middle: 0, suffix: 0 }
        const wiring = (engine: FlowRuntime.FlowRuntime["Service"]) =>
          Layer.mergeAll(
            PrefixSealed.toLayer(() =>
              Action.make({
                name: "fork-prefix-sealed",
                tier: "sealed",
                idempotencyKey: "fork-prefix-sealed-v1",
                success: Schema.String,
                metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
                execute: Effect.sync(() => `sealed-${++dispatches.sealed}`)
              })
            ),
            middle.toLayer(() => Effect.sync(() => `middle-${++dispatches.middle}`)),
            ForkSuffix.toLayer(() =>
              Action.make({
                name: "fork-suffix",
                tier: "sealed",
                idempotencyKey: "fork-suffix-v1",
                success: Schema.String,
                metadata: { readSet: [], writeSet: [], boundaryMode: "hard" },
                execute: Effect.sync(() => `suffix-${++dispatches.suffix}`)
              })
            ),
            Interpreter.layer(flow)
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
          )
        const run = (runId: string, hostId: string) =>
          Effect.scoped(
            Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId },
                journalSource: "fork-sequence",
                isAlive: () => Effect.succeed(false)
              })
              const value = yield* flow.execute({}, { executionId: runId }).pipe(Effect.provide(wiring(engine)))
              yield* (yield* Journal.Journal).flush
              return value
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        const forkAt = (runId: string, seq: number) =>
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* SqlTimeTravelStore.make
              return yield* store.createFork(runId, { lineageId: FlowEngine.Lineage.root(runId), seq })
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        const frameFor = (runId: string, eventType: string, ordinal: number) =>
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const rows = yield* sql<{ readonly seq: number }>`
                SELECT seq FROM flows_journal_events
                WHERE run_id = ${runId} AND event_type = ${eventType}
                ORDER BY seq
              `
              expect(rows.length).toBeGreaterThan(ordinal < 0 ? 0 : ordinal)
              return (ordinal < 0 ? rows.at(-1) : rows[ordinal])!.seq
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        const middleFrames = () =>
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const starts = yield* sql<{ readonly seq: number; readonly payload_json: string }>`
                SELECT seq, payload_json FROM flows_journal_events
                WHERE run_id = ${parentId} AND event_type = 'flows.engine.attempt-started'
                ORDER BY seq
              `
              const started = starts.find((row) => (JSON.parse(row.payload_json) as { tier?: string }).tier === tier)
              expect(started).toBeDefined()
              const digest = (JSON.parse(started!.payload_json) as { stepKeyDigest: string }).stepKeyDigest
              const finishes = yield* sql<{ readonly seq: number; readonly payload_json: string }>`
                SELECT seq, payload_json FROM flows_journal_events
                WHERE run_id = ${parentId} AND event_type = 'flows.engine.attempt-finished'
                ORDER BY seq
              `
              const finished = finishes.find((row) =>
                (JSON.parse(row.payload_json) as { stepKeyDigest?: string }).stepKeyDigest === digest
              )
              expect(finished).toBeDefined()
              return { started: started!.seq, finished: finished!.seq }
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        const irreversibleBoundaryFrame = () =>
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const rows = yield* sql<{ readonly seq: number; readonly payload_json: string }>`
                SELECT seq, payload_json FROM flows_journal_events
                WHERE run_id = ${parentId} AND event_type = 'flows.time-travel.effect-boundary'
                ORDER BY seq
              `
              const crossed = rows.find((row) => {
                const effect = (JSON.parse(row.payload_json) as {
                  effect?: { tier?: string; status?: string }
                }).effect
                return effect?.tier === "irreversible" && effect.status === "intended"
              })
              expect(crossed).toBeDefined()
              return crossed!.seq
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )
        const cacheRowsFor = (runId: string) =>
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              return yield* sql<{ readonly key_digest: string }>`
                SELECT key_digest FROM flows_step_cache_recorded WHERE recorded_run_id = ${runId}
              `
            }).pipe(Effect.provide(requirements(filename, sharedCache)))
          )

        try {
          expect(yield* run(parentId, "fork-sequence-parent-host")).toBe("suffix-1")
          expect(dispatches).toEqual({ sealed: 1, middle: 1, suffix: 1 })
          if (sharedCache) expect((yield* cacheRowsFor(parentId)).length).toBeGreaterThanOrEqual(2)
          const middleFrame = yield* middleFrames()
          const child = yield* forkAt(parentId, middleFrame.finished)
          expect(yield* run(child.runId, "fork-sequence-child-host")).toBe("suffix-2")
          expect(dispatches).toEqual({ sealed: 1, middle: 1, suffix: 2 })

          const sibling = yield* forkAt(parentId, middleFrame.finished)
          expect(yield* run(sibling.runId, "fork-sequence-sibling-host")).toBe("suffix-3")
          expect(dispatches).toEqual({ sealed: 1, middle: 1, suffix: 3 })

          const afterChildSuffix = yield* frameFor(child.runId, "flows.engine.attempt-finished", -1)
          const grandchild = yield* forkAt(child.runId, afterChildSuffix)
          expect(yield* run(grandchild.runId, "fork-sequence-grandchild-host")).toBe("suffix-2")
          expect(dispatches).toEqual({ sealed: 1, middle: 1, suffix: 3 })

          const unfinishedChild = yield* forkAt(parentId, middleFrame.started)
          expect(yield* run(unfinishedChild.runId, "fork-sequence-unfinished-host")).toBe("suffix-4")
          expect(dispatches).toEqual({ sealed: 1, middle: 2, suffix: 4 })

          if (tier === "irreversible") {
            const crossing = yield* irreversibleBoundaryFrame()
            const failure = yield* Effect.flip(forkAt(parentId, crossing))
            expect(failure).toMatchObject({ code: "already_crossed" })
          }
        } finally {
          yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
        }
      }),
    30_000
  )
})
