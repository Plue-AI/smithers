/**
 * Case 11 — scrubbing through frames changes nothing.
 *
 * `inspect` is a reader: it folds committed journal entries and never plans a
 * body or dispatches an action. The way to check that is not to read the
 * implementation but to fingerprint the durable state before and after
 * scrubbing every frame of a real run — journal sequences, the waiting row, and
 * the workspace file the run wrote — and require the two fingerprints to be
 * identical.
 */
import { DurableEngineState } from "@smthrs/engine-store"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { layer, ledgerFile, lineageOf, makeWorkspace, parkLedger } from "./harness/timeTravelRun.ts"

const workspace = makeWorkspace("case11")
beforeAll(() => workspace.enter())
afterAll(() => {
  workspace.leave()
  rmSync(workspace.root, { recursive: true, force: true })
})

const executionId = "case11-run"

/** Everything a scrub must not touch. */
const fingerprint = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  yield* journal.flush
  const page = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 500 })
  const state = yield* DurableEngineState.DurableEngineState
  const waiting = yield* state.waiting(executionId)
  return {
    entries: page.entries.map((entry) => `${entry.seq}:${entry.eventType}`),
    waiting: Option.isNone(waiting) ? null : `${String(waiting.value.reason)}:${String(waiting.value.token)}`,
    ledger: readFileSync(join(workspace.root, ledgerFile), "utf8")
  }
})

describe("case11 frame scrub is view-only", () => {
  it("leaves the journal, the waiting row, and the workspace untouched", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        yield* parkLedger(executionId)

        const before = yield* fingerprint
        const timeTravel = yield* TimeTravel

        // Scrub the whole run, forwards and then backwards, folding a reducer
        // at every frame.
        const journal = yield* Journal.Journal
        const page = yield* journal.entries({ runId: executionId as JournalEvent.RunId, limit: 500 })
        const seqs = page.entries.map((entry) => entry.seq)
        const views: Array<number> = []
        for (const seq of [...seqs, ...[...seqs].reverse()]) {
          views.push(
            yield* timeTravel.inspect(
              { runId: executionId, frame: { lineageId: lineageOf(executionId), seq } },
              { initial: 0, reduce: (state: number) => state + 1 }
            )
          )
        }

        const after = yield* fingerprint
        const runs = yield* RunStore.RunStore
        const row = yield* runs.get(executionId)
        return { before, after, views, status: row.status }
      }).pipe(
        Effect.provide(layer(workspace.root, workspace.filename, "case11-host")),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.status).toBe("suspended")
    // The scrub really happened, and really produced different views.
    expect(observed.views.length).toBeGreaterThan(4)
    expect(new Set(observed.views).size).toBeGreaterThan(1)
    // And it wrote nothing.
    expect(observed.after).toEqual(observed.before)
  }, 120_000)
})
