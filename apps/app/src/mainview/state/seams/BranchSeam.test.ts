import { projectBranchFiles } from "@smthrs/rpc/FileCard"
import { expect, test } from "bun:test"
import { branchFileMachineScope, branchModel, branchSeedAvailable, createBrowserPresence, projectBranch, projectBranchActivity } from "./BranchSeam"
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


test("invalid activity frames retain typed diagnostic reasons", () => {
  for (const [previous, delta, sentence] of [[undefined, [], "Invalid activity delta"], [[], [{}], "Invalid activity entry"]] as const) {
    try { projectBranchActivity(previous, delta); throw new Error("accepted invalid activity") }
    catch (value) { expect(value).toMatchObject({ _tag: "BranchActivityFailure", sentence }) }
  }
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

test("moved-off activity retains the served text and actor without a versions commit", () => {
  const actor = { kind: "person", login: "maya", name: "Maya", avatar_url: "https://github.com/maya.png", color_index: 1 } as const
  const events = [{ id: "moved-1", at: "2026-10-07T08:00:00Z", kind: "moved_off", actor, text: "moved this branch off T2", files: [] },
    { id: "returned-1", at: "2026-10-07T08:01:00Z", kind: "moved_off", actor, text: "returned to T2", files: [] }]
  const model = branchModel({ ...branch, moved_off: { by: actor, item: 2 } }, events, [], "b1")!
  expect(model.moved_off).toEqual({ by: actor, item: 2 })
  expect(model.activity.map(entry => ({ actor: entry.actor, text: entry.text, actions: entry.actions }))).toEqual(events.map(entry => ({ actor, text: entry.text, actions: [] })))
})

test("conversation activity decodes the agent's step and question, a steer and an answer as served", () => {
  const ben = { kind: "person", login: "ben", name: "Ben", avatar_url: "https://github.com/ben.png", color_index: 0 } as const
  const agent = { kind: "agent", id: "run:r1", agent: "coding", name: "", avatar_url: "https://example.test/agent.png", color_index: 1, run_id: "r1",
    for_member: { login: "will", name: "Will", avatar_url: "https://github.com/will.png" } } as const
  const events = [
    { id: "step:request:r1", at: "2026-10-07T08:00:00Z", kind: "step", actor: agent, text: "Plan" },
    { id: "question:q-1", at: "2026-10-07T08:01:00Z", kind: "question", actor: agent, text: "Which greeting should the file carry?" },
    { id: "steer:s-1", at: "2026-10-07T08:02:00Z", kind: "steer", actor: ben, text: "Keep the max at 5" },
    { id: "answer:q-1", at: "2026-10-07T08:03:00Z", kind: "answer", actor: ben, text: "Use the existing retry helper" }
  ]
  const model = branchModel(branch, events, [], "b1")!
  expect(model.activity).toEqual(events.map(entry => ({ ...entry, actions: [] })) as typeof model.activity)
  // A conversation entry never carries a file count or a Diff.
  expect(model.activity.every(entry => entry.files === undefined)).toBe(true)
  // The server omits files on conversation entries; a malformed one refuses the projection.
  expect(branchModel(branch, [{ ...events[2], files: [] }], [], "b1")).toBeUndefined()
})

test("TODO admission deltas preserve Branch participants while advancing queued to starting", () => {
  const waiting = { ...branch, machine: { state: "waiting", position: 1 }, item: { n: 5, title: "Admission", state: "queued", place: 1 } }
  const card = { n: 5, title: "Admission", state: "starting", branch: { id: "b1", name: "branch", machine: { state: "waking" } }, steps: [{ state: "current", label: "Prepare" }] }
  const next = projectBranch(waiting, { Type: "todo.started", Data: { card } }) as { item: unknown; machine: unknown; presence: unknown; terminals: unknown }
  expect(next.item).toEqual({ n: 5, title: "Admission", state: "starting", place: 0, step: "Prepare" })
  expect(next.machine).toEqual({ state: "waking" })
  expect(next.presence).toEqual(waiting.presence)
  expect(next.terminals).toEqual(waiting.terminals)
  for (const delta of [null, {}, { Type: "private.confirmation", Data: { card } }, { Type: "todo.started", Data: {} }, { Type: "todo.started", Data: { card: { ...card, branch: { ...card.branch, id: "other" } } } }]) expect(() => projectBranch(waiting, delta)).toThrow()
})

test("committed TODO deltas add and settle rebase pending on the same Branch", () => {
  const card = { n: 2, title: "Retry webhooks", state: "in_review", place: 2,
    branch: { id: "b1", name: "Live branch", machine: { state: "asleep" } } }
  const pending = projectBranch(branch, { Type: "todo.rebase-requested", Data: { card: { ...card, rebase_pending: { onto: "main" } } } })
  expect(branchModel(pending, [], [], "b1")?.rebase).toEqual({ state: "pending", onto: "main" })
  const settled = projectBranch(pending, { Type: "todo.rebased", Data: { card } })
  expect(branchModel(settled, [], [], "b1")?.rebase).toBeUndefined()
  expect(branchModel(settled, [], [], "b1")?.item?.n).toBe(2)
  expect(() => projectBranch(pending, { Type: "todo.rebase-requested", Data: { card: { ...card, rebase_pending: { onto: 2 } } } })).toThrow()
})


test("Add to stack facts rename the same scratch Branch without retaining its source line", () => {
  const scratch = { ...branch, name: "scratch/ben/try", scratch: { forked_from: { kind: "main" } } }
  const next = projectBranch(scratch, { Type: "todo.created", Data: { card: { n: 3, title: "Try retry", state: "queued", place: 3,
    branch: { id: "b1", name: "smithers/try-retry", machine: { state: "asleep" } } } } })
  expect(branchModel(next, [], [], "b1")).toMatchObject({ id: "b1", name: "smithers/try-retry", item: { n: 3, title: "Try retry", place: 3 } })
  expect(branchModel(next, [], [], "b1")?.scratch).toBeUndefined()
})

 test("receipt-bound system rebase remains visible through the real Branch seam", () => {
  const event = { id: "rebase-1", at: "2026-10-08T08:00:00Z", kind: "rebase", actor: { kind: "system", id: "stack", color_index: 7 },
    text: "Rebased onto main", files: [], receipt_id: "boot:target:00000001", onto_revision: "a".repeat(40), head_changed: true, approvals_cleared: true }
  const model = branchModel(branch, [event], [], "b1")!
  expect(model.activity).toEqual([{ id: event.id, at: event.at, kind: "rebase", actor: { kind: "system", color_index: 7 }, text: "Rebased onto main", files: 0, actions: [] }])
  expect(branchModel(branch, [{ ...event, onto_revision: "main" }], [], "b1")).toBeUndefined()
 })

test("conflict source facts preserve Done binding and settle on resolution", () => {
  const card = { n: 2, title: "Retry", state: "needs_you", branch: { id: "b1", name: "branch", machine: { state: "awake" } }, rebase_pending: { onto: "T1" },
    waits: [{ kind: "conflict", paths: ["retry.ts"], conflict_change: "retained-change", onto_revision: "retained-onto" }] }
  const held = projectBranch(branch, { Type: "todo.waiting", Data: { card } })
  expect(branchModel(held, [], [], "b1")?.rebase).toEqual({ state: "conflict", onto: "T1", paths: ["retry.ts"], conflict_change: "retained-change", onto_revision: "retained-onto" })
  const resolved = projectBranch(held, { Type: "todo.rebased", Data: { card: { ...card, state: "working", waits: [], rebase_pending: undefined } } })
  expect(branchModel(resolved, [], [], "b1")?.rebase).toBeUndefined()
})


test("scratch machine replay preserves branch context and refuses foreign or malformed facts", () => {
  const scratch = { ...branch, scratch: { forked_from: { kind: "main" } } }
  const fact = (id: string, machine: unknown) => ({ Type: "branch.machine", Data: { branch: { id, machine } } })
  const waiting = projectBranch(scratch, fact("b1", { state: "waiting", position: 2 }))
  expect(waiting).toEqual({ ...scratch, machine: { state: "waiting", position: 2 } })
  expect(projectBranch(waiting, fact("b1", { state: "waking" }))).toEqual({ ...scratch, machine: { state: "waking" } })
  expect(projectBranch(waiting, fact("b1", { state: "waiting", position: 2 }))).toEqual(waiting)
  expect(() => projectBranch(waiting, fact("b2", { state: "awake" }))).toThrow("Branch source binding changed")
  expect(() => projectBranch(waiting, fact("b1", { state: "waiting", position: 0 }))).toThrow()
})
