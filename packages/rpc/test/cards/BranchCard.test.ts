/**
 * Story coverage for the props-only Branch contract.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import type { BranchCard } from "../../src/BranchCard.ts"
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
