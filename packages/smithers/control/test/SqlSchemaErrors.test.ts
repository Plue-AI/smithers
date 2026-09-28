import { describe, expect, it } from "vitest"
import { causeMessages, missingTable } from "../src/internal/sqlSchemaErrors.ts"

describe("optional SQL relation failures", () => {
  const missing = missingTable("flows_run_parents")

  it.each([
    "no such table: flows_run_parents",
    "relation \"flows_run_parents\" does not exist",
    "Table 'database.flows_run_parents' doesn't exist"
  ])("recognizes the exact missing relation in %s", (message) => {
    expect(missing({ message: "query failed", reason: { cause: new Error(message) } })).toBe(true)
  })

  it.each([
    "no such table: flows_run_parents_archive",
    "relation \"flows_run_parents_archive\" does not exist",
    "Table 'database.flows_run_parents_archive' doesn't exist",
    "no such table: archived_flows_run_parents",
    "no such table: other.flows_run_parents",
    "relation \"other.flows_run_parents\" does not exist",
    "column \"flows_run_parents\" does not exist",
    "permission denied for relation \"flows_run_parents\"",
    "relation \"FLOWS_RUN_PARENTS\" does not exist",
    "no such table: other\nquery mentions flows_run_parents",
    "no such table: flows_run_parents trailing context"
  ])("retains an unrelated or unrecognized failure: %s", (message) => {
    expect(missing({ message: "reading flows_run_parents", cause: new Error(message) })).toBe(false)
  })

  it("does not combine a table named by the wrapper with a missing-table cause", () => {
    expect(missing({ message: "reading flows_run_parents", reason: { message: "no such table: other" } }))
      .toBe(false)
    expect(missing({ message: "no such table:", cause: "flows_run_parents" })).toBe(false)
  })

  it("handles primitive, message-free, and circular cause chains within its depth bound", () => {
    expect(causeMessages(undefined)).toEqual([])
    expect(causeMessages(null)).toEqual([])
    expect(causeMessages(1)).toEqual([])
    expect(causeMessages({ message: 1 })).toEqual([])
    expect(missing({ cause: "no such table: flows_run_parents" })).toBe(true)
    const cycle: { message: string; cause?: unknown } = { message: "query failed" }
    cycle.cause = cycle
    expect(causeMessages(cycle)).toEqual(["query failed", "query failed", "query failed", "query failed"])
    expect(missing(cycle)).toBe(false)
  })
})
