import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { expect, test } from "bun:test"
import type { Run } from "../src/flows.ts"
import { rows } from "../src/toasts.ts"
import type { Tab } from "../src/workspace.ts"

const tab: Tab = {
  id: "worker",
  depth: 0,
  title: "Work",
  prompt: "Work",
  seat: "test",
  file: "session",
  status: "requested",
  startedAt: 0
}
const run: Run = { id: "flow", flow: "test", by: "user", input: {}, requested: "{}", status: "requested", startedAt: 0 }
const project = (tabs: Tab[], runs: Run[], now: number) =>
  rows({ tabs, runs, now, tick: "*", search: undefined, undoing: undefined, toast: undefined })

test("requests remain in the terminal stack through launch and execution", () => {
  expect(project([tab], [run], 299)).toHaveLength(0)
  expect(project([tab], [run], 300).map((row) => row.id)).toEqual(["worker", "flow:flow"])
  expect(project([{ ...tab, status: "running" }], [{ ...run, status: "running" }], 100000)).toHaveLength(2)
})

test("terminal failures remain visible and retries restart the debounce", () => {
  const failedTab = { ...tab, status: "failed" as const, endedAt: 1 }
  const failedRun = { ...run, status: "failed" as const, endedAt: 1 }
  expect(project([failedTab], [failedRun], 1).map((row) => row.tone)).toEqual(["danger", "danger"])
  expect(project([failedTab], [failedRun], 100000)).toHaveLength(2)
  expect(project([{ ...tab, startedAt: 100000 }], [{ ...run, startedAt: 100000 }], 100001)).toHaveLength(0)
})

test("fast successful work stays quiet and visible successes expire after settlement", () => {
  expect(project([{ ...tab, status: "done", endedAt: 100 }], [{ ...run, status: "done", endedAt: 100 }], 300))
    .toHaveLength(0)
  const tabs = [{ ...tab, status: "done" as const, endedAt: 1000 }]
  const runs = [{ ...run, status: "done" as const, endedAt: 1000 }]
  expect(project(tabs, runs, 4999)).toHaveLength(2)
  expect(project(tabs, runs, 5000)).toHaveLength(0)
})

test("a worker's toast says what its card says and offers the card's Stop and Steer", () => {
  const running = { ...tab, status: "running" as const, agent: { name: "review" } }
  const [row] = project([running], [], 42_150)
  expect(row?.text).toBe(SubagentCard.toast({ ...running, title: "review: Work" }, 42_150).line)
  expect(row?.text).toBe("◓ review: Work · 42s")
  expect(row?.worker?.actions.map((action) => action.id)).toEqual(["stop", "steer"])
  const [settled] = project([{ ...tab, status: "done", endedAt: 64_000 }], [], 65_000)
  expect(settled?.text).toBe("● Work · Done 1m 04s")
  expect(settled?.worker?.actions).toEqual([])
  const [queued] = project([{ ...tab, status: "queued" }], [], 1_000)
  expect(queued?.worker?.actions.map((action) => action.id)).toEqual(["stop"])
})
