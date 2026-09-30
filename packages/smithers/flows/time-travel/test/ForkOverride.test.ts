/**
 * A fork can replace one recorded step result: the child replays the prefix,
 * serves the edited step from its own attempt row, and runs everything after
 * the frame again against the edited value. The parent is untouched.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { DurableEngineState, EngineStore, OwnerIdentity, StepBoundary } from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as TimeTravelJj from "@smthrs/jj"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import * as TimeTravel from "../src/TimeTravel.ts"

const Draft = Action.make("fork-override-draft", {
  payload: {},
  success: Schema.String,
  tier: "irreversible",
  idempotencyKey: "fork-override-draft-v1"
})
const Publish = Action.make("fork-override-publish", {
  payload: { text: Schema.String },
  success: Schema.String,
  tier: "irreversible",
  idempotencyKey: "fork-override-publish-v1"
})
const Pipeline = Flow.make("TimeTravel/ForkOverride", {
  payload: {},
  success: Schema.String,
  body: () => Draft.call({}).pipe(Node.bindPlanned((text) => Publish.call({ text })))
})

const kernelJj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "fork-override" as never, changeId: "fork-override" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const stores = Layer.mergeAll(
  AttemptStore.layer,
  CacheStore.layer,
  RunStore.layer,
  DurableEngineState.layer,
  SqlJournal.layer({ capacity: 64, overflow: "reject" }),
  SqlTimeTravelStore.layer
).pipe(
  Layer.provideMerge(
    Layer.provideMerge(Migrations.layer, Layer.provideMerge(DurableWriter.layer(), TestDatabase.layer))
  )
)

const environment = Layer.mergeAll(
  stores,
  StepBoundary.layerTest(),
  Layer.succeed(FlowEngine.SnapshotBoundary, {
    snapshot: () => Effect.succeed({}),
    restore: () => Effect.void,
    diff: () => Effect.succeed({})
  }),
  OwnerIdentity.layer,
  Layer.succeed(Jj.Jj, kernelJj),
  Layer.succeed(TimeTravelJj.Jj, TimeTravelJj.makeNoop({ workspaceAdd: () => Effect.void }))
).pipe(Layer.provideMerge(NodeCrypto.layer))

/** Runs `runId` to completion under a fresh engine, counting each body. */
const execute = (runId: string, dispatched: Array<string>) =>
  Effect.scoped(Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: `fork-override-${runId}` },
      journalSource: "fork-override",
      isAlive: () => Effect.succeed(false)
    })
    const wiring = Layer.mergeAll(
      Draft.toLayer(() => Effect.sync(() => (dispatched.push("draft"), "original draft"))),
      Publish.toLayer(({ text }) => Effect.sync(() => (dispatched.push("publish"), `published: ${text}`))),
      Interpreter.layer(Pipeline)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
    )
    const value = yield* Pipeline.execute({}, { executionId: runId }).pipe(Effect.provide(wiring))
    yield* (yield* Journal.Journal).flush
    return value
  }))

/** The draft step's digest and the seq its attempt finished at. */
const draftStep = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const events = yield* sql<{ readonly seq: number; readonly event_type: string; readonly payload_json: string }>`
      SELECT seq, event_type, payload_json FROM flows_journal_events
      WHERE run_id = ${runId}
        AND event_type IN ('flows.engine.attempt-started', 'flows.engine.attempt-finished')
      ORDER BY seq
    `
    const digest = (JSON.parse(events[0]!.payload_json) as { stepKeyDigest: string }).stepKeyDigest
    const finished = events.find((row) =>
      row.event_type === "flows.engine.attempt-finished" &&
      (JSON.parse(row.payload_json) as { stepKeyDigest: string }).stepKeyDigest === digest
    )!
    return { digest, frame: { lineageId: FlowEngine.Lineage.root(runId), seq: finished.seq } }
  })

describe("fork with an edited step result", () => {
  it.effect("replays the edited step and runs the steps after it again", () =>
    Effect.gen(function*() {
      const dispatched: Array<string> = []
      expect(yield* execute("parent", dispatched)).toBe("published: original draft")
      const { digest, frame } = yield* draftStep("parent")
      const timeTravel = yield* TimeTravel.TimeTravel
      const fork = yield* timeTravel.fork({ runId: "parent", frame }, {
        override: { stepKeyDigest: digest, result: "edited draft" }
      })
      expect(yield* execute(fork.runId, dispatched)).toBe("published: edited draft")
      // The draft replayed from the edited row; only the publish ran again.
      expect(dispatched).toEqual(["draft", "publish", "publish"])
      const attempts = yield* AttemptStore.AttemptStore
      const parent = yield* attempts.get({ runId: "parent", stepKeyDigest: digest, attempt: 1 })
      expect(parent._tag === "Some" && parent.value.outcome).toBe("original draft")
    }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(environment))), Effect.scoped))

  it.effect("fails the child at the edited step when its schema refuses the value", () =>
    Effect.gen(function*() {
      const dispatched: Array<string> = []
      yield* execute("parent", dispatched)
      const { digest, frame } = yield* draftStep("parent")
      const fork = yield* (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, {
        override: { stepKeyDigest: digest, result: { not: "a string" } }
      })
      const exit = yield* Effect.exit(execute(fork.runId, dispatched))
      expect(exit._tag).toBe("Failure")
      expect(dispatched).toEqual(["draft", "publish"])
    }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(environment))), Effect.scoped))

  it.effect("refuses an unknown step before minting a child or provisioning a lane", () =>
    Effect.gen(function*() {
      yield* execute("parent", [])
      const { frame } = yield* draftStep("parent")
      const failure = yield* Effect.flip((yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, {
        override: { stepKeyDigest: "missing-step", result: "edited" }
      }))
      expect(failure.code).toBe("not_found")
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT 1 FROM flows_time_travel_fork_intents`).toEqual([])
      expect(yield* sql`SELECT 1 FROM flows_runs WHERE parent_run_id = 'parent'`).toEqual([])
    }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(environment))), Effect.scoped))

  it.effect("refuses a step admitted but not succeeded at the frame, committing nothing", () =>
    Effect.gen(function*() {
      yield* execute("parent", [])
      const { digest } = yield* draftStep("parent")
      const sql = yield* SqlClient.SqlClient
      const started = yield* sql<{ readonly seq: number }>`
        SELECT seq FROM flows_journal_events
        WHERE run_id = 'parent' AND event_type = 'flows.engine.attempt-started' ORDER BY seq LIMIT 1`
      // Cut at the attempt's start: admitted there, finished only later.
      const frame = { lineageId: FlowEngine.Lineage.root("parent"), seq: started[0]!.seq }
      const failure = yield* Effect.flip((yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, {
        override: { stepKeyDigest: digest, result: "edited" }
      }))
      expect(failure.code).toBe("not_found")
      expect(failure.message).toContain("has no successful attempt finished")
      expect(yield* sql`SELECT 1 FROM flows_runs WHERE parent_run_id = 'parent'`).toEqual([])
    }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(environment))), Effect.scoped))

  it.effect("refuses a step the shared step cache would serve instead of the edit", () =>
    Effect.gen(function*() {
      yield* execute("parent", [])
      const { digest, frame } = yield* draftStep("parent")
      yield* (yield* CacheStore.CacheStore).put({
        keyDigest: digest,
        result: "cached draft",
        meta: {},
        createdAtMs: 0,
        recordedRunId: "parent",
        recordedEventSeq: 1
      })
      const failure = yield* Effect.flip((yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, {
        override: { stepKeyDigest: digest, result: "edited" }
      }))
      expect(failure.code).toBe("invalid")
      expect(failure.message).toContain("shared step cache")
    }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(environment))), Effect.scoped))

  it.effect("reports a step cache it cannot read instead of forking past it", () =>
    Effect.gen(function*() {
      yield* execute("parent", [])
      const { digest, frame } = yield* draftStep("parent")
      const failure = yield* Effect.flip(
        Effect.flatMap(TimeTravel.TimeTravel, (timeTravel) =>
          timeTravel.fork({ runId: "parent", frame }, { override: { stepKeyDigest: digest, result: "edited" } })).pipe(
            // A store whose reads all fail: the fork cannot prove the cache
            // would not serve the step ahead of the edit.
            Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provide(CacheStore.layerNoop()))),
            Effect.scoped
          )
      )
      expect(failure.code).toBe("unknown")
      expect(failure.message).toBe("could not read the step cache")
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT 1 FROM flows_runs WHERE parent_run_id = 'parent'`).toEqual([])
    }).pipe(Effect.provide(environment), Effect.scoped))

  it.effect("refuses a malformed override from an untyped caller", () =>
    Effect.gen(function*() {
      yield* execute("parent", [])
      const { frame } = yield* draftStep("parent")
      const failure = yield* Effect.flip((yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, {
        override: { stepKeyDigest: "", result: "edited" }
      }))
      expect(failure.code).toBe("invalid")
    }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(environment))), Effect.scoped))

  it.effect("the memory store holds no step result to edit", () =>
    Effect.gen(function*() {
      const store = Memory.make({ records: [{ runId: "r", seq: 0, eventId: "a", lineageId: "r", payload: null }] })
      const failure = yield* Effect.flip(
        store.createFork("r", { lineageId: "r", seq: 0 }, undefined, { stepKeyDigest: "d", result: "x" })
      )
      expect(failure.code).toBe("not_found")
      expect(store.state().records.filter((record) => record.runId !== "r")).toEqual([])
    }))
})
