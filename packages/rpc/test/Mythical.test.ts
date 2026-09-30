import { describe, expect, test } from "vitest"
import {
  isMythicalMisroute,
  isSettledItemState,
  MYTHICAL_ROUTES,
  MythicalEventSchema,
  MythicalItemSchema,
  MythicalLaneSchema,
  MythicalLaneSubmissionSchema,
  mythicalMachine,
  type MythicalReceipt,
  mythicalReceiptDuration,
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

  test("a candidate's check receipts decode as the stack service writes them, and an unknown one is refused", () => {
    // The shape of mythical_receipts_test.go's stack view of a failed verification.
    const commit = "d".repeat(40)
    const checks = {
      state: "failed",
      failed: ["affected-test"],
      receipts: [
        { check: "affected-lint", tier: "fast", status: "passed", commit },
        { check: "affected-test", tier: "slow", status: "failed", fault: "infra", commit }
      ]
    }
    const item = { ...snapshot.items[0], checks }
    expect(MythicalItemSchema.parse(item).checks).toEqual(checks)
    const receipt = checks.receipts[0]!
    for (
      const bad of [
        { status: "superseded" },
        { tier: "nightly" },
        { fault: "user" },
        { commit: undefined },
        { runId: "" },
        { durationMs: -1 },
        { durationMs: 1.5 },
        { durationMs: "42" }
      ]
    ) {
      const refused = { ...item, checks: { ...checks, receipts: [{ ...receipt, ...bad }] } }
      expect(MythicalItemSchema.safeParse(refused).success).toBe(false)
    }
  })

  test("a receipt names its run and duration when the stack service has them, and reads without them", () => {
    // mythical_receipts_test.go's view of a timed verification receipt.
    const commit = "e".repeat(40)
    const timed = {
      check: "affected-test",
      tier: "slow",
      status: "failed",
      commit,
      runId: "run-verify-21",
      durationMs: 42_500
    }
    const bare = { check: "affected-lint", tier: "fast", status: "passed", commit }
    const checks = { state: "failed", failed: ["affected-test"], receipts: [bare, timed] }
    const parsed = MythicalItemSchema.parse({ ...snapshot.items[0], checks }).checks!.receipts!
    expect(parsed).toEqual([bare, timed])
    expect(parsed.map(mythicalReceiptDuration)).toEqual([undefined, "42s"])
    expect(
      [0, 999, 59_999, 64_000, 3_600_000].map((durationMs) =>
        mythicalReceiptDuration({ ...bare, durationMs } as MythicalReceipt)
      )
    ).toEqual(["0s", "0s", "59s", "1m 04s", "1h"])
  })

  test("a typed failure decodes as the stack service writes it, and an unknown kind or fault is refused", () => {
    // The shape of mythical_failure_test.go's snapshot of a stopped TODO.
    const failed = { ...snapshot.items[2], state: "blocked", reason: "Smithers could not set up a lane after repeated tries",
      failure: { kind: "provisioning", fault: "infra" } }
    expect(MythicalItemSchema.parse(failed).failure).toEqual(failed.failure)
    for (const failure of [{ kind: "quota", fault: "infra" }, { kind: "model", fault: "provider" }, { kind: "model" }]) {
      expect(MythicalItemSchema.safeParse({ ...failed, failure }).success).toBe(false)
    }
  })

  test("a lane's placement decodes as the stack service writes it, and shows as its machine and image", () => {
    // The receipt mythical_placement_test.go records for a NixOS lane.
    const placed = {
      ...snapshot.items[2],
      placement: {
        declared: {
          revision: "a".repeat(40),
          environment: ".smithers/environment.nix",
          environmentDigest: "d".repeat(64),
          vcpus: 2,
          memoryMiB: 4096,
          tools: ["go"]
        },
        kind: "vm",
        vcpus: 2,
        memoryMiB: 4096,
        imageId: "img-1",
        image: "registry/env:" + "c".repeat(32),
        closureHash: "c".repeat(32),
        imageRevision: "b".repeat(40)
      }
    }
    const decoded = MythicalItemSchema.parse(placed)
    expect(decoded.placement).toEqual(placed.placement)
    expect(mythicalMachine(decoded.placement)).toBe("vm · registry/env:" + "c".repeat(32))
    expect(mythicalMachine({ declared: {}, kind: "container", vcpus: 2, memoryMiB: 4096 })).toBe("container")
    const refused = { declared: { vcpus: 8 }, refusal: "machine_too_small", reason: "it needs 8 vCPUs and lane machines here have 2" }
    expect(MythicalItemSchema.parse({ ...placed, placement: refused }).placement).toEqual(refused)
    expect(mythicalMachine(refused)).toBeUndefined()
    expect(mythicalMachine(undefined)).toBeUndefined()
    expect(MythicalItemSchema.safeParse({ ...placed, placement: { ...placed.placement, vcpus: 0 } }).success).toBe(false)
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
    // A filed TODO names the request that filed it; any other item names none.
    expect(MythicalItemSchema.parse({ ...snapshot.items[0], request: "0a1b2c3d-k9" }).request).toBe("0a1b2c3d-k9")
    expect(MythicalItemSchema.parse(snapshot.items[0]).request).toBeUndefined()
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
