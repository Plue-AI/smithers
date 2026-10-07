/**
 * Story coverage for the props-only Branch contract.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { BranchActivityEntry, BranchTopic, type BranchCard } from "../../src/BranchCard.ts"
import { fixtures } from "../fixtures/Branch.ts"


// Literal oracles from ui-components.md T-UI-15 and spec §4.2, §7.3.1, §3; never read from the schema.
const MACHINE_STATES = ["awake", "asleep", "waking", "closed", "waiting", "failed"] as const
const REBASE_STATES = ["pending", "rebasing", "conflict"] as const
const FORKED_FROM = ["main", "item", "branch"] as const
const WHERE = ["file", "terminal", "step", "branch"] as const
const ACTIVITY = [
  "step",
  "steer",
  "question",
  "answer",
  "edit",
  "change",
  "github",
  "rebase",
  "read",
  "context"
] as const
const CHANGES = ["added", "modified", "deleted", "renamed"] as const
const models: BranchCard[] = Object.values(fixtures).map((story) => story.model)
const active = () => fixtures.active.model

describe("Branch coverage", () => {
  test("stories cover every machine, rebase and forked-from state", () => {
    expect([...new Set(models.map((branch) => branch.machine.state))].sort()).toEqual([...MACHINE_STATES].sort())
    expect([...new Set(models.flatMap((branch) => branch.rebase ? [branch.rebase.state] : []))].sort()).toEqual(
      [...REBASE_STATES].sort()
    )
    expect(models.some((branch) => branch.rebase?.state === "pending" && branch.rebase.waiting_for)).toBe(true)
    expect(models.some((branch) => branch.rebase?.state === "pending" && !branch.rebase.waiting_for)).toBe(true)
    expect([...new Set(models.flatMap((branch) => branch.scratch ? [branch.scratch.forked_from.kind] : []))].sort())
      .toEqual([...FORKED_FROM].sort())
  })
  test("the active story covers every presence place, activity kind and file change", () => {
    const branch = active()
    expect(branch.presence.map((row) => row.where.kind)).toEqual(["file", "file", ...WHERE.slice(1)])
    expect(branch.activity.map((row) => row.kind)).toEqual([...ACTIVITY])
    expect(branch.changed_files.map((file) => file.change)).toEqual([...CHANGES])
  })
})


test("branch live topics and durable activity fixtures match the I2 wire contract", () => {
  for (const topic of ["branch:T12", "branch:T12:files", "branch:T12:activity"]) expect(BranchTopic.parse(topic)).toBe(topic)
  for (const topic of ["branch:", "branch:T12:other", "branch:T12:files:extra", "branch:a/b", "branch:a b"]) {
    expect(BranchTopic.safeParse(topic).success).toBe(false)
  }
  const actor = { id: "ben", kind: "person", member_id: "ben", via: "terminal" }
  const base = { id: "event-1", at: "2026-10-06T12:00:00Z", actor, files: [] }
  for (const kind of ["write", "burst", "doc_edit", "rebase", "moved_off"]) {
    expect(BranchActivityEntry.parse({ ...base, kind })).toEqual({ ...base, kind })
  }
  const entry = { ...base, kind: "burst", versions: "a".repeat(40), files: [
    { path: "a.ts", change: "modified", before_blob: "b".repeat(40), after_blob: "c".repeat(40) },
    { path: "new.ts", change: "added", after_blob: "d".repeat(64) },
    { path: "old.ts", change: "deleted", before_blob: "e".repeat(40) },
    { path: "renamed.ts", change: "renamed" }
  ] }
  expect(BranchActivityEntry.parse(entry)).toEqual(entry)
  for (const invalid of [
    { ...entry, kind: "edit" }, { ...entry, versions: "not-a-commit" },
    { ...entry, actor: { ...actor, uid: 20000 } },
    { ...entry, files: [{ path: "../escape", change: "added" }] },
    { ...entry, files: [{ path: "a", change: "modified", before_blob: "bad" }] }
  ]) expect(BranchActivityEntry.safeParse(invalid).success).toBe(false)
})

test("the branch stream also accepts server-resolved display attribution", () => {
  const actor = { id: "member:2", member_id: "2", kind: "person", login: "presence-owner", name: "Alice", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0, via: "ssh" }
  const entry = { id: "burst-owned", kind: "burst", at: "2026-10-06T12:00:00Z", actor, files: [{ path: "src/retry.ts", change: "modified" }] }
  expect(BranchActivityEntry.parse(entry)).toEqual({ ...entry, actor: { kind: "person", login: "presence-owner", name: "Alice", avatar_url: "https://github.com/identicons/placeholder.png", color_index: 0, via: "ssh" } })
})
