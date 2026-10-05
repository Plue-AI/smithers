import { describe, expect, test } from "vitest"
import { callSemantics, traceFromJournal } from "../src/RunTrace.js"

describe("Appendix C Inspect titles", () => {
  test("Appendix C titles override stale descriptors and input never becomes a label", () => {
    const fields = callSemantics("coding/edit-atom", { input: { path: "secret.ts" }, descriptor: {
      name: "coding/edit-atom", presentation: { verb: { pending: "old", success: "old", failure: "old" }, subject: "path", result: "text" }
    } })
    expect(fields.presentation).toEqual({ verb: { pending: "Running: Edited the files", success: "Edited the files", failure: "Failed: Edited the files" }, subject: "none", result: "none" })
    expect(callSemantics("toString", {})).toEqual({})
    expect(callSemantics("unknown", { input: { presentation: { success: "Invented" } } })).toEqual({})
  })
  test.each(["success", "failure"])("the real trace fold uses the title for %s, with raw evidence retained", outcome => {
    const events = [
      { sequence: 1, kind: "control.agent.turn-opened", payload: { at: 100 } },
      { sequence: 2, kind: "control.agent.cell-call-started", payload: { at: 200, callId: "edit", flowName: "coding/edit-atom", input: { path: "src/file.ts" } } },
      { sequence: 3, kind: "control.agent.cell-call-settled", payload: { at: 300, callId: "edit", flowName: "coding/edit-atom", outcome, value: "output", error: "failed" } }
    ]
    const model = traceFromJournal({ runId: "run", flowId: "todo", status: "running" }, events)
    expect(model.lines[0]?.verb).toBe(outcome === "success" ? "Edited the files" : "Failed: Edited the files")
    expect(model.lines[0]?.subject).toBe("")
    expect(model.rows.find(row => row.kind === "call")?.detail.input).toEqual({ path: "src/file.ts" })
  })
})
