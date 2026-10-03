/**
 * Behavioral projection contract checks for Branch.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { type BranchCard, BranchCardSchema } from "../../src/BranchCard.ts"
import { cardContract } from "../cardContract.ts"
import { person } from "../fixtures/_shared.ts"
import { fixtures } from "../fixtures/Branch.ts"

cardContract("Branch", BranchCardSchema, fixtures)

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
const active = () => BranchCardSchema.parse(fixtures.active.model)

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

describe("Branch enums", () => {
  test.each(["sleeping", "building", "ready", "unknown", ""])("rejects machine state %j", (state) => {
    expect(BranchCardSchema.safeParse({ ...fixtures.awake.model, machine: { state } }).success).toBe(false)
  })
  test("a waiting machine needs its position and a failed one its error", () => {
    expect(BranchCardSchema.safeParse({ ...fixtures.awake.model, machine: { state: "waiting" } }).success).toBe(false)
    expect(BranchCardSchema.safeParse({ ...fixtures.awake.model, machine: { state: "failed" } }).success).toBe(false)
    expect(BranchCardSchema.safeParse({ ...fixtures.awake.model, machine: { state: "waiting", position: 0 } }).success)
      .toBe(false)
  })
  test.each(["queued", "done", "failed", ""])("rejects rebase state %j", (state) => {
    expect(BranchCardSchema.safeParse({ ...fixtures.awake.model, rebase: { state, onto: "T8" } }).success).toBe(false)
  })
  test("a conflict lists its paths", () => {
    expect(BranchCardSchema.safeParse({ ...fixtures.awake.model, rebase: { state: "conflict", onto: "main" } }).success)
      .toBe(false)
  })
  test.each(["reading", "page", ""])("rejects presence place %j", (kind) => {
    const base = active()
    expect(
      BranchCardSchema.safeParse({ ...base, presence: [{ ...base.presence[0]!, where: { kind, label: "x" } }] }).success
    ).toBe(false)
  })
  test("every presence row says where", () => {
    const base = active()
    const { where: _where, ...nowhere } = base.presence[0]!
    expect(BranchCardSchema.safeParse({ ...base, presence: [nowhere] }).success).toBe(false)
  })
  test.each(["comment", "push", "merge", ""])("rejects activity kind %j", (kind) => {
    const base = active()
    expect(BranchCardSchema.safeParse({ ...base, activity: [{ ...base.activity[0]!, kind }] }).success).toBe(false)
  })
  test.each(["copied", "moved", ""])("rejects file change %j", (change) => {
    const base = active()
    expect(BranchCardSchema.safeParse({ ...base, changed_files: [{ ...base.changed_files[0]!, change }] }).success)
      .toBe(false)
  })
  test.each(["scratch", "issue", ""])("rejects forked-from kind %j", (kind) => {
    expect(BranchCardSchema.safeParse({ ...fixtures.scratch_main.model, scratch: { forked_from: { kind } } }).success)
      .toBe(false)
  })
})

describe("Branch behavior", () => {
  // Re-homed from OtherContracts "represents a branch waiting to rebase onto main"; v0.4 names it `rebase`.
  test("represents a branch waiting to rebase onto main", () => {
    const rebase = { state: "pending", onto: "main" }
    expect(BranchCardSchema.parse({ ...fixtures.awake.model, rebase }).rebase).toEqual(rebase)
  })
  test("a pending rebase names the busy writer and terminal for the member who pressed Rebase now", () => {
    expect(BranchCardSchema.parse(fixtures.rebase_waiting_for.model).rebase).toEqual({
      state: "pending",
      onto: "main",
      waiting_for: { actor: person, terminal: "terminal-1" }
    })
  })
  test("terminals hold agents and freeze while rebasing", () => {
    expect(active().terminals.map(({ id, agents, frozen }) => [id, agents.map((agent) => agent.kind), frozen])).toEqual(
      [
        ["terminal-1", ["agent"], false],
        ["terminal-2", [], true]
      ]
    )
  })
  test("change and edit entries carry the action that opens their burst's diff", () => {
    expect(
      active().activity.flatMap((row) => row.actions.map((action) => [row.kind, action.tag, action.args?.burst]))
    ).toEqual([["edit", "diff", "burst-5"], ["change", "diff", "burst-6"]])
  })
  test("item place, TODO numbers and file counts are integers in range", () => {
    const base = active()
    for (const value of [0, -1, 1.5]) {
      expect(BranchCardSchema.safeParse({ ...base, item: { ...base.item!, place: value } }).success).toBe(false)
      expect(BranchCardSchema.safeParse({ ...base, moved_off: { by: base.presence[0]!.actor, item: value } }).success)
        .toBe(false)
    }
    for (const value of [-1, 0.5]) {
      expect(BranchCardSchema.safeParse({ ...base, activity: [{ ...base.activity[0]!, files: value }] }).success)
        .toBe(false)
    }
  })
})
