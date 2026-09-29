/**
 * Case 8 — the inspector's projection never falls behind the run.
 *
 * "Never idle" is a claim about a derived view: while the journal has committed
 * frames, the projection folded over them has to keep moving. This case folds
 * the same reducer at every committed frame of a real run and checks the two
 * things that make the view trustworthy — it is monotonic in the frame, and at
 * the last frame it accounts for every attempt the run actually recorded.
 *
 * The projection is `TimeTravel.inspect`, which reads the ordinary engine
 * journal. Nothing here writes `meta.lineageId`: the engine stamps it.
 */
import { Journal, type JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"
import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { layer, lineageOf, makeWorkspace, parkLedger } from "./harness/timeTravelRun.ts"

const workspace = makeWorkspace("case08")
beforeAll(() => workspace.enter())
afterAll(() => {
  workspace.leave()
  rmSync(workspace.root, { recursive: true, force: true })
})

const executionId = "case08-run"

const attemptsAt = {
  initial: 0,
  reduce: (state: number, committed: { readonly eventType: string }) =>
    committed.eventType === "flows.engine.attempt-started" ? state + 1 : state
}

describe("case08 the inspector is never idle", () => {
  it("folds every committed frame and reaches the run's real attempt count", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        // Drive the run until it parks. It releases its claim on the way out,
        // which is the state the inspector reads.
        yield* parkLedger(executionId)

        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 500 })
        const timeTravel = yield* TimeTravel

        const derived: Array<number> = []
        for (const entry of page.entries) {
          derived.push(
            yield* timeTravel.inspect(
              { runId: executionId, frame: { lineageId: lineageOf(executionId), seq: entry.seq } },
              attemptsAt
            )
          )
        }
        const recorded = page.entries.filter((entry) => entry.eventType === "flows.engine.attempt-started").length
        // The run must have PARKED, not failed: a failed run also produces a
        // journal, and folding one would prove nothing about the inspector.
        const runs = yield* RunStore.RunStore
        const row = yield* runs.get(executionId)
        return { derived, recorded, frames: page.entries.length, status: row.status }
      }).pipe(
        Effect.provide(layer(workspace.root, workspace.filename, "case08-host")),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.status).toBe("suspended")
    // There is something to be idle about.
    expect(observed.frames).toBeGreaterThan(2)
    expect(observed.recorded).toBeGreaterThan(0)

    // Monotonic: a later frame never derives less than an earlier one.
    for (let index = 1; index < observed.derived.length; index += 1) {
      expect(observed.derived[index]!).toBeGreaterThanOrEqual(observed.derived[index - 1]!)
    }
    // Caught up: the last frame accounts for every attempt the run recorded.
    expect(observed.derived[observed.derived.length - 1]).toBe(observed.recorded)
    // And it moved: a projection stuck at zero would satisfy monotonicity alone.
    expect(observed.derived[observed.derived.length - 1]).toBeGreaterThan(observed.derived[0]!)
  }, 120_000)
})
