import { describe, expect, test } from "vitest"
import {
  isMythicalMisroute,
  isSettledItemState,
  MYTHICAL_ROUTES,
  MythicalEventSchema,
  MythicalItemSchema,
  MythicalLaneSchema,
  MythicalLaneSubmissionSchema,
  mythicalRoute,
  MythicalStackSchema,
  MythicalWikiSchema
} from "../src/Mythical.ts"

/*
 * The mythical stack snapshot the monitoring UI reads and the backend
 * serves: a stack with one landed bootstrap change, one pending item change,
 * an item in each interesting state, and two lanes.
 */
const snapshot = {
  repository: "smithers-canary/smithers",
  state: "active",
  generation: 42,
  tip: { changeId: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", commitId: "a".repeat(40) },
  landedMain: "b".repeat(40),
  mainBehind: false,
  changes: [
    {
      changeId: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      commitId: "a".repeat(40),
      title: "🐛 fix(app): keep the toast until the job settles",
      kind: "item",
      state: "pending",
      itemId: "item-1",
      issue: 1700,
      predecessor: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk"
    },
    {
      changeId: "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
      commitId: "c".repeat(40),
      title: "✨ feat: earlier work",
      kind: "bootstrap",
      state: "landed"
    }
  ],
  items: [
    {
      id: "item-1",
      issue: { number: 1700, title: "Toast settles early", url: "https://github.com/smithersai/smithers/issues/1700" },
      state: "proposed",
      attempt: 1,
      lane: 0,
      runs: { request: "run-1", vibe: "run-2" },
      plan: { title: "Keep the toast", amends: [], inserts: [], appends: 1 },
      integration: { kind: "rebased" },
      checks: { state: "passed", failed: [] },
      pullRequest: { number: 1801, url: "https://github.com/smithersai/smithers/pull/1801", state: "open" },
      dependsOn: [],
      updatedAt: "2026-09-25T12:00:00Z"
    },
    {
      id: "item-2",
      issue: { number: 1695, title: "Umbrella", url: "https://github.com/smithersai/smithers/issues/1695" },
      state: "skipped",
      reason: "label umbrella",
      attempt: 0,
      runs: {},
      dependsOn: [],
      updatedAt: "2026-09-25T12:00:00Z"
    },
    {
      id: "item-3",
      state: "retrying",
      attempt: 2,
      lane: 1,
      runs: { request: "run-9" },
      todo: { replans: 1, fault: { class: "factory", tag: "coding/Error/stalled" } },
      integration: { conflict: { changeId: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", paths: ["apps/app/src/a.ts"] } },
      dependsOn: ["item-1"],
      updatedAt: "2026-09-25T12:00:00Z"
    }
  ],
  lanes: [
    { index: 0, workspaceId: "ws-0", state: "idle" },
    {
      index: 1,
      workspaceId: "ws-1",
      itemId: "item-3",
      state: "busy",
      startedAt: "2026-09-25T11:53:00Z",
      account: { provider: "claude", label: "work@example.com", count: 2 },
      seat: "opus"
    }
  ],
  limits: { maxParallel: 2 },
  updatedAt: "2026-09-25T12:00:00Z",
  wiki: {
    state: "refreshing",
    commit: "3".repeat(40),
    publishedCommit: "4".repeat(40),
    publishedAt: "2026-09-25T11:00:00Z",
    pages: 5,
    edited: 1,
    attempt: 1,
    runId: "run-wiki"
  }
}

describe("the mythical stack contract", () => {
  test("a snapshot with every section decodes unchanged", () => {
    expect(MythicalStackSchema.parse(snapshot)).toEqual(snapshot)
    expect(
      MythicalStackSchema.parse({
        ...snapshot,
        generation: snapshot.generation,
        updatedAt: "2026-09-25T12:00:00.123456Z"
      }).changes.map((change) => change.state)
    ).toEqual(["pending", "landed"])
  })

  test("an absent stack is an empty snapshot, not an error", () => {
    const absent = MythicalStackSchema.parse({
      repository: "o/r",
      state: "absent",
      generation: 0,
      mainBehind: false,
      changes: [],
      items: [],
      lanes: [],
      limits: { maxParallel: 2 }
    })
    expect(absent.tip).toBeUndefined()
  })

  test("factory reconciliation remains visible apart from stack progress", () => {
    for (const factoryState of ["reconciled", "skipped", "failed", "empty"] as const) {
      const receipt = {
        ...snapshot,
        state: "active" as const,
        factoryState,
        factoryError: "owner workspace unavailable"
      }
      expect(MythicalStackSchema.parse(receipt)).toMatchObject({
        state: "active",
        factoryState,
        factoryError: "owner workspace unavailable"
      })
    }
    expect(MythicalStackSchema.safeParse({ ...snapshot, factoryState: "complete" }).success).toBe(false)
  })

  test("a lane's account decodes without its label for a reader, and never as an unknown provider", () => {
    const lane = {
      index: 0,
      state: "busy",
      startedAt: "2026-09-25T11:53:00Z",
      account: { provider: "codex", count: 1 },
      seat: "luna"
    }
    expect(MythicalLaneSchema.parse(lane)).toEqual(lane)
    expect(MythicalLaneSchema.safeParse({ ...lane, account: { provider: "gemini", count: 1 } }).success).toBe(false)
    expect(MythicalLaneSchema.safeParse({ ...lane, account: { provider: "codex", count: 0 } }).success).toBe(false)
    expect(MythicalLaneSchema.safeParse({ ...lane, startedAt: "a while ago" }).success).toBe(false)
  })

  test("a TODO's progress decodes, and an unknown fault class is refused", () => {
    const continuing = { ...snapshot.items[2], todo: { replans: 2, veryHard: true } }
    expect(MythicalItemSchema.parse(continuing).todo).toEqual({ replans: 2, veryHard: true })
    const unknown = { ...snapshot.items[2], todo: { replans: 0, fault: { class: "network", tag: "x" } } }
    expect(MythicalItemSchema.safeParse(unknown).success).toBe(false)
    expect(MythicalItemSchema.safeParse({ ...snapshot.items[2], todo: { replans: -1 } }).success).toBe(false)
  })

  test("a TODO's metrics decode: its route, a person's take-over and its cost", () => {
    const measured = {
      ...snapshot.items[2],
      route: { as: "close", landed: "change" },
      humanEdited: true,
      costNanos: 15_000_000
    }
    const item = MythicalItemSchema.parse(measured)
    expect([item.route, item.humanEdited, item.costNanos]).toEqual([
      { as: "close", landed: "change" },
      true,
      15_000_000
    ])
    expect(MythicalItemSchema.safeParse({ ...measured, route: { as: "refactor" } }).success).toBe(false)
    expect(MythicalItemSchema.safeParse({ ...measured, costNanos: -1 }).success).toBe(false)
  })

  test("a misroute is a close that landed a change or an implement or bug that closed, never an unsettled one", () => {
    expect(isMythicalMisroute({ as: "close", landed: "change" })).toBe(true)
    expect(isMythicalMisroute({ as: "implement", landed: "close" })).toBe(true)
    expect(isMythicalMisroute({ as: "bug", landed: "close" })).toBe(true)
    expect(isMythicalMisroute({ as: "feature", landed: "close" })).toBe(false)
    expect(isMythicalMisroute({ as: "feature", landed: "change" })).toBe(false)
    expect(isMythicalMisroute({ as: "close", landed: "close" })).toBe(false)
    expect(isMythicalMisroute({ as: "bug", landed: "change" })).toBe(false)
    expect(isMythicalMisroute({ as: "close" })).toBe(false)
  })

  test("decodes an unknown item state as unknown", () => {
    const future = { ...snapshot, items: [{ ...snapshot.items[0], state: "future_state" }, ...snapshot.items.slice(1)] }
    const decoded = MythicalStackSchema.parse(future)
    expect(decoded.items[0]).toEqual({ ...snapshot.items[0], state: "unknown" })
    expect(decoded.items.slice(1)).toEqual(snapshot.items.slice(1))
    expect(isSettledItemState("unknown")).toBe(false)
    expect(MythicalItemSchema.safeParse({ ...snapshot.items[0], state: 42 }).success).toBe(false)
  })

  test("future stack, change and wiki states decode without losing the snapshot", () => {
    const decoded = MythicalStackSchema.parse({
      ...snapshot,
      state: "future_state",
      changes: [{ ...snapshot.changes[0], kind: "future_kind" }, ...snapshot.changes.slice(1)],
      wiki: { state: "future_wiki", pages: 2, edited: 1, attempt: 0 }
    })
    expect(decoded.state).toBe("unknown")
    expect(decoded.changes[0]).toEqual({ ...snapshot.changes[0], kind: "unknown" })
    expect(decoded.changes[1]).toEqual(snapshot.changes[1])
    expect(decoded.wiki).toEqual({ state: "unknown", pages: 2, edited: 1, attempt: 0 })
  })

  test("event hints and lane submissions decode", () => {
    expect(MythicalEventSchema.parse({ generation: 3, kind: "item", itemId: "item-1" }).kind).toBe("item")
    const submission = {
      workspaceId: "0b2f3c1e-4c7a-4a6e-9d7e-2f3a1b4c5d6e",
      base: "1".repeat(40),
      source: "2".repeat(40),
      requestRunId: "run-1",
      summary: "🐛 fix: settle the toast with the job"
    }
    expect(MythicalLaneSubmissionSchema.parse(submission)).toEqual(submission)
    expect(MythicalLaneSubmissionSchema.safeParse({ ...submission, source: "HEAD" }).success).toBe(false)
  })

  test("the wiki decodes known states unchanged and maps future states to unknown", () => {
    for (const state of ["refreshing", "current", "stale", "failed"]) {
      expect(MythicalWikiSchema.parse({ state, pages: 0, edited: 0, attempt: 0 }).state).toBe(state)
    }
    expect(MythicalWikiSchema.parse({ state: "future_state", pages: 0, edited: 0, attempt: 0 }).state).toBe("unknown")
    expect(mythicalRoute("wiki", "o", "r")).toBe("/api/repos/o/r/mythical/wiki")
    expect(mythicalRoute("todos", "o", "r")).toBe("/api/repos/o/r/mythical/todos")
  })

  test("routes fill owner, repository and item", () => {
    expect(mythicalRoute("stack", "smithers-canary", "smithers")).toBe("/api/repos/smithers-canary/smithers/mythical")
    expect(mythicalRoute("retry", "o", "r", "item 1")).toBe("/api/repos/o/r/mythical/items/item%201/retry")
    expect(mythicalRoute("item", "o", "r", "12")).toBe("/api/repos/o/r/mythical/items/12")
    for (const route of Object.values(MYTHICAL_ROUTES)) {
      expect(route.startsWith("/api/repos/{owner}/{repo}/mythical")).toBe(true)
    }
  })

  test("settled states are the ones nothing moves without a person or a new event", () => {
    expect(
      ["skipped", "declined", "cancelled", "landed", "rejected", "blocked"].every((state) =>
        isSettledItemState(state as never)
      )
    ).toBe(true)
    expect(isSettledItemState("proposed")).toBe(false)
  })
})
