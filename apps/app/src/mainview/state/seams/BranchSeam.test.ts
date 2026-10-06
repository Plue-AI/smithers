import { projectBranchFiles } from "@smthrs/rpc/FileCard"
import { expect, test } from "bun:test"
import { branchModel, branchSeedAvailable, createBrowserPresence } from "./BranchSeam"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"

test("branch fallback distinguishes a demo bootstrap from an install and a provider-only host", () => {
  const bootstrap: AppBootstrap = { apiVersion: 1, host: "local", version: "test", buildSha: "test", capabilities: [], authFlow: "none", sandbox: null }
  for (const live of [undefined, {}]) {
    expect(branchSeedAvailable({ bootstrap, live })).toBe(true)
    expect(branchSeedAvailable({ bootstrap: { ...bootstrap, capabilities: ["install"] }, live })).toBe(false)
  }
  expect(branchSeedAvailable({})).toBe(true)
  expect(branchSeedAvailable({ live: {} })).toBe(false)
})
const branch = { id: "b1", name: "Live branch", machine: { state: "asleep" as const }, presence: [], terminals: [], ssh_line: "ssh -p 2222 b1@localhost" }
test("live mapping uses captured facts and refuses missing or malformed topics", () => {
  expect(branchModel(branch, [], [], "b1")).toEqual({ ...branch, activity: [], changed_files: [] })
  for (const values of [[undefined, [], []], [branch, undefined, []], [branch, [], undefined], [{ ...branch, machine: { state: "magic" } }, [], []], [{ ...branch, id: "b2" }, [], []]]) {
    expect(branchModel(...values as [unknown, unknown, unknown], "b1")).toBeUndefined()
  }
})
test("server action data cannot enable commands while dependencies are dark", () => {
  const actor = { kind: "system", color_index: 7 }
  const activity = [{ id: "burst1", actor, kind: "change", text: "Changed", at: "2026-10-05", actions: [{ tag: "diff", label: "Bad", agent: "run" }] }]
  expect(branchModel(branch, activity, [], "b1")?.activity[0]?.actions).toEqual([])
})
test("presence uses the shared publisher on every move and every 10 seconds; disposal stops it", () => {
  const calls: unknown[] = []
  let tick!: () => void
  let cancelled = false
  const heartbeat = createBrowserPresence({ presence: where => calls.push(where), schedule: (fn, ms) => { expect(ms).toBe(10000); tick = fn; return 1 }, cancel: () => { cancelled = true } })
  heartbeat.move({ branch: "b1" })
  heartbeat.move({ branch: "b1", path: "a.ts", line: 3 })
  tick()
  heartbeat.move({ branch: "b1", terminal: "term1" })
  heartbeat.dispose()
  tick()
  heartbeat.move({ branch: "b2" })
  expect(calls).toEqual([{ branch: "b1" }, { branch: "b1", path: "a.ts", line: 3 }, { branch: "b1", path: "a.ts", line: 3 }, { branch: "b1", terminal: "term1" }])
  expect(cancelled).toBe(true)
})

test("file reload hints preserve the Branch card's changed-file rows", () => {
  const writer = { kind: "outside", color_index: 7 } as const
  const rows: NonNullable<ReturnType<typeof branchModel>>["changed_files"] = [{ path: "src/retry.ts", change: "modified", authors: [writer] }]
  const topic = projectBranchFiles(rows, { kind: "file_written", path: "src/retry.ts", post_digest: "digest-2", actor: writer })
  expect(branchModel(branch, [], topic, "b1")?.changed_files).toEqual(rows)
  const next = projectBranchFiles(topic, [])
  expect(branchModel(branch, [], next, "b1")?.changed_files).toEqual([])
})
