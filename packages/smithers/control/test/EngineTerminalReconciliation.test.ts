import { Journal, JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Clock, Context, Effect, Layer, Result } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { PersistenceError } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import { durable, fileBundle } from "./DurableStack.ts"

const start = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
  const token = yield* runtime.lookupApproval(card.approval.target)
  yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
  const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
  if (launched._tag !== "Started") return yield* Effect.die("expected launch")
  return launched.run.runId
})
const events = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const entries = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })
    // The run store's ownership transitions share the stream; control's
    // reconciliation facts are what is under test.
    return entries.entries.map((entry) => entry.eventType).filter((eventType) => eventType.startsWith("control."))
  })

describe("terminal engine authority and durable control reconciliation", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    for (const staleFirstRead of [false, true]) {
      it.each([false, true])(
        `persists ${status} learned from ${
          staleFirstRead ? "the cancellation recheck" : "the engine observation"
        } across reopen (parked=%s)`,
        async (parked) => {
          const directory = mkdtempSync(join(tmpdir(), "control-engine-terminal-"))
          const controlFile = join(directory, "control.sqlite")
          const engineFile = join(directory, "engine.sqlite")
          try {
            const runId = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
              // The executor captures the engine store before constructing the
              // control stack. The ambient control store must not replace it.
              const engine = Context.get(yield* Layer.build(fileBundle(engineFile)), RunStore.RunStore)
              let observations = 0
              let requests = 0
              const executor = ControlExecutor.makeNoop({
                readExecution: (id) =>
                  Effect.gen(function*() {
                    const row = yield* engine.get(id).pipe(Effect.orDie)
                    expect(row.status).toBe(status)
                    observations++
                    return {
                      _tag: "Observed" as const,
                      status: staleFirstRead && observations === 1 ? "running" as const : status
                    }
                  }),
                requestCancel: ({ runId: id }) =>
                  Effect.gen(function*() {
                    requests++
                    const result = yield* engine.requestCancel(id, yield* Clock.currentTimeMillis).pipe(Effect.orDie)
                    expect(result).toEqual({ _tag: "Terminal", status })
                    return { _tag: "Terminal" as const, status }
                  })
              })
              const stack = yield* Layer.build(durable({ database: fileBundle(controlFile), executor }))
              return yield* Effect.gen(function*() {
                const control = yield* Control
                const runtime = yield* ControlRuntime
                const id = yield* start
                if (parked) yield* runtime.writeStatus(id, yield* runtime.claimFence(id), "parked")
                yield* engine.create(id, JSON.stringify({ version: 1, flowName: "system/test", payload: {} }))
                const owner = { hostId: "engine", pid: process.pid, nonce: "terminal-test" }
                const row = yield* engine.get(id)
                const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
                expect(yield* engine.claimAndOwn(id, snapshot, owner, yield* Clock.currentTimeMillis))
                  .toEqual({ _tag: "Activated" })
                expect(yield* engine.transitionOwned(id, owner, status)).toEqual({ _tag: "Transitioned" })
                expect((yield* runtime.getRun(id)).status).toBe(parked ? "parked" : "accepted")
                expect(yield* control.cancel({ runId: id, idempotencyKey: "cancel-after-engine-settled" }))
                  .toEqual({ _tag: "Terminal", runId: id, status })
                expect((yield* runtime.getRun(id)).status).toBe(status)
                expect(yield* control.cancel({ runId: id, idempotencyKey: "cancel-after-engine-settled" }))
                  .toEqual({ _tag: "Terminal", runId: id, status })
                expect(requests).toBe(staleFirstRead ? 1 : 0)
                expect(yield* events(id)).toEqual([`control.run.${status}`])
                expect((yield* engine.get(id)).cancelRequestedAtMs).toBeNull()
                return id
              }).pipe(Effect.provide(stack))
            })))
            // A later reader without an executor still sees the persisted truth;
            // this assertion cannot pass on an in-memory projection alone.
            await Effect.runPromise(Effect.scoped(
              Effect.gen(function*() {
                const runtime = yield* ControlRuntime
                expect((yield* runtime.getRun(runId)).status).toBe(status)
                expect(yield* events(runId)).toEqual([`control.run.${status}`])
              }).pipe(Effect.provide(durable({ database: fileBundle(controlFile) })))
            ))
          } finally {
            rmSync(directory, { recursive: true, force: true })
          }
        }
      )
    }
  }

  it("propagates unavailable engine authority without cancelling or settling the local row", async () => {
    const unavailable = new PersistenceError({ operation: "read engine execution", message: "engine unavailable" })
    let requests = 0
    await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const control = yield* Control
        const runId = yield* start
        const before = yield* runtime.getRun(runId)
        const result = yield* Effect.result(control.cancel({ runId, idempotencyKey: "unavailable-engine" }))
        expect(Result.isFailure(result) && result.failure).toBe(unavailable)
        expect(yield* runtime.getRun(runId)).toEqual(before)
        expect(yield* events(runId)).toEqual([])
        expect(requests).toBe(0)
      }).pipe(Effect.provide(durable({
        executor: ControlExecutor.makeNoop({
          readExecution: () => Effect.fail(unavailable),
          requestCancel: () =>
            Effect.sync(() => {
              requests++
              return "recorded" as const
            })
        })
      })))
    ))
  })
})
