import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Journal, JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Effect } from "effect"
import * as CopiedRecord from "../src/internal/CopiedRecord.ts"

const conflict = new Journal.JournalError({ code: "idempotency_conflict", message: "occupied producer slot" })
const payload = { runId: "parent", nested: [{ b: 2, a: 1 }] }
const meta = { lineageId: FlowEngine.Lineage.root("parent") }
const entry = (runId: string, overrides: Partial<JournalEvent.Entry> = {}): JournalEvent.Entry => ({
  runId: runId as JournalEvent.RunId,
  seq: 0 as JournalEvent.Seq,
  eventId: `${runId}:0`,
  sourceId: "producer" as JournalEvent.SourceId,
  sourceSeq: 0 as JournalEvent.SourceSeq,
  emittedAtMs: 100,
  eventType: "test.boundary",
  payload,
  meta,
  ...overrides
})
const marker = (child: string, parent: string): JournalEvent.Entry =>
  entry(child, {
    seq: 1 as JournalEvent.Seq,
    sourceSeq: 1 as JournalEvent.SourceSeq,
    sourceId: "flows/time-travel/fork" as JournalEvent.SourceId,
    eventType: "flows.time-travel.fork-created",
    payload: { childRunId: child, parentRunId: parent, forkJournalOffset: 0 }
  })
const attempted: JournalEvent.Input = {
  runId: "child" as JournalEvent.RunId,
  sourceId: "producer" as JournalEvent.SourceId,
  eventType: "test.boundary",
  payload: { nested: [{ a: 1, b: 2 }], runId: "child" },
  meta: { lineageId: FlowEngine.Lineage.root("child") }
}
const fixture = () => ({
  entries: { child: [entry("child"), marker("child", "parent")], parent: [entry("parent")] } as Record<
    string,
    Array<JournalEvent.Entry>
  >,
  parents: { child: "parent", parent: null } as Record<string, string | null>,
  states: {} as Record<string, string>,
  record: { ...attempted },
  missingRun: false,
  missingRuns: new Set<string>()
})
type Fixture = ReturnType<typeof fixture>
const accept = (state: Fixture) =>
  CopiedRecord.accept({
    runId: "child",
    record: state.record,
    conflict,
    journal: Journal.makeNoop({
      entries: ({ runId, after }) =>
        Effect.succeed({
          entries: (state.entries[runId] ?? []).filter((row) => after === undefined || row.seq > after),
          hasMore: false
        })
    }),
    runs: RunStore.makeNoop({
      get: (runId) =>
        state.missingRun || state.missingRuns.has(runId)
          ? Effect.fail(
            new RunStore.RunStoreError({
              code: "not_found_row",
              method: "get",
              message: "ancestor disappeared",
              cause: undefined
            })
          )
          : Effect.succeed({
            runId,
            parentRunId: state.parents[runId] ?? null,
            status: "suspended",
            createdAtMs: 0,
            startedAtMs: null,
            finishedAtMs: null,
            owner: null,
            heartbeatAtMs: null,
            claim: null,
            claimedAtMs: null,
            cancelRequestedAtMs: null,
            stateJson: state.states[runId] ?? "{}"
          })
    })
  })

describe("copied producer record admission", () => {
  it.effect("accepts a verified ancestor record with equivalent nested JSON", () => accept(fixture()))

  const carried = () => {
    const state = fixture()
    state.parents.child = "fork-root"
    state.parents["fork-root"] = "root"
    state.entries["fork-root"] = [marker("fork-root", "root")]
    state.entries.child![1] = {
      ...marker("child", "fork-root"),
      payload: { childRunId: "child", parentRunId: "fork-root", forkJournalOffset: 0, copiedFromRunId: "parent" }
    }
    state.states.child = JSON.stringify({
      version: 1,
      flowName: "example",
      payload: {},
      parentExecutionId: "fork-root",
      forkKeyRunIds: ["parent"]
    })
    state.states.parent = JSON.stringify({ version: 1, flowName: "example", payload: {}, parentExecutionId: "root" })
    return state
  }
  it.effect("accepts a carried child only with its origin and the parent's fork receipt", () => accept(carried()))
  for (
    const [name, change] of [
      ["missing carried origin", (state: Fixture) => {
        state.states.child = JSON.stringify({
          version: 1,
          flowName: "example",
          payload: {},
          parentExecutionId: "fork-root"
        })
      }],
      ["unrelated source parent", (state: Fixture) => {
        state.parents["fork-root"] = "stranger"
      }],
      ["missing parent fork receipt", (state: Fixture) => {
        state.entries["fork-root"] = []
      }],
      ["malformed carried state", (state: Fixture) => {
        state.states.child = "{}"
      }],
      ["invalid carried JSON", (state: Fixture) => {
        state.states.child = "{"
      }],
      ["invalid carried source JSON", (state: Fixture) => {
        state.states.parent = "{"
      }],
      ["disappeared carried source", (state: Fixture) => {
        state.missingRuns.add("parent")
      }],
      ["disappeared carried parent", (state: Fixture) => {
        state.missingRuns.add("fork-root")
      }],
      ["changed carried source", (state: Fixture) => {
        state.entries.parent![0] = entry("parent", { payload: {} })
      }]
    ] as const
  ) {
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function*() {
        const state = carried()
        change(state)
        expect((yield* Effect.flip(accept(state))).code).toBe("idempotency_conflict")
      }))
  }

  const refused: ReadonlyArray<readonly [string, (state: Fixture) => void]> = [
    ["missing run", (state) => {
      state.missingRun = true
    }],
    ["missing cutoff", (state) => {
      state.entries.parent = []
    }],
    ["unrelated cutoff lineage", (state) => {
      state.entries.child![1] = { ...marker("child", "parent"), meta: null }
    }],
    ["changed original timestamp", (state) => {
      state.entries.parent![0] = entry("parent", { emittedAtMs: 101 })
    }],
    ["changed original payload", (state) => {
      state.entries.parent![0] = entry("parent", { payload: {} })
    }],
    ["absent original producer", (state) => {
      state.entries.parent![0] = entry("parent", { sourceId: "other" as JournalEvent.SourceId })
    }],
    ["non-record attempted metadata", (state) => {
      state.record.meta = null
    }],
    // Absent metadata is not the ancestor's metadata, and comparing the two
    // never canonicalizes `undefined`.
    ["absent attempted metadata", (state) => {
      state.record = { ...state.record, meta: undefined }
    }],
    ["cyclic ancestry", (state) => {
      const remote = { lineageId: FlowEngine.Lineage.root("unrelated") }
      state.parents.parent = "child"
      state.entries.child = [entry("child", { meta: remote }), { ...marker("child", "parent"), meta: remote }]
      state.entries.parent = [entry("parent", { meta: remote }), { ...marker("parent", "child"), meta: remote }]
    }]
  ]
  for (const [name, change] of refused) {
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function*() {
        const state = fixture()
        change(state)
        const error = yield* Effect.flip(accept(state))
        expect(error.code).toBe("idempotency_conflict")
        expect(error.message).toBe(conflict.message)
      }))
  }

  it.effect("compares a primitive payload without inventing a run-id field", () => {
    const state = fixture()
    state.record.payload = "immutable"
    state.entries.child![0] = entry("child", { payload: "immutable" })
    state.entries.parent![0] = entry("parent", { payload: "immutable" })
    return accept(state)
  })
})
