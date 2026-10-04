/*
 * MOCK SEAM test (delete with ./index.ts): the seeded world projected to the
 * Home card's wire shape. Expected values are the seed's literals; the wire
 * schema is the committed `@smthrs/rpc/HomeCard`.
 */
import { expect, test } from "bun:test"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import { createDesignWorld, MAYA } from "./index"
import { designHomeModel, designRole, designTodoByNumber, designTodoNumber } from "./home"

const world = () => createDesignWorld({ timers: { set: () => 0, clear: () => {} } }).world()
const SYNCED_AT = Date.UTC(2026, 9, 3, 12, 0, 0)

test("the seeded stack projects to the home topic's shape: items in merge order with one primary action each", () => {
  const model = designHomeModel(world(), MAYA, SYNCED_AT)
  expect(HomeCardSchema.parse(model)).toEqual(model)
  expect(model.repository).toBe("acme/api")
  expect(model.main).toMatchObject({ title: "#216 merged", health: "fresh", last_success_at: "2026-10-03T12:00:00.000Z" })
  expect(model.items.map(item => [item.n, item.state, item.place, item.branch.name])).toEqual([
    [8, "in_review", 1, "upgrade-stripe"], [9, "needs_you", 2, "retry-webhooks"], [10, "working", 3, "fix-checkout-race"], [11, "queued", 4, "log-retries"]
  ])
  // Every row's first action is its title's door to the TODO card.
  expect(model.items.every(item => item.actions[0]?.tag === "todo" && item.actions[0].args?.door === "title" && item.actions[0].label === item.title)).toBe(true)
  expect(model.items.map(item => item.actions.slice(1).map(action => `${action.tag}:${action.label}${action.primary ? "*" : ""}`))).toEqual([
    ["merge:Merge*", "stack.move:Move down", "todo.drop:Drop"],
    ["todo:Answer*", "stack.move:Move up", "stack.move:Move down", "todo.drop:Drop"],
    ["stack.move:Move up", "stack.move:Move down", "todo.drop:Drop"],
    ["stack.move:Move up", "todo.drop:Drop"]
  ])
  expect(model.items[0]).toMatchObject({ merge: { state: "ready", on_github: false }, pr: { number: 88, draft: false } })
  expect(model.items[1]).toMatchObject({ step: "Verify", merge: { state: "blocked", reason: "checks", detail: "Needs you" } })
  expect(model.items[1]?.present).toHaveLength(2)
  expect(model.items[3]).toMatchObject({ queue: { reason: "machine", position: 1 } })
  expect(model.items[3]?.step).toBeUndefined()
  expect(model.counts).toEqual({ queued: 1, starting: 0, working: 1, needs_you: 1, paused: 0, failed: 0, in_review: 1, merged: 0, dropped: 0 })
  expect(model.merged_since_last_look).toEqual([1, 2, 3, 4, 5])
  expect(model.machines).toMatchObject({ in_use: 3, capacity: 3 })
  expect(model.machines.slots.map(slot => [slot.branch, slot.actor.kind, slot.actor.kind === "agent" ? slot.actor.agent : undefined])).toEqual([
    ["retry-webhooks", "agent", "coding"], ["fix-checkout-race", "agent", "coding"], ["Wiki refresh", "agent", "smithers"]
  ])
  expect(model.parallel).toBe(2)
})

test("background runs: running ones carry no controls, a failed one Retry and Dismiss, done ones leave the card", () => {
  const model = designHomeModel(world(), MAYA, SYNCED_AT)
  expect(model.background_runs).toEqual([
    { id: "r-wiki", title: "Wiki refresh", state: "running", actions: [] },
    { id: "r-release", title: "release-notes", state: "failed", detail: "GitHub API rate limited", actions: [
      { tag: "background.retry", label: "Retry", args: { id: "r-release" } },
      { tag: "background.dismiss", label: "Dismiss", args: { id: "r-release" } }
    ] }
  ])
})

test("the viewer shapes the model: a maintainer sees Merge but no parallel stepper; health ages past 120 s", () => {
  const rows = world()
  expect(designRole(rows, MAYA)).toBe("owner")
  expect(designRole(rows, "ben")).toBe("maintainer")
  const ben = designHomeModel(rows, "ben", SYNCED_AT)
  expect(ben.parallel).toBeUndefined()
  expect(ben.items[0]?.actions[1]).toMatchObject({ tag: "merge", primary: true })
  const stale = designHomeModel({ ...rows, repo: { ...rows.repo, syncedAgo: 121 } }, MAYA, SYNCED_AT)
  expect(stale.main.health).toBe("stale")
  const limited = designHomeModel({ ...rows, repo: { ...rows.repo, mainHealth: { state: "limited", cause: "GitHub rate limit", retryAt: "2026-10-03T12:30:00.000Z" } } }, MAYA, SYNCED_AT)
  expect(limited.main).toMatchObject({ health: "limited", cause: "GitHub rate limit", retry_at: "2026-10-03T12:30:00.000Z" })
})

test("wire numbers round-trip to seeded TODOs", () => {
  const rows = world()
  expect(designTodoByNumber(rows, 9)?.id).toBe("t-retry")
  expect(designTodoByNumber(rows, 99)).toBeUndefined()
  expect(designTodoNumber(designTodoByNumber(rows, 11)!)).toBe(11)
})
