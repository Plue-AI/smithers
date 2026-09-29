import { describe, expect, test } from "vitest"
import {
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

  test("an unknown item state is refused rather than rendered as something else", () => {
    const bad = { ...snapshot, items: [{ ...snapshot.items[0], state: "done" }] }
    expect(MythicalStackSchema.safeParse(bad).success).toBe(false)
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

  test("the wiki decodes in each state and refuses any other", () => {
    for (const state of ["refreshing", "current", "stale", "failed"]) {
      expect(MythicalWikiSchema.parse({ state, pages: 0, edited: 0, attempt: 0 }).state).toBe(state)
    }
    expect(MythicalWikiSchema.safeParse({ state: "done", pages: 0, edited: 0, attempt: 0 }).success).toBe(false)
    expect(mythicalRoute("wiki", "o", "r")).toBe("/api/repos/o/r/mythical/wiki")
  })

  test("routes fill owner, repository and item", () => {
    expect(mythicalRoute("stack", "smithers-canary", "smithers")).toBe("/api/repos/smithers-canary/smithers/mythical")
    expect(mythicalRoute("retry", "o", "r", "item 1")).toBe("/api/repos/o/r/mythical/items/item%201/retry")
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
