/**
 * Two parks of one run that race on the same latency ceiling share one
 * request.
 *
 * The request identity names the exceeded scope and ceiling, but the proposed
 * raise covers the elapsed time, which differs between callers. When both
 * callers scan the journal before either registers, the loser proposes a
 * different envelope under the winner's identity, and the runtime refuses it.
 * The loser must adopt the registered proposal and park on it (#2739).
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { ControlRuntime } from "@smthrs/control"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import * as Budget from "../src/Budget.ts"

const exceeded = (used: number) =>
  new Budget.BudgetExceeded({
    scope: "latency",
    onExceeded: "park",
    used,
    reserved: 0,
    max: 100,
    next: 0,
    message: `latency used ${used}`
  })

describe("racing budget parks", () => {
  it("park both callers on one proposal when both scan before either registers", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const runtime = yield* ControlRuntime.ControlRuntime
        const planned = yield* runtime.plan({ flowId: "system/test", input: {} })
        const plan = yield* runtime.lookupApproval(planned.card.approval.target)
        yield* runtime.resolveApproval(plan, "approved", yield* runtime.stampPrincipal(), "once")
        const launch = yield* runtime.launch(planned.card.planId, planned.card.digest, planned.card.envelope)
        if (launch._tag !== "Started") return yield* Effect.die(`launch: ${launch._tag}`)
        const runId = launch.run.runId
        // Hold every scan until both callers have read the journal once.
        let scans = 0
        const bothScanned = yield* Deferred.make<void>()
        const barrier: Journal.Service = Journal.make({
          ...journal,
          entries: (query) =>
            journal.entries(query).pipe(Effect.tap(() =>
              Effect.suspend(() => {
                scans += 1
                return scans === 2 ? Deferred.succeed(bothScanned, undefined) : Effect.void
              }).pipe(Effect.andThen(Deferred.await(bothScanned)))
            ))
        })
        const parking = AgentSession.budgetParking(barrier, runtime)(runId, {
          capabilities: [],
          flows: [],
          budget: { milliseconds: 100, onExceeded: "park" }
        })
        const exits = yield* Effect.all([
          Effect.exit(parking.park(exceeded(150))),
          Effect.exit(parking.park(exceeded(151)))
        ], { concurrency: 2 })
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })
        const requests = page.entries.filter((entry) => entry.eventType === "control.approval.requested")
          .map((entry) =>
            entry.payload as {
              readonly requestId: string
              readonly question: string
              readonly payload: { readonly target: { readonly envelope: unknown } }
            }
          )
        return { exits, requests }
      }).pipe(
        Effect.provide(
          Layer.merge(TestJournal.layer(), ControlRuntime.layerMemory().pipe(Layer.provide(NodeCrypto.layer)))
        ),
        Effect.scoped
      )
    )

    const [first, second] = observed.exits
    expect(Exit.isSuccess(first!)).toBe(true)
    expect(Exit.isSuccess(second!)).toBe(true)
    if (!Exit.isSuccess(first!) || !Exit.isSuccess(second!)) return
    expect(second.value.waiting).toEqual(first.value.waiting)
    // Every recorded request names the same question and proposal.
    expect(new Set(observed.requests.map((request) => request.requestId)).size).toBe(1)
    expect(new Set(observed.requests.map((request) => request.question)).size).toBe(1)
    expect(new Set(observed.requests.map((request) => JSON.stringify(request.payload.target.envelope))).size).toBe(1)
  })
})
