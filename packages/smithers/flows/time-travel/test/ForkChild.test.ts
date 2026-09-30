/**
 * A fork carries the child executions its parent spawned: a step recorded in
 * a spawned child replays on the fork, and can be edited there, while the
 * parent's child keeps its own rows.
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
import * as TimeTravelStore from "../src/TimeTravelStore.ts"

const Draft = Action.make("fork-child-draft", {
  payload: {},
  success: Schema.String,
  tier: "irreversible",
  idempotencyKey: "fork-child-draft-v1"
})
const Publish = Action.make("fork-child-publish", {
  payload: { text: Schema.String },
  success: Schema.String,
  tier: "irreversible",
  idempotencyKey: "fork-child-publish-v1"
})
const Inner = Flow.make("TimeTravel/ForkChild/Inner", {
  payload: {},
  success: Schema.String,
  body: () => Draft.call({}).pipe(Node.bindPlanned((text) => Publish.call({ text })))
})
const Outer = Flow.make("TimeTravel/ForkChild/Outer", {
  payload: {},
  success: Schema.String,
  body: () => Inner.child({}).pipe(Node.map((value) => `outer: ${value}`))
})
/** The node id the boundary in `Outer`'s body is recorded under. */
const boundary = "root.flow.map"
const childOf = (parentRunId: string) =>
  Interpreter.childExecutionId(parentRunId, boundary, Inner._tag, {}).pipe(Effect.provide(NodeCrypto.layer))

const kernelJj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "fork-child" as never, changeId: "fork-child" as never }),
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
      owner: { hostId: `fork-child-${runId}` },
      journalSource: "fork-child",
      isAlive: () => Effect.succeed(false)
    })
    const wiring = Layer.mergeAll(
      Draft.toLayer(() => Effect.sync(() => (dispatched.push("draft"), "original draft"))),
      Publish.toLayer(({ text }) => Effect.sync(() => (dispatched.push("publish"), `published: ${text}`))),
      Interpreter.layer(Inner),
      Interpreter.layer(Outer)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
    )
    const value = yield* Outer.execute({}, { executionId: runId }).pipe(Effect.provide(wiring))
    yield* (yield* Journal.Journal).flush
    return value
  }))

/** The parent's last frame and the draft step its spawned child recorded. */
const recorded = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const child = yield* childOf(runId)
    const draft = yield* sql<{ readonly step_key_digest: string }>`
      SELECT step_key_digest FROM flows_attempts WHERE run_id = ${child} AND outcome_json = ${
      JSON.stringify("original draft")
    }`
    const last = yield* sql<{ readonly seq: number }>`
      SELECT MAX(seq) AS seq FROM flows_journal_events WHERE run_id = ${runId}`
    const spawn = yield* sql<{ readonly seq: number }>`
      SELECT seq FROM flows_journal_events WHERE run_id = ${runId} AND event_type = 'flows.time-travel.effect-boundary'`
    return {
      child,
      digest: draft[0]!.step_key_digest,
      frame: { lineageId: FlowEngine.Lineage.root(runId), seq: Number(last[0]!.seq) },
      spawnSeq: Number(spawn[0]!.seq)
    }
  })

const carry = (from: string) => (childRunId: string) =>
  Effect.map(childOf(childRunId), (to) => ({ children: [{ from, to }] }))

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(environment))), Effect.scoped)

describe("fork carrying a spawned child", () => {
  it.effect("replays the child's recorded steps under the id the forked parent opens it with", () =>
    provided(Effect.gen(function*() {
      const dispatched: Array<string> = []
      expect(yield* execute("parent", dispatched)).toBe("outer: published: original draft")
      const { child, frame } = yield* recorded("parent")
      const fork = yield* (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, { rebind: carry(child) })
      expect(yield* execute(fork.runId, dispatched)).toBe("outer: published: original draft")
      // Nothing ran again: both of the child's steps replayed on the fork.
      expect(dispatched).toEqual(["draft", "publish"])
      const sql = yield* SqlClient.SqlClient
      const carried = yield* childOf(fork.runId)
      const row = yield* sql<
        { readonly state_json: string }
      >`SELECT state_json FROM flows_runs WHERE run_id = ${carried}`
      expect(JSON.parse(row[0]!.state_json)).toMatchObject({ parentExecutionId: fork.runId, forkKeyRunIds: [child] })
      const parents = yield* sql`SELECT parent_id FROM flows_run_parents WHERE child_id = ${carried}`
      expect(parents).toEqual([{ parent_id: fork.runId }])
    })))

  it.effect("edits a step the spawned child recorded, leaving the parent's child alone", () =>
    provided(Effect.gen(function*() {
      const dispatched: Array<string> = []
      yield* execute("parent", dispatched)
      const { child, digest, frame } = yield* recorded("parent")
      const fork = yield* (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, {
        override: { stepKeyDigest: digest, result: "edited draft" },
        rebind: carry(child)
      })
      expect(yield* execute(fork.runId, dispatched)).toBe("outer: published: edited draft")
      expect(dispatched).toEqual(["draft", "publish", "publish"])
      const attempts = yield* AttemptStore.AttemptStore
      const original = yield* attempts.get({ runId: child, stepKeyDigest: digest, attempt: 1 })
      expect(original._tag === "Some" && original.value.outcome).toBe("original draft")
    })))

  it.effect("without a carried child the forked parent runs its child again", () =>
    provided(Effect.gen(function*() {
      const dispatched: Array<string> = []
      yield* execute("parent", dispatched)
      const { frame } = yield* recorded("parent")
      const fork = yield* (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame })
      yield* execute(fork.runId, dispatched)
      expect(dispatched).toEqual(["draft", "publish", "draft", "publish"])
    })))

  it.effect("does not carry a child spawned after the frame", () =>
    provided(Effect.gen(function*() {
      const dispatched: Array<string> = []
      yield* execute("parent", dispatched)
      const { child, spawnSeq } = yield* recorded("parent")
      const frame = { lineageId: FlowEngine.Lineage.root("parent"), seq: spawnSeq - 1 }
      const fork = yield* (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, { rebind: carry(child) })
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT 1 FROM flows_runs WHERE run_id = ${yield* childOf(fork.runId)}`).toEqual([])
      yield* execute(fork.runId, dispatched)
      expect(dispatched).toEqual(["draft", "publish", "draft", "publish"])
    })))

  it.effect("refuses a run the parent never spawned and an edit no carried step finished", () =>
    provided(Effect.gen(function*() {
      yield* execute("parent", [])
      yield* execute("stranger", [])
      const { frame } = yield* recorded("parent")
      const stranger = yield* childOf("stranger")
      const timeTravel = yield* TimeTravel.TimeTravel
      const refused = yield* Effect.flip(timeTravel.fork({ runId: "parent", frame }, { rebind: carry(stranger) }))
      expect(refused.code).toBe("invalid")
      const { child } = yield* recorded("parent")
      const missing = yield* Effect.flip(timeTravel.fork({ runId: "parent", frame }, {
        override: { stepKeyDigest: "missing-step", result: "edited" },
        rebind: carry(child)
      }))
      expect(missing.code).toBe("not_found")
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT 1 FROM flows_runs WHERE parent_run_id = 'parent'`).toEqual([])
    })))

  it.effect("replaces the forked root's recorded payload", () =>
    provided(Effect.gen(function*() {
      yield* execute("parent", [])
      const { frame } = yield* recorded("parent")
      const fork = yield* (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, {
        rebind: (childRunId) => Effect.succeed({ payload: { edited: childRunId } })
      })
      const sql = yield* SqlClient.SqlClient
      const row = yield* sql<
        { readonly state_json: string }
      >`SELECT state_json FROM flows_runs WHERE run_id = ${fork.runId}`
      expect(JSON.parse(row[0]!.state_json).payload).toEqual({ edited: fork.runId })
    })))
})

describe("fork carrying a spawned child, across forks and rewinds", () => {
  it.effect("carries a carried child again when the fork is forked", () =>
    provided(Effect.gen(function*() {
      const dispatched: Array<string> = []
      yield* execute("parent", dispatched)
      const { child, frame } = yield* recorded("parent")
      const timeTravel = yield* TimeTravel.TimeTravel
      const first = yield* timeTravel.fork({ runId: "parent", frame }, { rebind: carry(child) })
      expect(yield* execute(first.runId, dispatched)).toBe("outer: published: original draft")
      const sql = yield* SqlClient.SqlClient
      const last = yield* sql<{ readonly seq: number; readonly meta_json: string }>`
        SELECT seq, meta_json FROM flows_journal_events WHERE run_id = ${first.runId} ORDER BY seq DESC LIMIT 1`
      const lineageId = (JSON.parse(last[0]!.meta_json) as { lineageId: string }).lineageId
      const second = yield* timeTravel.fork(
        { runId: first.runId, frame: { lineageId, seq: Number(last[0]!.seq) } },
        { rebind: carry(yield* childOf(first.runId)) }
      )
      expect(yield* execute(second.runId, dispatched)).toBe("outer: published: original draft")
      expect(dispatched).toEqual(["draft", "publish"])
      const carried = yield* sql<{ readonly parent_run_id: string }>`
        SELECT parent_run_id FROM flows_runs WHERE run_id = ${yield* childOf(second.runId)}`
      expect(carried).toEqual([{ parent_run_id: second.runId }])
    })))

  it.effect("keeps a rebound payload when the fork's state is rebuilt at a copied frame", () =>
    provided(Effect.gen(function*() {
      yield* execute("parent", [])
      const { frame } = yield* recorded("parent")
      const fork = yield* (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, {
        rebind: () => Effect.succeed({ payload: { edited: true } })
      })
      const state = yield* (yield* TimeTravelStore.TimeTravelStore).stateAt(fork.runId, { ...frame, seq: 1 })
      expect(JSON.parse(state!).payload).toEqual({ edited: true })
    })))

  it.effect("carries nothing written in the frame's millisecond unless the frame is the parent's last record", () =>
    provided(Effect.gen(function*() {
      const dispatched: Array<string> = []
      yield* execute("parent", dispatched)
      const { child, frame } = yield* recorded("parent")
      // Every record of this test is written at the test clock's zero.
      const earlier = { ...frame, seq: frame.seq - 1 }
      const fork = yield* (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame: earlier }, {
        rebind: carry(child)
      })
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT 1 FROM flows_attempts WHERE run_id = ${yield* childOf(fork.runId)}`).toEqual([])
    })))

  it.effect("refuses a carried child whose irreversible step crossed its boundary without finishing", () =>
    provided(Effect.gen(function*() {
      yield* execute("parent", [])
      const { child, frame } = yield* recorded("parent")
      const sql = yield* SqlClient.SqlClient
      // The publish crossed its boundary; its completion never reached the journal.
      yield* sql`
        DELETE FROM flows_journal_events
        WHERE run_id = ${child} AND event_type = 'flows.engine.attempt-finished'
          AND seq = (SELECT MAX(seq) FROM flows_journal_events
                     WHERE run_id = ${child} AND event_type = 'flows.engine.attempt-finished')`
      const failure = yield* Effect.flip(
        (yield* TimeTravel.TimeTravel).fork({ runId: "parent", frame }, { rebind: carry(child) })
      )
      expect(failure.code).toBe("already_crossed")
      expect(yield* sql`SELECT 1 FROM flows_runs WHERE parent_run_id = 'parent'`).toEqual([])
    })))
})

describe("the memory store carrying a spawned child", () => {
  const seeded = () =>
    Memory.make({
      records: [
        { runId: "p", seq: 0, eventId: "p0", lineageId: "p", payload: null, emittedAtMs: 1 },
        { runId: "p", seq: 1, eventId: "p1", lineageId: "p", payload: null, emittedAtMs: 5 },
        { runId: "c", seq: 0, eventId: "c0", lineageId: "c", payload: null, emittedAtMs: 2 },
        { runId: "c", seq: 1, eventId: "c1", lineageId: "c", payload: null, emittedAtMs: 9 }
      ],
      edges: [{ parentRunId: "p", parentSeq: 0, childRunId: "c", kind: "child", attached: false }]
    })

  it.effect("copies the child's records written by the frame and links it to the fork", () =>
    Effect.gen(function*() {
      const store = seeded()
      const fork = yield* store.createFork("p", { lineageId: "p", seq: 1 }, "f", undefined, {
        children: [{ from: "c", to: "c2" }]
      })
      expect(fork.runId).toBe("f")
      expect(store.state().records.filter((record) => record.runId === "c2").map((record) => record.seq)).toEqual([0])
      expect(store.state().edges).toContainEqual({
        parentRunId: "f",
        parentSeq: 0,
        childRunId: "c2",
        kind: "child",
        attached: false
      })
    }))

  it.effect("skips a child spawned after the frame and refuses a stranger", () =>
    Effect.gen(function*() {
      const late = Memory.make({
        records: [{ runId: "p", seq: 0, eventId: "p0", lineageId: "p", payload: null }],
        edges: [{ parentRunId: "p", parentSeq: 1, childRunId: "c", kind: "child", attached: false }]
      })
      yield* late.createFork("p", { lineageId: "p", seq: 0 }, "f", undefined, { children: [{ from: "c", to: "c2" }] })
      expect(late.state().records.some((record) => record.runId === "c2")).toBe(false)
      const failure = yield* Effect.flip(
        seeded().createFork("p", { lineageId: "p", seq: 1 }, "f", undefined, { children: [{ from: "x", to: "y" }] })
      )
      expect(failure.code).toBe("invalid")
    }))
})
