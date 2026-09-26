import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, it } from "bun:test"
import { act } from "react"
import stringWidth from "string-width"
import * as View from "../src/view.tsx"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})

it("keeps long and Unicode picker labels separate from aligned metadata", async () => {
  setup = await testRender(
    <View.List
      rows={[
        { key: "long", label: "This session has a very long prompt that needs a visible date", detail: "today" },
        { key: "unicode", label: "中文 🦉 café", detail: "today" },
        { key: "short", label: "Short", detail: "today" },
        { key: "emoji", label: "👩🏽‍💻".repeat(30), detail: "today" },
        { key: "combining", label: "e\u0301".repeat(50), detail: "today" }
      ]}
      selected={0}
      height={5}
      background="#011627"
      empty="Empty"
    />,
    { width: 72, height: 7 }
  )
  await setup.renderOnce()
  const lines = setup.captureCharFrame().split("\n").filter((line) => line.includes("today"))
  expect(lines).toHaveLength(5)
  expect(lines[0]).toMatch(/… {2,}today/)
  expect(lines[1]).toContain("中文 🦉 café")
  expect(lines[3]).toMatch(/(?:👩🏽‍💻)+… {2,}today/)
  expect(lines[4]).toMatch(/(?:e\u0301)+… {2,}today/)
  const starts = lines.map((line) => stringWidth(line.slice(0, line.indexOf("today"))))
  expect(new Set(starts).size).toBe(1)
})
