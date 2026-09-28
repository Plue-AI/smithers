import { expect, test } from "bun:test"
import type { Panel } from "../src/panels.ts"
import * as Summary from "../src/summary.ts"
import * as Transcript from "../src/transcript.ts"

test.each(
  [
    [0, false, "done", "Ran check"],
    [7, false, "failed", "Ran check (exit 7)"],
    [null, false, "failed", "Ran check"],
    [0, true, "cancelled", "Ran check"],
    [null, true, "cancelled", "Ran check"]
  ] as const
)("shell exit=%s cancelled=%s projects its actual result", (exitCode, cancelled, status, label) => {
  const transcript = Transcript.shell(Transcript.empty, {
    command: "check",
    output: "diagnostic\n",
    exitCode,
    cancelled
  }, false)
  const result = Summary.panel(transcript)
  expect(result.rows).toEqual([{
    id: "0",
    label,
    status,
    details: [{ kind: "code", code: "check", language: "bash" }, { kind: "text", text: "diagnostic\n" }]
  }])
  expect(result.summary).toBe(status === "failed" ? `Stopped: ${label}` : label)
})

test("a live shell remains running with its accumulated output", () => {
  const transcript = Transcript.shellOutput(Transcript.shellStart(Transcript.empty, "check", true), "0", "started\n")
  expect(Summary.panel(transcript)).toEqual({
    id: "summary",
    title: "Summary",
    summary: "Ran check",
    rows: [{
      id: "0",
      label: "Ran check",
      status: "running",
      details: [{ kind: "code", code: "check", language: "bash" }, { kind: "text", text: "started\n" }]
    }]
  })
})

test("published card details are capped across rows, and an update replaces the existing card", () => {
  const card: Panel = {
    id: "checks",
    title: "Checks",
    summary: "Nine checks.",
    rows: Array.from({ length: 9 }, (_, index) => ({
      id: String(index),
      label: `Check ${index}`,
      details: [{ kind: "text", text: `Result ${index}` }]
    }))
  }
  const transcript = Transcript.card(Transcript.empty, card)
  const result = Summary.panel(transcript, "review", "Review")
  expect(result).toEqual({
    id: "review",
    title: "Review",
    summary: "Checks",
    rows: [{
      id: "0",
      label: "Checks",
      details: [
        { kind: "text", text: "Nine checks." },
        { kind: "text", text: "Result 0" },
        { kind: "text", text: "Result 1" },
        { kind: "text", text: "Result 2" },
        { kind: "text", text: "Result 3" },
        { kind: "text", text: "Result 4" },
        { kind: "text", text: "Result 5" },
        { kind: "text", text: "Result 6" },
        { kind: "text", text: "Result 7" }
      ]
    }]
  })
  expect(Summary.panel(Transcript.card(transcript, { ...card, title: "Complete", summary: "Passed.", rows: [] })).rows)
    .toEqual([{ id: "0", label: "Complete", details: [{ kind: "text", text: "Passed." }] }])
  expect(card.rows).toHaveLength(9)
})

test("background errors stay visible without replacing a running shell's summary", () => {
  const running = Transcript.shellStart(Transcript.empty, "check", false)
  const result = Summary.panel(Transcript.alert(running, "Monitor failed. More detail."))
  expect(result.summary).toBe("Ran check")
  expect(result.rows[1]).toEqual({
    id: "1",
    label: "Monitor failed.",
    status: "failed",
    details: [{ kind: "text", text: "Monitor failed. More detail." }]
  })
})

test("a background-only failure stays visible without claiming a turn failed", () => {
  const result = Summary.panel(Transcript.alert(Transcript.empty, "Monitor failed"))
  expect(result.summary).toBe("No turns yet.")
  expect(result.rows).toEqual([{
    id: "0",
    label: "Monitor failed",
    status: "failed",
    details: [{ kind: "text", text: "Monitor failed" }]
  }])
})

test.each([
  ["```js\nthrow 1\n```\n# **First sentence!** Later sentence.", "First sentence!"],
  ["\n\n  Only one line\nnext line", "Only one line"],
  ["```js\nthrow 1\n```", ""],
  ["x".repeat(220), "x".repeat(220)],
  ["x".repeat(221), `${"x".repeat(217)}…`]
])("sentence projection keeps the first visible bounded sentence", (input, expected) => {
  expect(Summary.sentence(input)).toBe(expected)
})
