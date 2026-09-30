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
