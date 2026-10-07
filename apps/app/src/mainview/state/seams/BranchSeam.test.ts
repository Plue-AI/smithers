import { projectBranchFiles } from "@smthrs/rpc/FileCard"
import { expect, test } from "bun:test"
import { branchFileMachineScope, branchModel, branchSeedAvailable, createBrowserPresence, projectBranchActivity } from "./BranchSeam"
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

test("durable burst and changed-file frames decode with roster attribution", () => {
  const actor = { id: "member:ben", kind: "person", member_id: "ben", via: "ssh" }
  const context = { roster: [{ id: "ben", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 }] }
  const events = [{ id: "burst-1", at: "2026-10-06T12:00:00Z", kind: "burst", actor, files: [{ path: "src/retry.ts", change: "modified" }] }]
  const files = { changed: [{ path: "src/retry.ts", change: "modified", last_writer: actor }], open: [] }
  const model = branchModel(branch, events, files, "b1", context)!
  expect(model.activity[0]).toEqual({ id: "burst-1", at: "2026-10-06T12:00:00Z", kind: "change", actor: { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0, via: "ssh" }, text: "changed 1 file", files: 1, actions: [] })
  expect(model.changed_files[0]?.authors).toEqual([model.activity[0]!.actor])
  expect(branchModel(branch, events, files, "b1")).toBeUndefined()
  expect(branchModel(branch, [{ ...events[0], files: [{ path: "../secret", change: "modified" }] }], files, "b1", context)).toBeUndefined()
})

test("activity replay deduplicates, caps at 200, and refuses malformed deltas", () => {
  const before = Array.from({ length: 200 }, (_, n) => ({ id: String(n), text: "before" }))
  const after = projectBranchActivity(before, [{ id: "199", text: "updated" }, { id: "200", text: "next" }]) as unknown[]
  expect(after).toHaveLength(200)
  expect(after[0]).toEqual({ id: "1", text: "before" })
  expect(after.slice(-2)).toEqual([{ id: "199", text: "updated" }, { id: "200", text: "next" }])
  expect(() => projectBranchActivity([], [{}])).toThrow("Invalid activity entry")
  expect(() => projectBranchActivity(undefined, [])).toThrow("Invalid activity delta")
})

test("server-resolved numeric authors render without inventing a roster identity", () => {
  const author = { kind: "person", id: "member:1", member_id: "1", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0, via: "ssh" }
  const model = branchModel(branch,
    [{ id: "owned-burst", kind: "burst", at: "2026-10-06T12:00:00Z", actor: author, files: [{ path: "src/retry.ts", change: "modified" }] }],
    { changed: [{ path: "src/retry.ts", change: "modified", last_writer: author }], open: [] }, "b1")!
  expect(model.activity[0]?.actor).toEqual({ kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0, via: "ssh" })
  expect(model.activity[0]?.text).toBe("changed 1 file")
  expect(model.changed_files[0]?.authors).toEqual([model.activity[0]!.actor])
})

test("File sleep scope accepts only the matching branch and a captured commit", () => {
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  expect(branchFileMachineScope({ ...branch, head }, "b1")).toEqual({ sleeping: true, capturedHead: head })
  expect(branchFileMachineScope({ ...branch, head }, "Live branch")).toEqual({ sleeping: true, capturedHead: head })
  expect(branchFileMachineScope({ ...branch, head }, "other")).toBeUndefined()
  for (const head of [undefined, "../main", "short", "A".repeat(40)]) {
    expect(branchFileMachineScope({ ...branch, head }, "b1")).toEqual({ sleeping: true })
  }
  expect(branchFileMachineScope({ ...branch, head, machine: { state: "awake" } }, "b1")).toEqual({ sleeping: false })
  expect(branchFileMachineScope({ ...branch, machine: { state: "magic" } }, "b1")).toBeUndefined()
})
