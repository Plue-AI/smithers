import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import type * as TargetApprovals from "../src/target-approvals.ts"

// App boundary units: the target port is the seam (its database side is
// covered by target-approvals.test.ts); rendering, keys and focus are real.
let root = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let pending: Array<TargetApprovals.Row> = []
let decisions: Array<[string, "approve" | "deny"]> = []
let refuse = false
const push: TargetApprovals.Row = {
  key: "plan-push",
  target: "//images:push",
  revision: "177f95506bee0123456789",
  approval: {} as never
}
const port: TargetApprovals.Port = {
  pending: async () => [...pending],
  decide: async (row, decision) => {
    if (refuse) throw new Error("approval_not_found")
    decisions.push([row.key, decision])
    pending = pending.filter((each) => each.key !== row.key)
    return { _tag: "Accepted" } as never
  }
}
const frame = () => setup!.captureCharFrame()
const press = async (name: string, ctrl = false) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, { ctrl })
    await setImmediate()
  })
  await setup!.renderOnce()
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await setTimeout(10)
    })
    await setup!.renderOnce()
  }
  if (!condition()) throw new Error(`Target state did not settle:\n${frame()}`)
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-targets-"))
  mkdirSync(join(root, "workspace"))
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  pending = [push]
  decisions = []
  refuse = false
  const host: Host.Host = {
    cwd: join(root, "workspace"),
    judged: false,
    run: () => ({ done: new Promise(() => {}), cancel: () => {} }),
    dispose: async () => {}
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:test"
        models={[{ seat: "replay:test", label: "Replay", provider: "Fixture" }]}
        contextWindow={() => 10000}
        targets={port}
      />,
      { width: 100, height: 30, exitOnCtrlC: false }
    )
  })
})
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
    await setImmediate()
  })
  setup = undefined
  if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
  rmSync(root, { recursive: true, force: true })
})

const selectTarget = async () => {
  await press("s", true)
  await waitFor(() => frame().includes("//images:push 177f95506bee"))
  expect(frame()).toContain("Needs you")
  for (let step = 0; step < 3 && !frame().includes("y Approve"); step++) await press("DOWN")
  expect(frame()).toContain("y Approve")
  expect(frame()).toContain("n Deny")
}

test("Summary lists a pending build target and y approves that revision", async () => {
  await selectTarget()
  await press("y")
  await waitFor(() => !frame().includes("//images:push"))
  expect(decisions).toEqual([["plan-push", "approve"]])
})

test("n denies the selected build target", async () => {
  await selectTarget()
  await press("n")
  await waitFor(() => !frame().includes("//images:push"))
  expect(decisions).toEqual([["plan-push", "deny"]])
})

test("a refused decision keeps the row and says so", async () => {
  await selectTarget()
  refuse = true
  await press("y")
  await waitFor(() => /not sent/i.test(frame()))
  expect(frame()).toContain("//images:push 177f95506bee")
  expect(decisions).toEqual([])
})
