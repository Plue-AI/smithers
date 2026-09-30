import { expect, test } from "bun:test"
import type { Run } from "../src/flows.ts"
import { rows, Settlements } from "../src/toasts.ts"
import type { Tab } from "../src/workspace.ts"

const tab: Tab = {
  id: "worker",
  depth: 0,
  title: "Work",
  prompt: "Work",
  seat: "test",
  file: "session",
  status: "running",
  startedAt: 0
}
const run: Run = { id: "flow", flow: "test", by: "user", input: {}, requested: "{}", status: "running", startedAt: 0 }
const update = (
  tracker: Settlements,
  tabs: ReadonlyArray<Tab>,
  runs: ReadonlyArray<Run> = [],
  visible: ReadonlySet<string> = new Set(),
  opened = "summary",
  now = 65_000
) => tracker.update({ tabs, runs, visible, opened, now })
const doneTab = { ...tab, status: "done" as const, endedAt: 64_000 }
const doneRun = { ...run, status: "done" as const, endedAt: 64_000 }

test("requested, queued, running and parked work never generates progress toasts", () => {
  const tracker = new Settlements()
  for (const status of ["requested", "queued", "running", "parked"] as const) {
    expect(update(tracker, [{ ...tab, status }], [{ ...run, status }])).toEqual([])
  }
  expect(rows({
    now: 65_000,
    tick: "*",
    search: undefined,
    undoing: undefined,
    toast: undefined
  })).toEqual([])
})

test.each(["done", "failed", "cancelled"] as const)("visible %s settlements remain quiet", (status) => {
  const tracker = new Settlements([tab], [run])
  const tabs = [{ ...doneTab, status }]
  const runs = [{ ...doneRun, status }]
  expect(update(tracker, tabs, runs, new Set(["tab:worker", "flow:flow"]))).toEqual([])
  // Moving away later does not turn an already seen outcome into a notice.
  expect(update(tracker, tabs, runs)).toEqual([])
})

test.each(["done", "failed", "cancelled"] as const)(
  "off-screen %s settlements appear once with their Open destination",
  (status) => {
    const tracker = new Settlements([tab], [run])
    const tabs = [{ ...doneTab, status }]
    const runs = [{ ...doneRun, status }]
    const notices = update(tracker, tabs, runs)
    expect(notices.map((row) => row.surface)).toEqual(["tab:worker", "flow:flow"])
    expect(notices.map((row) => row.tone)).toEqual(status === "failed" ? ["danger", "danger"] : ["info", "info"])
    expect(notices[0]!.text).toContain("Work")
    expect(notices[1]!.text).toContain("test")
    expect(notices.every((row) => !("worker" in row))).toBe(true)
    expect(update(tracker, tabs, runs)).toEqual(notices)
  }
)

test("opening or showing an outcome clears it permanently without clearing unrelated outcomes", () => {
  const tracker = new Settlements([tab], [run])
  update(tracker, [doneTab], [doneRun])
  expect(update(tracker, [doneTab], [doneRun], new Set(), "tab:worker").map((row) => row.surface))
    .toEqual(["flow:flow"])
  expect(update(tracker, [doneTab], [doneRun], new Set(["flow:flow"]))).toEqual([])
  expect(update(tracker, [doneTab], [doneRun])).toEqual([])
})

test("retrying work clears its previous outcome, and a later settlement reports the new duration", () => {
  const tracker = new Settlements([tab])
  update(tracker, [doneTab])
  const retry = { ...tab, startedAt: 70_000 }
  expect(update(tracker, [retry], [], new Set(), "summary", 71_000)).toEqual([])
  const [notice] = update(tracker, [{ ...retry, status: "done", endedAt: 72_000 }], [], new Set(), "summary", 73_000)
  expect(notice?.surface).toBe("tab:worker")
  expect(notice?.text).toContain("2s")
  expect(notice?.text).not.toContain("1m")
})

test("a newer request with the same title supersedes an older settle notice", () => {
  const tracker = new Settlements([tab])
  update(tracker, [doneTab])
  expect(update(tracker, [doneTab, { ...tab, id: "replacement", startedAt: 70_000 }])).toEqual([])
  const flows = new Settlements([], [run])
  update(flows, [], [doneRun])
  expect(update(flows, [], [doneRun, { ...run, id: "replacement", startedAt: 70_000 }])).toEqual([])
})

test("restored outcomes never become toasts and restored running work still reports its later outcome", () => {
  const restored = new Settlements([doneTab], [doneRun])
  expect(update(restored, [doneTab], [doneRun])).toEqual([])
  const resumed = new Settlements([tab], [run])
  expect(update(resumed, [tab], [run])).toEqual([])
  expect(update(resumed, [doneTab], [doneRun]).map((row) => row.surface)).toEqual(["tab:worker", "flow:flow"])
})

test("search and undo retain their debounce and an ordinary notice remains last", () => {
  const settled = [{ id: "worker", surface: "tab:worker", text: "Work", tone: "info" as const }]
  const input = {
    settlements: settled,
    tick: "*",
    undoing: 0,
    search: { query: "needle", status: "running" as const, startedAt: 0, hits: [], truncated: false },
    toast: { text: "Copied", tone: "info" as const }
  }
  expect(rows({ ...input, now: 299 }).map((row) => row.id)).toEqual(["worker", "notice"])
  expect(rows({ ...input, now: 300 }).map((row) => row.id)).toEqual(["worker", "search", "undo", "notice"])
})
