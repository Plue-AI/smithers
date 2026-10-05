import { describe, expect, test } from "vitest"
import {
  boundToolResult,
  MAX_TOOL_LEGS,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULT_LINES,
  utf8Bytes
} from "../src/AgentToolResult.ts"

describe("one tool result is bounded before the next model request", () => {
  test("measures UTF-8 bytes rather than JS code units", () => {
    expect(utf8Bytes("🙂")).toBe(4)
    expect(MAX_TOOL_RESULT_BYTES).toBe(16_384)
    expect(MAX_TOOL_RESULT_LINES).toBe(1_000)
    expect(MAX_TOOL_LEGS).toBe(8)
  })

  test("tool outputs pass through losslessly under both limits", () => {
    expect(boundToolResult("ok\nvalue", 100, 10)).toEqual({
      modelOutput: "ok\nvalue",
      truncated: false,
      totalBytes: 8,
      totalLines: 2
    })
  })

  test("tool outputs truncate by line count with an explicit evidence marker", () => {
    const bounded = boundToolResult("one\ntwo\nthree", 200, 2)
    expect(bounded.truncated).toBe(true)
    expect(bounded.modelOutput.startsWith("one\ntwo")).toBe(true)
    expect(bounded.modelOutput).not.toContain("three")
    expect(bounded.modelOutput).toContain("13 bytes, 3 lines total")
  })

  test("tool outputs truncate on UTF-8 byte boundaries without replacement characters", () => {
    const bounded = boundToolResult("🙂".repeat(100), 100, 1_000)
    expect(bounded.truncated).toBe(true)
    expect(utf8Bytes(bounded.modelOutput)).toBeLessThanOrEqual(100)
    expect(bounded.modelOutput).not.toContain("�")
    expect(bounded.modelOutput).toContain("400 bytes")
  })

  test("zero and marker-only budgets remain deterministic", () => {
    const bounded = boundToolResult("large", 0, 0)
    expect(bounded.truncated).toBe(true)
    expect(bounded.modelOutput).toContain("Tool result truncated")
  })

  test("the default bound is the shared byte limit", () => {
    const bounded = boundToolResult("x".repeat(MAX_TOOL_RESULT_BYTES + 1))
    expect(bounded.truncated).toBe(true)
    expect(utf8Bytes(bounded.modelOutput)).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES)
  })
})
