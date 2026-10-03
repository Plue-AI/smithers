import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import type * as Transcript from "../src/transcript.ts"
import * as View from "../src/view.tsx"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})

const long = "No `io` test exists yet, so check whether it already reads the whole stream before splitting"

for (const [width, compact] of [[60, false], [40, true]] as const) {
  test(`a wrapped TODO failure keeps its diagnostic and retry hint above the composer at width ${width}`, async () => {
    const text = "TODO not filed: That command could not run. Details: /conversation · /todo again retries it"
    setup = await testRender(
      <box style={{ height: "100%", flexDirection: "column" }}>
        <View.ToastStack rows={[{ id: "notice", text, tone: "warning" }]} height={6} compact={compact} />
        <input placeholder="Ask Smithers" focused />
        <text>ctrl+k Search</text>
      </box>,
      { width, height: 12 }
    )
    await setup.renderOnce()
    // A terminal wraps even inside a slash command. Ignore row borders and
    // whitespace while requiring every diagnostic/action glyph in order.
    const frame = setup.captureCharFrame().replace(/[┃\s]/g, "")
    expect(frame).toContain("Details:/conversation")
    expect(frame).toContain("/todoagainretriesit")
    expect(frame).toContain("AskSmithers")
    expect(frame).toContain("ctrl+kSearch")
  })
}

for (const [width, compact, expected] of [[80, false, 7], [80, true, 5], [40, false, 8], [40, true, 6]] as const) {
  test(`the toast stack takes the ${expected} rows its reservation counts at ${width} columns`, async () => {
    const rows = [
      { id: "worker", text: "◐ Rename add() in math.js · 0s", tone: "info" as const },
      {
        id: "ask",
        text: ["◆ Rename add() in math.js asks: Question line 1", "Question line 2", "x".repeat(70)].join("\n"),
        tone: "info" as const
      }
    ]
    setup = await testRender(
      <box style={{ flexDirection: "column" }}>
        <View.ToastStack rows={rows} height={12} compact={compact} />
      </box>,
      { width, height: 20 }
    )
    await setup.renderOnce()
    const lines = setup.captureCharFrame().split("\n")
    // Each toast's margin, then its lines, each wrapped in the cells the bar and padding leave.
    expect(View.toastStackRows(rows, width, compact)).toBe(expected)
    // The stack's last drawn row closes the count: every margin and wrapped line is in it.
    expect(lines.findLastIndex((line) => line.includes("┃")) + 1).toBe(expected)
    expect(View.toastStackRows([], width, compact)).toBe(0)
  })
}

test("an expanded, clipped cell or call row keeps a space before its right-aligned duration", async () => {
  const item: Transcript.Item = {
    kind: "cell",
    id: "c2",
    index: 2,
    prose: long,
    source: "",
    status: "running",
    printed: "",
    startedAt: 0,
    calls: [{
      flow: "bash",
      subject: "cd packages/release-support && cat package.json 2>/dev/null | head -40",
      status: "ok",
      verb: { pending: "running", success: "ran", failure: "failed to run" },
      startedAt: 0,
      endedAt: 2_300
    }]
  }
  setup = await testRender(
    <View.Entry item={item} now={11_400} tick="⠼" expanded />,
    { width: 48, height: 12 }
  )
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  const rows = frame.split("\n")
  const cell = rows.find((row) => row.includes("11.4s"))
  const call = rows.find((row) => row.includes("2.3s"))
  expect(cell).toMatch(/ 11\.4s\s*$/)
  expect(call).toMatch(/ 2\.3s\s*$/)
  // The text still shows up to the gap.
  expect(cell).toContain("No `io` test")
  expect(call).toContain("ran cd packages")
})
