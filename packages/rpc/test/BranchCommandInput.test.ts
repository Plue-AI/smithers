import { describe, expect, test } from "vitest"
import { BranchForeignAnswerInputSchema, BranchAddToStackInputSchema, BranchForkInputSchema, TodoNewInputSchema } from "../src/CardAction.ts"

describe("branch command payloads", () => {
  test.each(["main", "T2", "T123"])("forks %s with a required source", (from) => {
    expect(BranchForkInputSchema.parse({ from })).toEqual({ from })
    expect(BranchForkInputSchema.parse({ from, name: "try-retry" })).toEqual({ from, name: "try-retry" })
  })

  test.each([{}, { name: "retry" }, { from: "scratch/ben/retry" }, { from: "T0" }, { from: "T02" },
    { from: "T-2" }, { from: "t2" }, { from: "T2\n" }, { from: "main", name: "" },
    { from: "main", commit: "a".repeat(40) }])("rejects invalid S1 fork %j", (input) => {
    expect(BranchForkInputSchema.safeParse(input).success).toBe(false)
  })

  test.each([{ text: "Try retry" }, { text: "Try retry", after: 2 }, { text: "Try retry", before: 3 }])(
    "adopts with the same TODO placement: %j", (input) => {
      expect(BranchAddToStackInputSchema.parse(input)).toEqual(TodoNewInputSchema.parse(input))
    }
  )

  test.each([{ text: "x", after: 2, before: 3 }, { text: "x", after: 0 }, { text: "x", before: -1 },
    { text: "x", after: 1.5 }, { text: "x", after: Number.MAX_SAFE_INTEGER + 1 },
    { text: "x", before: "2" }, { text: " " }, {}, { text: "x", mode: "replace" }])(
    "rejects invalid adoption %j", (input) => {
      expect(BranchAddToStackInputSchema.safeParse(input).success).toBe(false)
    }
  )
})

// Both in-card answers use the same wire shape; legacy sha-only inputs cannot identify a wait.
describe("foreign-push answer payloads", () => {
  test("retains the displayed wait and revision", () => {
    const input = { branch: "smithers/retry-webhooks", id: "foreign-1", revision: "a3" }
    expect(BranchForeignAnswerInputSchema.parse(input)).toEqual(input)
  })
  test.each([
    { branch: "b", revision: "a3" }, { branch: "b", id: "w", sha: "a3" },
    { branch: "b", id: "", revision: "a3" }, { branch: "b", id: "w", revision: "" },
    { branch: "", id: "w", revision: "a3" }, { branch: "b", id: "w", revision: "a3", sha: "a2" }
  ])("refuses an unbound or alternate payload %j", input => {
    expect(BranchForeignAnswerInputSchema.safeParse(input).success).toBe(false)
  })
})
