/**
 * A trace folds one run's journal. A `control.run.*` verdict stamped with a
 * different run id (a child's, say, riding in the parent's events) must not
 * settle the parent's trace or pin its milestone.
 */
import { describe, expect, it } from "vitest"
import { type JournalRecord, traceFold, traceFoldModel, traceFromJournal } from "../src/RunTrace.js"

const run = { runId: "parent", flowId: "agent" }

const records: ReadonlyArray<JournalRecord> = [
  { runId: "parent", sequence: 1, kind: "control.agent.turn-opened", occurredAt: 100, payload: { step: 1 } },
  { runId: "child", sequence: 2, kind: "control.run.failed", occurredAt: 200, payload: {} }
]

describe("RunTrace foreign run records", () => {
  it("ignores another run's verdict", () => {
    const model = traceFromJournal({ ...run, status: "running" }, records)
    expect(model.root.status).toBe("running")
    expect(model.milestones.some((milestone) => milestone.label === "failed")).toBe(false)
    expect(traceFoldModel(traceFold(run, records), "running").root.status).toBe("running")
  })

  it("keeps the run's own verdict and an unstamped one", () => {
    const own = [...records, { runId: "parent", sequence: 3, kind: "control.run.completed", occurredAt: 300 }]
    expect(traceFromJournal({ ...run, status: "running" }, own).root.status).toBe("completed")
    const unstamped = [records[0]!, { sequence: 3, kind: "control.run.cancelled", occurredAt: 300 }]
    expect(traceFromJournal({ ...run, status: "running" }, unstamped).root.status).toBe("cancelled")
  })
})
