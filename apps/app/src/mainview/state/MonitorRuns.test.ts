import { describe, expect, test } from "bun:test"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { monitorRuns } from "./MonitorRuns"
const todo = (n: number, workspace = `lane-${n}`, state: TodoCard["state"] = "working") => ({ n, title: `Change ${n}`, state, branch: { id: workspace }, run: { id: "run-1" }, prompt_revisions: [{ at: "2026-10-05T00:00:00Z" }] }) as TodoCard
const box = { runId: "run-1", flowId: "box", status: "running", createdAt: 1, turns: 2, calls: 3 }
describe("Monitor inventory", () => {
 test("host-local run ids retain the TODO and box; duplicate TODOs collapse within one workspace", () => {
  const rows = monitorRuns([box], [todo(1), todo(1)], "box")
  expect(rows).toHaveLength(2)
  expect(rows.map(row => row.workspaceId)).toEqual(["lane-1", "box"])
  expect(rows[0]?.title).toBe("T1 · Change 1")
 })
 test("authoritative box status and usage win when the TODO names the same recorded run", () => {
  const rows = monitorRuns([box], [todo(1, "box", "failed")], "box")
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ status: "running", turns: 2, calls: 3, todo: 1 })
 })
 test("TODOs without a run or branch cannot invent an Inspect address", () => {
  expect(monitorRuns([], [{ ...todo(1), run: undefined }, { ...todo(2), branch: undefined }], "box")).toEqual([])
 })
 test.each([["merged", "completed"], ["failed", "failed"], ["dropped", "cancelled"], ["paused", "parked"], ["needs_you", "waiting-approval"]] as const)("maps %s inventory state to %s", (state, status) => {
  expect(monitorRuns([], [todo(1, "lane", state)], "box")[0]?.status).toBe(status)
 })
 test("property: permutation and duplication do not change scoped inventory", () => {
  for (let count=1; count<=100; count++) {
   const todos=Array.from({length:count}, (_,n)=>todo(n+1))
   expect(monitorRuns([box], todos, "box")).toEqual(monitorRuns([box,box], [...todos.reverse(),...todos], "box"))
  }
 })
})
