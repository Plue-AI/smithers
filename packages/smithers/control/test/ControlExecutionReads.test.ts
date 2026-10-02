/** #3412: exact execution observations cross the public control read boundary. */
import { ExecutionFact } from "@smthrs/journal"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ApprovalAuthority from "../src/ApprovalAuthority.ts"
import { Control } from "../src/Control.ts"
import { InvalidInput, PersistenceError, RunNotFound } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import type { ExecutionBatch, Principal } from "../src/ControlSchema.ts"
import { live, memoryRuntime } from "./TestStack.ts"

const alice: Principal = { id: "alice", kind: "test", stampedAt: 1 }
const bob: Principal = { id: "bob", kind: "test", stampedAt: 2 }
const runtime = () =>
  memoryRuntime({
    principal: alice,
    approvalAuthority: Effect.runSync(ApprovalAuthority.make([{
      principal: { id: alice.id, kind: alice.kind }, scopes: ["once"], targets: ["Plan"]
    }])),
    flows: [{
      flowId: "read-test",
      description: "Execution read boundary",
      deployClass: false,
      envelope: { capabilities: [], flows: [], budget: {} }
    }]
  })
const start = Effect.gen(function*() {
  const control = yield* Control
  const plan = yield* control.plan({ flowId: "read-test", input: {} })
  yield* control.approve({ ...plan.approval, principal: alice, scope: "once" })
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: plan.planId,
    digest: plan.digest,
    envelope: plan.envelope,
    idempotencyKey: "execution-read-run"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("run was not admitted")
  return receipt.runId
})
const unavailable = (executionIds: ReadonlyArray<string>): ExecutionBatch => ({
  source: null,
  revision: null,
  snapshots: executionIds.map((executionId) => ({ _tag: "Unavailable", executionId, reason: "unsupported" }))
})

// The observer is the one replaced collaborator: these contract tests must
// count calls at the security boundary before any native storage is accessed.
const listing = (executionIds: ReadonlyArray<string>) => {
  const batch = unavailable(executionIds)
  return { _tag: "executions", source: batch.source, revision: batch.revision, items: batch.snapshots }
}

describe("public execution read authorization", () => {
  it("refuses another principal, missing roots and plan partitions before invoking the observer", async () => {
    const asked: Array<string> = []
    const executor = {
      ...ControlExecutor.makeNoop(),
      readExecutions: (input: {
        readonly runId: string
        readonly executionIds: ReadonlyArray<string>
      }) =>
        Effect.sync(() => {
          asked.push(input.runId)
          return unavailable(input.executionIds)
        })
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runId = yield* start
        for (const root of [runId, "missing-root", "plan:private-plan"]) {
          const error = yield* control.list({
            _tag: "executions",
            runId: root,
            executionIds: ["native-id"],
            reader: bob
          })
            .pipe(Effect.flip)
          expect(error).toBeInstanceOf(RunNotFound)
        }
        expect(asked).toEqual([])
        const own = yield* control.list({ _tag: "executions", runId, executionIds: ["native-id"], reader: alice })
        expect(own).toEqual(listing(["native-id"]))
        const operator = yield* control.list({ _tag: "executions", runId, executionIds: ["operator-id"] })
        expect(operator).toEqual(listing(["operator-id"]))
        expect(asked).toEqual([runId, runId])
        const unknown = yield* control.list({ _tag: "executions", runId: "missing-root", executionIds: [] })
          .pipe(Effect.flip)
        expect(unknown).toBeInstanceOf(RunNotFound)
        expect(asked).toHaveLength(2)
      }).pipe(Effect.provide(live({ runtime: runtime(), executor })), Effect.scoped)
    )
  })

  it("accepts empty and 200-ID reads, preserves duplicates, and rejects invalid IDs before observation", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const executor = {
      ...ControlExecutor.makeNoop(),
      readExecutions: (input: {
        readonly executionIds: ReadonlyArray<string>
      }) =>
        Effect.sync(() => {
          asked.push(input.executionIds)
          return unavailable(input.executionIds)
        })
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runId = yield* start
        const ids = Array.from({ length: 200 }, (_, index) => `native-${index}`)
        for (const executionIds of [[], ids, ["same", "same"]]) {
          expect(yield* control.list({ _tag: "executions", runId, executionIds, reader: alice }))
            .toEqual(listing(executionIds))
        }
        expect(asked).toEqual([[], ids, ["same", "same"]])
        for (const executionIds of [[...ids, "overflow"], [""]]) {
          const error = yield* control.list({ _tag: "executions", runId, executionIds, reader: alice }).pipe(
            Effect.flip
          )
          expect(error).toBeInstanceOf(InvalidInput)
        }
        expect(asked).toHaveLength(3)
      }).pipe(Effect.provide(live({ runtime: runtime(), executor })), Effect.scoped)
    )
  })

  it.each(["absent", "unsupported"] as const)(
    "reports unavailable evidence when its native adapter is %s",
    async (mode) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const runId = yield* start
          const executionIds = [runId, "unknown-child", runId]
          expect(yield* control.list({ _tag: "executions", runId, executionIds, reader: alice }))
            .toEqual(listing(executionIds))
        }).pipe(
          Effect.provide(live({
            runtime: runtime(),
            executor: mode === "absent" ? "absent" : ControlExecutor.makeNoop()
          })),
          Effect.scoped
        )
      )
    }
  )

  it("preserves a native observation failure instead of claiming a lifecycle", async () => {
    const failure = new PersistenceError({ operation: "exact native read", message: "read unavailable" })
    const executor = { ...ControlExecutor.makeNoop(), readExecutions: () => Effect.fail(failure) }
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runId = yield* start
        expect(
          yield* control.list({ _tag: "executions", runId, executionIds: [runId], reader: alice }).pipe(Effect.flip)
        )
          .toBe(failure)
      }).pipe(Effect.provide(live({ runtime: runtime(), executor })), Effect.scoped)
    )
  })

  it("returns observed, missing and unavailable entries in exact request order with their native provenance", async () => {
    const source = "native-source"
    const batch: ExecutionBatch = {
      source,
      revision: 17,
      snapshots: [
        {
          _tag: "Observed",
          executionId: "child",
          source,
          revision: 17,
          observation: Schema.decodeUnknownSync(ExecutionFact.Observation)({
            executionId: "child", flowName: "read-test/child", status: "cancelled",
            createdAtMs: 1, startedAtMs: 2, finishedAtMs: 3,
            parentRunId: "root", lineageId: "child", roundOrdinal: 0,
            cancelRequestedAtMs: 3, waiting: null
          })
        },
        { _tag: "Missing", executionId: "gone", source, revision: 17, deleted: true },
        { _tag: "Unavailable", executionId: "foreign", reason: "outside-run" }
      ]
    }
    const asked: Array<ReadonlyArray<string>> = []
    const executor = {
      ...ControlExecutor.makeNoop(),
      readExecutions: (input: { readonly executionIds: ReadonlyArray<string> }) => Effect.sync(() => {
        asked.push(input.executionIds)
        return batch
      })
    }
    await Effect.runPromise(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start
      const executionIds = ["child", "gone", "foreign"]
      const result = yield* control.list({ _tag: "executions", runId, executionIds, reader: alice })
      expect(result).toEqual({ _tag: "executions", source, revision: 17, items: batch.snapshots })
      expect(asked).toEqual([executionIds])
    }).pipe(Effect.provide(live({ runtime: runtime(), executor })), Effect.scoped))
  })
})
