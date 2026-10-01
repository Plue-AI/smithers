/**
 * The in-memory `ControlRuntime` against the shared `ControlLive` contract,
 * plus the checks that are specific to this repo's ownership of the modules.
 */
import { ExecutionFact, Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer, Schema, Stream } from "effect"
import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ClaimLost, InvalidInput, PersistenceError } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { WatchFilter } from "../src/ControlSchema.ts"
import * as TestControl from "../src/test/TestControl.ts"
import { contract, type Stack } from "./ControlContract.ts"
import { live, memoryRuntime } from "./TestStack.ts"

contract("memory", (executor) => TestControl.layer(undefined, executor) as unknown as Layer.Layer<Stack>)

describe("ControlLive", () => {
  it.each([false, true])("resumes after every expanded member without losing deltas (follow=%s)", async (follow) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const journal = yield* Journal.Journal
        const runId = "expanded-cursor"
        for (
          const [eventType, payload] of [
            ["plain", {}],
            ["flows.engine.run-decision", { decision: "created", parentExecutionId: "parent" }],
            ["flows/notifications/Promoted", { boundary: "turn", ids: ["one", "two", "three"] }]
          ] as const
        ) {
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make(runId),
              sourceId: JournalEvent.SourceId.make("/test"),
              eventType,
              payload
            })
          )
        }
        const full = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
        expect(full.map((event) => event.kind)).toEqual([
          "plain",
          "flows.engine.run-decision",
          "control.run.lineage",
          "flows/notifications/Promoted",
          "control.steer.delivered",
          "control.steer.delivered",
          "control.steer.delivered"
        ])
        for (let count = 1; count <= full.length; count++) {
          const consumed = yield* control.watch({ runId, follow: false }).pipe(Stream.take(count), Stream.runCollect)
          const last = consumed.at(-1)!
          expect(last.cursor).toBeDefined()
          const checkpoint = { afterCursor: last.cursor }
          const resumed = yield* control.watch({ runId, follow, ...checkpoint }).pipe(
            Stream.take(full.length - count),
            Stream.runCollect
          )
          expect([...consumed, ...resumed]).toEqual(full)
        }
        expect(yield* control.watch({ runId, follow: false, afterCursor: full.at(-1)!.cursor }).pipe(Stream.runCollect))
          .toEqual([])
        expect(full.map((event) => event.cursor)).toEqual([
          { sequence: full[0]!.sequence },
          { sequence: full[1]!.sequence, offset: 0 },
          { sequence: full[1]!.sequence },
          { sequence: full[3]!.sequence, offset: 0 },
          { sequence: full[3]!.sequence, offset: 1 },
          { sequence: full[3]!.sequence, offset: 2 },
          { sequence: full[3]!.sequence }
        ])
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.orDie)
    )
  })

  it.each([
    { afterCursor: { sequence: 1 } },
    { runId: "run-1", afterSequence: 1, afterCursor: { sequence: 1 } },
    ...[-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER].flatMap((invalid) => [
      { runId: "run-1", afterCursor: { sequence: invalid } },
      { runId: "run-1", afterCursor: { sequence: 1, offset: invalid } }
    ])
  ])("rejects an invalid composite watch cursor: %j", async (filter) => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        return yield* Effect.flip(control.watch(filter as WatchFilter).pipe(Stream.runCollect))
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.orDie)
    )
    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toContain("afterCursor")
  })

  it.each(
    [
      { stored: "parked", native: "pending", accepted: true },
      { stored: "accepted", native: "pending", accepted: false },
      { stored: "running", native: "pending", accepted: false },
      { stored: "parked", native: "running", accepted: false },
      { stored: "parked", native: "absent", accepted: false }
    ] as const
  )(
    "respects stored ownership when native reads overlay accepted ($stored/$native)",
    async ({ stored, native, accepted }) => {
      const runId = "retained-fork"
      const runtime = Layer.effect(
        ControlRuntime,
        Effect.map(ControlRuntime, (base) => ({
          ...base,
          getRun: () => Effect.succeed({ runId, flowId: "steps", status: stored, createdAt: 0, updatedAt: 0 }),
          codeDrift: () => Effect.succeed(undefined),
          resume: () => Effect.fail(new ClaimLost({ runId }))
        }))
      ).pipe(Layer.provide(memoryRuntime()))
      const observation = Schema.decodeSync(ExecutionFact.Observation)({
        executionId: runId,
        flowName: "agent/run",
        status: native === "absent" ? "pending" : native,
        createdAtMs: 0,
        startedAtMs: null,
        finishedAtMs: null,
        parentRunId: null,
        lineageId: runId,
        roundOrdinal: 0,
        cancelRequestedAtMs: null,
        waiting: null
      })
      const executor = ControlExecutor.makeNoop({
        readExecution: () =>
          Effect.succeed({
            _tag: "Observed",
            status: "accepted",
            ...(native === "absent" ? {} : { executionView: { root: observation, current: observation } })
          })
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const journal = yield* Journal.Journal
          const input = { runId, idempotencyKey: `resume:${stored}:${native}` }
          if (accepted) expect(yield* control.resume(input)).toMatchObject({ _tag: "Accepted", runId })
          else expect(yield* Effect.flip(control.resume(input))).toBeInstanceOf(ClaimLost)
          yield* journal.flush
          const events = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })
          expect(events.entries.some((entry) => entry.eventType === "control.run.resume")).toBe(accepted)
          expect((yield* (yield* ControlRuntime).getRun(runId)).status).toBe(stored)
        }).pipe(Effect.provide(live({ runtime, executor })), Effect.scoped, Effect.orDie)
      )
    }
  )

  it.each([false, true])("preserves a parked-host refusal (allowCodeDrift=%s)", async (allowCodeDrift) => {
    const runId = "parked-live-host"
    const refusal = new ClaimLost({ runId, reason: "The host that parked this run is still alive" })
    const runtime = Layer.effect(
      ControlRuntime,
      Effect.map(ControlRuntime, (base) => ({
        ...base,
        getRun: () => Effect.succeed({ runId, flowId: "steps", status: "parked" as const, createdAt: 0, updatedAt: 0 }),
        codeDrift: () => Effect.succeed(undefined),
        resume: () => Effect.fail(refusal),
        resumeAdopting: () => Effect.fail(refusal)
      }))
    ).pipe(Layer.provide(memoryRuntime()))
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        expect(yield* Effect.flip(control.resume({ runId, idempotencyKey: "resume-live-host", allowCodeDrift }))).toBe(refusal)
        const journal = yield* Journal.Journal
        const events = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })
        expect(events.entries.some((entry) => entry.eventType === "control.run.resume")).toBe(false)
      }).pipe(Effect.provide(live({ runtime })), Effect.scoped, Effect.orDie)
    )
  })

  it("answers a terminal outcome observed after losing the cancellation claim", async () => {
    const runtime = Layer.effect(
      ControlRuntime,
      Effect.map(ControlRuntime, (base) => ({
        ...base,
        interrupt: (runId: string) =>
          Effect.gen(function*() {
            const fence = yield* base.claimFence(runId)
            yield* base.writeStatus(runId, fence, "completed")
            return yield* new ClaimLost({ runId })
          })
      }))
    ).pipe(Layer.provide(memoryRuntime()))
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run:race"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
        yield* runtime.resume(receipt.runId)
        expect(yield* control.cancel({ runId: receipt.runId, idempotencyKey: "cancel:race" }))
          .toEqual({ _tag: "Terminal", runId: receipt.runId, status: "completed" })
      }).pipe(Effect.provide(live({ runtime })), Effect.scoped, Effect.orDie)
    )
  })

  it("repairs a failed memory plan creation event exactly once on keyed retry", async () => {
    let fail = true
    const journal = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (base) =>
        Journal.make({
          ...base,
          emitDurableUnfenced: (input) =>
            Effect.suspend(() => {
              if (fail) {
                fail = false
                return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "injected failure" }))
              }
              return base.emitDurableUnfenced(input)
            })
        }))
    ).pipe(Layer.provide(TestJournal.layer()), Layer.orDie)
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const request = { flowId: "system/test", input: {}, idempotencyKey: "retry:plan" }
        const failure = yield* Effect.flip(control.plan(request))
        const card = yield* control.plan(request)
        const replay = yield* control.plan(request)
        const events = yield* control.watch({ follow: false }).pipe(Stream.runCollect)
        return { failure, card, replay, events }
      }).pipe(Effect.provide(live({ journal })), Effect.scoped, Effect.orDie)
    )

    expect(observed.failure).toBeInstanceOf(PersistenceError)
    expect(observed.replay).toEqual(observed.card)
    expect(observed.events.filter((event) => event.kind === "control.plan.created")).toHaveLength(1)
  })

  it("finds a repaired creation beyond the first journal page without duplicating it", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const control = yield* Control
        const journal = yield* Journal.Journal
        const request = { flowId: "system/test", input: {}, idempotencyKey: "paged:plan" }
        const { card } = yield* runtime.plan(request)
        const runId = JournalEvent.RunId.make(`plan:${card.planId}`)
        // An older plan can have other entries before its creation is repaired.
        // An event from another producer is not the control plane's creation.
        for (let index = 0; index < 1024; index++) {
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId,
              sourceId: JournalEvent.SourceId.make(index === 0 ? "/control" : "/other"),
              eventType: index === 0 ? "control.approval.approved" : "control.plan.created",
              payload: { index }
            })
          )
        }
        yield* control.plan(request)
        const replay = yield* control.plan(request)
        const tail = yield* journal.entries({ runId, after: JournalEvent.Seq.make(1023), limit: 10 })
        return { card, replay, tail }
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.orDie)
    )

    expect(observed.replay).toEqual(observed.card)
    expect(observed.tail.entries.map((entry) => [entry.sourceId, entry.eventType])).toEqual([
      ["/control", "control.plan.created"]
    ])
  })

  it.each(["transact", "entries"] as const)("reports plan %s failures as persistence errors", async (operation) => {
    const journal = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (base) =>
        Journal.make({
          ...base,
          [operation]: () => Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "injected failure" }))
        }))
    ).pipe(Layer.provide(TestJournal.layer()), Layer.orDie)
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const control = yield* Control
        const request = { flowId: "system/test", input: {}, idempotencyKey: "failed:plan" }
        yield* runtime.plan(request)
        return yield* Effect.flip(control.plan(request))
      }).pipe(Effect.provide(live({ journal })), Effect.scoped, Effect.orDie)
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("plan")
  })

  it("owned modules contain no Node or platform-node imports", () => {
    const files = [
      "src/Control.ts",
      "src/ControlRuntime.ts",
      "src/ControlLive.ts",
      "src/SqlControlRuntime.ts",
      "src/internal/planning.ts",
      "src/test/TestControl.ts",
      "test/ControlContract.ts"
    ]
    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
      expect(source, file).not.toMatch(/(?:from|import\s*)\s*["']node:/)
      expect(source, file).not.toContain(["@effect", "platform-node"].join("/"))
    }
  })
})
