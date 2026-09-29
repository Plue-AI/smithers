import type { MythicalStack } from "@smthrs/rpc/Mythical"
import { expect, it } from "bun:test"
import * as Factory from "../src/factory.ts"

const now = Date.parse("2026-09-28T20:00:00Z")
const item = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id,
  state,
  attempt: 1,
  runs: {},
  dependsOn: [],
  updatedAt: "2026-09-28T19:00:00Z",
  issue: { number: Number(id), title: `Issue ${id}`, url: `https://github.com/o/r/issues/${id}` },
  ...extra
})
const stack = {
  repository: "o/r",
  state: "active",
  generation: 1,
  mainBehind: false,
  changes: [{ id: "c1", changeId: "k", commitId: "a".repeat(40), title: "↩ revert", kind: "revert", position: 0 }],
  items: [
    item("2431", "blocked", { reason: "very hard 3/3" }),
    item("2412", "running", { lane: 0 }),
    item("2388", "landed", { createdAt: "2026-09-28T16:00:00Z" }),
    item("2391", "declined")
  ],
  lanes: [],
  limits: { maxParallel: 3 }
} as unknown as MythicalStack

it("lists the factory's issues under Needs you, Working and Done, each with its title and word", () => {
  expect(Factory.rows(stack, now).map((row) => [row.label, row.status])).toEqual([
    ["◆ Needs you 1", undefined],
    ["◆ #2431 Issue 2431 · very hard 3/3", undefined],
    ["◐ Working 1", undefined],
    ["#2412 Issue 2412 · implementing", "running"],
    ["● Done 2", undefined],
    ["#2388 Issue 2388 · landed", "done"],
    ["#2391 Issue 2391 · declined", "done"]
  ])
})

it("heads the list with only what the stack measures", () => {
  expect(Factory.metrics(stack)).toBe("1/3 landed · 1 revert · 3h p50 issue→landed")
  expect(Factory.metrics({ ...stack, items: [], changes: [] })).toBe("0 reverts")
})

it("names the repository from SMITHERS_REPO, else the checkout's remote", () => {
  expect(Factory.repository("/nowhere", { SMITHERS_REPO: "smithersai/smithers" })).toBe("smithersai/smithers")
  expect(Factory.repository("/nowhere", {})).toBeUndefined()
  expect(Factory.repository("/nowhere", { SMITHERS_REPO: "../x" })).toBeUndefined()
})

it("lists at most a group's worth of issues, then how many more", () => {
  const long = {
    ...stack,
    items: Array.from({ length: Factory.perGroup + 5 }, (_, at) => item(String(3000 + at), "queued"))
  }
  const shown = Factory.rows(long as unknown as MythicalStack, now)
  expect(shown).toHaveLength(Factory.perGroup + 2)
  expect(shown.at(-1)).toMatchObject({ id: "more:working", label: "… 5 more" })
})
