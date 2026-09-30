import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import type * as Flows from "../src/flows.ts"
import * as View from "../src/view.tsx"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    setup = undefined
  })
})

const run = (change: Partial<Flows.Run>): Flows.Run => ({
  id: "pipeline-1",
  flow: "pipeline",
  by: "user",
  input: {},
  requested: "{}",
  status: "done",
  startedAt: 0,
  launchedAt: 0,
  endedAt: 4_000,
  ...change
})

const rows = async (value: Flows.Run, width: number): Promise<ReadonlyArray<string>> => {
  setup = await testRender(<View.RunCard title="pipeline" run={value} now={4_000} />, { width, height: 8 })
  await setup.renderOnce()
  return setup.captureCharFrame().split("\n").filter((line) => line.trim() !== "")
}

for (const width of [80, 40]) {
  test(`a run line stays one row at ${width} columns, whatever it ends with`, async () => {
    const done = await rows(run({ answer: "x".repeat(200) }), width)
    expect(done).toHaveLength(1)
    expect(done[0]).toMatch(/^ ✓ pipeline · 4s → x+$/)
    await act(async () => {
      setup?.renderer.destroy()
      setup = undefined
    })
    const failed = await rows(run({ status: "failed", message: "The flow failed. ".repeat(12) }), width)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatch(/^ ✗ pipeline · 4s · The flow failed\./)
  })
}
