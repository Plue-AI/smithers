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
    item("2431", "blocked", { reason: "very hard 3/3", todo: { replans: 2, veryHard: true } }),
    item("2412", "running", { lane: 0, todo: { replans: 1 } }),
    item("2388", "landed", {
      createdAt: "2026-09-28T16:00:00Z",
      humanEdited: false,
      costNanos: 2_000_000_000,
      route: { as: "close", landed: "change" }
    }),
    item("2391", "declined", { reason: "Already done." })
  ],
  lanes: [],
  limits: { maxParallel: 3 }
} as unknown as MythicalStack

it("lists the factory's issues under Needs you, Working and Done, each with its title and word", () => {
  expect(Factory.rows(stack, now).map((row) => [row.label, row.status])).toEqual([
    ["◆ Needs you 1", undefined],
    ["◆ #2431 Issue 2431 · blocked", undefined],
    ["◐ Working 1", undefined],
    ["#2412 Issue 2412 · implementing · plan 2 of 3", "running"],
    ["● Done 2", undefined],
    ["#2388 Issue 2388 · landed", "done"],
    ["#2391 Issue 2391 · declined", "done"]
  ])
})

it("heads the list with the shared measured numbers on one line", () => {
  expect(Factory.metrics(stack)).toBe(
    "1/3 landed · 100% landed unedited · 3h p50 · $2.00/landed · 1 revert · 1 misroute · 3 replans"
  )
  expect(Factory.metrics({ ...stack, items: [], changes: [] })).toBe("0 reverts · 0 misroutes · 0 replans")
})

it("shows very hard only during the continuation and derives plan number from replans", () => {
  const continuing = {
    ...stack,
    items: [item("2412", "running", { lane: 0, todo: { replans: 2, veryHard: true } })]
  } as unknown as MythicalStack
  expect(Factory.rows(continuing, now)[1]?.label).toBe("#2412 Issue 2412 · implementing · plan 3 of 3 · very hard")
  expect(Factory.metrics(continuing)).toContain("1 very hard")
  const blocked = {
    ...continuing,
    items: [item("2412", "blocked", { todo: { replans: 2, veryHard: true } })]
  } as unknown as MythicalStack
  expect(Factory.rows(blocked, now)[1]?.label).not.toContain("very hard")
  expect(Factory.metrics(blocked)).not.toContain("very hard")
})

it("uses the outcome word for Working and Done, with the reason in details", () => {
  const value = {
    ...stack,
    items: [
      item("2400", "retrying", { reason: "seat unavailable", todo: { replans: 1 } }),
      item("2401", "declined", { reason: "Already done." })
    ]
  } as unknown as MythicalStack
  const rows = Factory.rows(value, now)
  expect(rows.find((row) => row.label.includes("#2400"))?.label).toContain("· retrying · plan 2 of 3")
  expect(rows.find((row) => row.label.includes("#2401"))?.label).toBe("#2401 Issue 2401 · declined")
  expect(rows.find((row) => row.label.includes("#2401"))?.details).toEqual([{
    kind: "text",
    text: "Already done.\nhttps://github.com/o/r/issues/2401"
  }])
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
