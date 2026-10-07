import { describe, expect, test } from "vitest"
import { UiInstructionFrameSchema } from "../src/UiInstruction.ts"

describe("author monitor selection", () => {
  const base = { command: "runs.trace.view", runId: "run-9", view: "turns" }
  test("carries only its declared monitor state", () => {
    for (const state of [{}, null, { selected: "cell-1", at: 0, tab: "journal" }, { selected: null, at: null, tab: null }]) {
      expect(UiInstructionFrameSchema.parse({ ...base, state })).toEqual({ ...base, state })
    }
    for (const state of ["cell", { at: -1 }, { at: 0.5 }, { tab: "owner" }, { selected: {} }, { shared: true }]) {
      expect(UiInstructionFrameSchema.safeParse({ ...base, state }).success).toBe(false)
    }
  })
  test("keeps other screen commands scalar and rejects undeclared authority", () => {
    for (const frame of [
      { command: "theme", mode: {} }, { command: "theme", mode: null },
      { command: "theme", mode: "dark", state: {} }, { ...base, owner: true }
    ]) expect(UiInstructionFrameSchema.safeParse(frame).success).toBe(false)
    expect(UiInstructionFrameSchema.parse({ command: "theme", mode: "dark" })).toEqual({ command: "theme", mode: "dark" })
  })
})
