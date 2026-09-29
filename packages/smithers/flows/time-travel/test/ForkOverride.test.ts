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
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import * as TimeTravel from "../src/TimeTravel.ts"

const Produce = Action.make("fork-override-produce", {
  payload: { seed: Schema.Number },
  success: Schema.Number,
  tier: "sealed"
})
const Consume = Action.make("fork-override-consume", {
  payload: { value: Schema.Number },
  success: Schema.String,
  tier: "sealed"
})
const OverrideFlow = Flow.make("TimeTravel/ForkOverride", {
  payload: { seed: Schema.Number },
  success: Schema.String,
  body: ({ seed }) => Produce.call({ seed }).pipe(Node.bindPlanned((value) => Consume.call({ value })))
})

const parentId = "fork-override-parent"

const harness = Effect.gen(function*() {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "flows-fork-override-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
  )
  const filename = join(directory, "fork.sqlite")
  const dispatches = { produce: 0, consume: 0 }
  const workspaces: Array<string> = []
  const jj = Jj.make({
    snapshot: () => Effect.succeed({ commitId: "fork-override" as never, changeId: "fork-override" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: (name) => Effect.sync(() => void workspaces.push(name)),
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
  const requirements = () => {
    const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
    return Layer.mergeAll(
      Layer.provideMerge(
        Layer.mergeAll(
          AttemptStore.layer,
          CacheStore.layer,
          RunStore.layer,
          DurableEngineState.layer,
          SqlJournal.layer({ capacity: 64, overflow: "reject" })
        ),
        Layer.provideMerge(Migrations.layer, database)
      ),
      StepBoundary.layerTest(),
      Layer.succeed(FlowEngine.SnapshotBoundary, {
        snapshot: () => Effect.succeed({}),
        restore: () => Effect.void,
        diff: () => Effect.succeed({})
      }),
      OwnerIdentity.layer,
      Layer.succeed(Jj.Jj, jj)
    ).pipe(Layer.provideMerge(NodeCrypto.layer))
  }
  const run = (runId: string, seed: number) =>
    Effect.scoped(
      Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: `host-${runId}` },
          journalSource: "fork-override",
          isAlive: () => Effect.succeed(false)
        })
        const value = yield* OverrideFlow.execute({ seed }, { executionId: runId }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Produce.toLayer(({ seed }) => Effect.sync(() => (dispatches.produce++, seed * 10))),
              Consume.toLayer(({ value }) => Effect.sync(() => (dispatches.consume++, `consumed-${value}`))),
              Interpreter.layer(OverrideFlow)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
            )
          )
        )
        yield* (yield* Journal.Journal).flush
        return value
      }).pipe(Effect.provide(requirements()))
    )
  const withSql = <A, E>(body: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
    Effect.scoped(
      Effect.flatMap(Effect.service(SqlClient.SqlClient), body).pipe(Effect.provide(requirements()))
    )
  const fork = (options: TimeTravel.ForkOptions, seq: number) =>
    Effect.scoped(
      Effect.gen(function*() {
        const timeTravel = yield* TimeTravel.TimeTravel
        return yield* timeTravel.fork(
          { runId: parentId, frame: { lineageId: FlowEngine.Lineage.root(parentId), seq } },
          { workspaceRoot: directory, ...options }
        )
      }).pipe(
        Effect.provide(
          TimeTravel.layer.pipe(Layer.provideMerge(SqlTimeTravelStore.layer), Layer.provideMerge(requirements()))
        )
      )
    )
  /** The step key digest and finish frame of the parent's first dispatch. */
  const produced = withSql((sql) =>
    Effect.gen(function*() {
      const rows = yield* sql<{ readonly seq: number; readonly event_type: string; readonly payload_json: string }>`
        SELECT seq, event_type, payload_json FROM flows_journal_events
        WHERE run_id = ${parentId}
          AND event_type IN ('flows.engine.attempt-started', 'flows.engine.attempt-finished')
        ORDER BY seq
      `
      const digest = (JSON.parse(rows[0]!.payload_json) as { stepKeyDigest: string }).stepKeyDigest
      const finished = rows.find((row) =>
        row.event_type === "flows.engine.attempt-finished" &&
        (JSON.parse(row.payload_json) as { stepKeyDigest: string }).stepKeyDigest === digest
      )!
      return { digest, frame: finished.seq }
    })
  )
  const runCount = withSql((sql) =>
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM flows_runs`.pipe(
      Effect.map((rows) => Number(rows[0]!.count))
    )
  )
  return { run, fork, produced, runCount, withSql, dispatches, workspaces }
})

describe("fork override", () => {
  it.live(
    "replays an edited sealed result and never publishes it to the step cache",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const h = yield* harness
        expect(yield* h.run(parentId, 1)).toBe("consumed-10")
        const { digest, frame } = yield* h.produced
        const child = yield* h.fork({ override: { stepKey: digest, schema: Schema.Number, sealedResult: 42 } }, frame)

        expect(yield* h.run(child.runId, 1)).toBe("consumed-42")
        expect(h.dispatches).toEqual({ produce: 1, consume: 2 })
        const rows = yield* h.withSql((sql) =>
          sql<{ readonly run_id: string; readonly outcome_json: string; readonly meta_json: string }>`
          SELECT run_id, outcome_json, meta_json FROM flows_attempts WHERE step_key_digest = ${digest} ORDER BY run_id
        `
        )
        const parentRow = rows.find((row) => row.run_id === parentId)!
        const childRow = rows.find((row) => row.run_id === child.runId)!
        expect(JSON.parse(parentRow.outcome_json)).toBe(10)
        expect(JSON.parse(childRow.outcome_json)).toBe(42)
        expect(JSON.parse(childRow.meta_json)).not.toHaveProperty("readSetVerified")
        const cached = yield* h.withSql((sql) =>
          sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM flows_step_cache_recorded WHERE recorded_run_id = ${child.runId}
        `
        )
        expect(Number(cached[0]!.count)).toBe(0)
        const marker = yield* h.withSql((sql) =>
          sql<{ readonly seq: number; readonly payload_json: string }>`
          SELECT seq, payload_json FROM flows_journal_events
          WHERE run_id = ${child.runId} AND event_type = 'flows.time-travel.fork-overridden'
        `
        )
        expect(marker.map((row) => ({ seq: row.seq, payload: JSON.parse(row.payload_json) }))).toEqual([
          { seq: frame + 2, payload: { childRunId: child.runId, _tag: "SealedResult", stepKeyDigest: digest } }
        ])
      })),
    30_000
  )

  it.live("restarts the child with an edited root input", () =>
    Effect.scoped(Effect.gen(function*() {
      const h = yield* harness
      expect(yield* h.run(parentId, 1)).toBe("consumed-10")
      const child = yield* h.fork({ override: { schema: OverrideFlow.payloadSchema, input: { seed: 2 } } }, 0)

      expect(yield* h.run(child.runId, 2)).toBe("consumed-20")
      expect(h.dispatches).toEqual({ produce: 2, consume: 2 })
      const marker = yield* h.withSql((sql) =>
        sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM flows_journal_events
          WHERE run_id = ${child.runId} AND event_type = 'flows.time-travel.fork-overridden'
        `
      )
      expect(marker.map((row) => JSON.parse(row.payload_json))).toEqual([{ childRunId: child.runId, _tag: "Input" }])
    })), 30_000)

  it.live.each([
    {
      name: "a sealed result the step schema refuses",
      code: "invalid",
      override: (digest: string): TimeTravel.ForkOverride => ({
        stepKey: digest,
        schema: Schema.Number,
        sealedResult: "not-a-number" as unknown as number
      })
    },
    {
      name: "an input the payload schema refuses",
      code: "invalid",
      override: (): TimeTravel.ForkOverride => ({
        schema: OverrideFlow.payloadSchema,
        input: { seed: "two" } as unknown as { seed: number }
      })
    },
    {
      name: "a step key that is not a digest",
      code: "invalid",
      override: (): TimeTravel.ForkOverride => ({ stepKey: "", schema: Schema.Number, sealedResult: 1 })
    },
    {
      name: "an input once a step has started",
      code: "invalid",
      override: (): TimeTravel.ForkOverride => ({ schema: OverrideFlow.payloadSchema, input: { seed: 2 } })
    },
    {
      name: "a step that never ran before the frame",
      code: "not_found",
      override: (): TimeTravel.ForkOverride => ({ stepKey: "missing-step", schema: Schema.Number, sealedResult: 1 })
    }
  ])("refuses $name before allocating a child", ({ code, override }) =>
    Effect.scoped(Effect.gen(function*() {
      const h = yield* harness
      yield* h.run(parentId, 1)
      const { digest, frame } = yield* h.produced
      const before = yield* h.runCount

      const failure = yield* Effect.flip(h.fork({ override: override(digest) }, frame))

      expect(failure).toMatchObject({ code })
      expect(yield* h.runCount).toBe(before)
      expect(h.workspaces).toEqual([])
    })), 30_000)

  it.live(
    "refuses a sealed result a later step may already have read, leaving no child",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const h = yield* harness
        yield* h.run(parentId, 1)
        const { digest } = yield* h.produced
        const latest = yield* h.withSql((sql) =>
          sql<{ readonly seq: number }>`SELECT MAX(seq) AS seq FROM flows_journal_events WHERE run_id = ${parentId}`
        )
        const before = yield* h.runCount

        const failure = yield* Effect.flip(
          h.fork({ override: { stepKey: digest, schema: Schema.Number, sealedResult: 42 } }, latest[0]!.seq)
        )

        expect(failure).toMatchObject({ code: "invalid" })
        expect(failure.message).toContain("was followed by a step")
        expect(yield* h.runCount).toBe(before)
        expect(h.dispatches).toEqual({ produce: 1, consume: 1 })
      })),
    30_000
  )

  it.live(
    "refuses a finished step whose attempt row is missing, leaving no child",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const h = yield* harness
        yield* h.run(parentId, 1)
        const { digest, frame } = yield* h.produced
        yield* h.withSql((sql) =>
          sql`DELETE FROM flows_attempts WHERE run_id = ${parentId} AND step_key_digest = ${digest}`
        )
        const before = yield* h.runCount

        const failure = yield* Effect.flip(
          h.fork({ override: { stepKey: digest, schema: Schema.Number, sealedResult: 1 } }, frame)
        )

        expect(failure).toMatchObject({ code: "not_found" })
        expect(yield* h.runCount).toBe(before)
      })),
    30_000
  )

  it.live(
    "refuses a step whose attempt only started at the frame, leaving no child",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const h = yield* harness
        yield* h.run(parentId, 1)
        const { digest } = yield* h.produced
        const started = yield* h.withSql((sql) =>
          sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events
          WHERE run_id = ${parentId} AND event_type = 'flows.engine.attempt-started'
          ORDER BY seq LIMIT 1
        `
        )
        const before = yield* h.runCount

        const failure = yield* Effect.flip(
          h.fork({ override: { stepKey: digest, schema: Schema.Number, sealedResult: 1 } }, started[0]!.seq)
        )

        expect(failure).toMatchObject({ code: "not_found" })
        expect(yield* h.runCount).toBe(before)
      })),
    30_000
  )
})

describe("MemoryTimeTravelStore fork override", () => {
  const records = [
    {
      runId: "r",
      seq: 1,
      eventId: "s",
      lineageId: "r",
      eventType: "flows.engine.attempt-started",
      payload: { stepKeyDigest: "d", attempt: 1 }
    },
    {
      runId: "r",
      seq: 2,
      eventId: "f",
      lineageId: "r",
      eventType: "flows.engine.attempt-finished",
      payload: { stepKeyDigest: "d", attempt: 1, state: "succeeded" }
    }
  ]

  it.effect("records the override above the fork-created marker", () =>
    Effect.gen(function*() {
      const store = Memory.make({ records })
      const fork = yield* store.createFork("r", { lineageId: "r", seq: 2 }, undefined, {
        _tag: "SealedResult",
        stepKeyDigest: "d",
        outcome: 3
      })
      const marker = store.state().records.find((record) =>
        record.runId === fork.runId && record.eventType === "flows.time-travel.fork-overridden"
      )
      expect(marker).toMatchObject({
        seq: 4,
        payload: { childRunId: fork.runId, _tag: "SealedResult", stepKeyDigest: "d" }
      })
    }))

  it.effect("refuses an input override after a step started, and a result a later step followed", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [
          ...records,
          {
            runId: "r",
            seq: 3,
            eventId: "later",
            lineageId: "r",
            eventType: "flows.engine.attempt-started",
            payload: null
          }
        ]
      })
      const input = yield* Effect.flip(
        store.createFork("r", { lineageId: "r", seq: 1 }, undefined, { _tag: "Input", payload: {} })
      )
      const later = yield* Effect.flip(
        store.createFork("r", { lineageId: "r", seq: 3 }, undefined, {
          _tag: "SealedResult",
          stepKeyDigest: "d",
          outcome: 3
        })
      )
      const admitted = yield* store.createFork("r", { lineageId: "r", seq: 2 }, undefined, {
        _tag: "SealedResult",
        stepKeyDigest: "d",
        outcome: 3
      })
      expect([input.code, later.code]).toEqual(["invalid", "invalid"])
      expect(store.state().edges.map((edge) => edge.childRunId)).toEqual([admitted.runId])
    }))

  it.effect("refuses a sealed result the frame never finished", () =>
    Effect.gen(function*() {
      const store = Memory.make({ records })
      const failure = yield* Effect.flip(
        store.createFork("r", { lineageId: "r", seq: 1 }, undefined, {
          _tag: "SealedResult",
          stepKeyDigest: "d",
          outcome: 3
        })
      )
      expect(failure).toMatchObject({ code: "not_found" })
      expect(store.state().records.every((record) => record.runId === "r")).toBe(true)
    }))
})
