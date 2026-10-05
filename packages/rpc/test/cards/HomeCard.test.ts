/**
 * Behavioral projection contract checks for Home.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { ConfirmCardSchema } from "../../src/ConfirmCard.ts"
import { HomeCardSchema } from "../../src/HomeCard.ts"
import { TodoCardSchema } from "../../src/TodoCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures as confirms } from "../fixtures/Confirm.ts"
import { fixtures } from "../fixtures/Home.ts"
import { fixtures as todos } from "../fixtures/Todo.ts"

cardContract("Home", HomeCardSchema, fixtures)

// Literal oracles from ui-components.md T-UI-06 and spec §4.4; never read from the schema.
const SYNC_HEALTH = ["fresh", "stale", "limited", "refused"] as const
const BACKGROUND_STATES = ["queued", "running", "waiting", "failed"] as const
const ATTENTION_KINDS = ["order", "force_push"] as const
const active = () => HomeCardSchema.parse(fixtures.active.model)

describe("Home enums", () => {
  test("stories cover every sync health, background-run state and attention kind", () => {
    const models = Object.values(fixtures).map((story) => story.model)
    expect([...new Set(models.map((home) => home.main.health))].sort()).toEqual([...SYNC_HEALTH].sort())
    expect(active().background_runs.map((run) => run.state)).toEqual([...BACKGROUND_STATES])
    expect(active().attention.map((row) => row.kind)).toEqual([...ATTENTION_KINDS])
  })
  test.each(["ok", "Fresh", "degraded", "unknown", ""])("rejects main health %j", (health) => {
    const base = fixtures.fresh.model
    expect(HomeCardSchema.safeParse({ ...base, main: { ...base.main, health } }).success).toBe(false)
  })
  test.each(["done", "cancelled", "interrupted", ""])("rejects background state %j", (state) => {
    const base = active()
    const run = { ...base.background_runs[0]!, state }
    expect(HomeCardSchema.safeParse({ ...base, background_runs: [run] }).success).toBe(false)
  })
  test.each(["conflict", "question", "needs_you", ""])("rejects attention kind %j", (kind) => {
    const base = active()
    expect(HomeCardSchema.safeParse({ ...base, attention: [{ ...base.attention[0]!, kind }] }).success).toBe(false)
  })
  test("a row's needs_you carries its kind and prompt; stack attention is not a wait", () => {
    const row = active().items[1]!
    expect(row.needs_you).toEqual({ kind: "question", prompt: "Include S3 fields?" })
    expect(
      HomeCardSchema.safeParse({ ...active(), items: [{ ...row, needs_you: { kind: "order", prompt: "x" } }] }).success
    )
      .toBe(false)
    expect(HomeCardSchema.safeParse({ ...active(), items: [{ ...row, needs_you: { kind: "question" } }] }).success)
      .toBe(false)
  })
  test("attention rows, background runs and stack rows each carry their own actions", () => {
    const home = active()
    expect(home.attention.map((row) => row.actions.map((action) => action.tag))).toEqual([
      ["order.ok"],
      ["main.reset-to-github"]
    ])
    expect(home.background_runs.at(-1)!.actions.map((action) => action.label)).toEqual(["Retry", "Dismiss"])
    expect(home.items[0]!.actions.map((action) => action.label)).toEqual(["Merge", "Move up", "Move down", "Drop"])
  })
})

describe("Home rows share the TODO shape", () => {
  // Re-homed from CoreDataReview "one merge shape on TODO Home and Confirm".
  test.each(["ready", "waiting", "blocked", "merging", "done"])(
    "one %s merge shape on TODO, Home and Confirm",
    (state) => {
      const merge = { state, reason: "pending_work", detail: "Rechecking", on_github: false }
      expect(TodoCardSchema.parse({ ...todos.in_review.model, merge }).merge).toEqual(merge)
      expect(HomeCardSchema.parse({ ...active(), items: [{ ...active().items[0]!, merge }] }).items[0]!.merge)
        .toEqual(merge)
      const review = confirms.review_merge.model.review!
      expect(ConfirmCardSchema.parse({ ...confirms.review_merge.model, review: { ...review, merge } }).review?.merge)
        .toEqual(merge)
    }
  )
  test("a TODO's picked fields parse into a Home row unchanged", () => {
    const todo = TodoCardSchema.parse(todos.rebase_pending.model)
    const picked = {
      n: todo.n,
      title: todo.title,
      state: todo.state,
      owner: todo.owner,
      place: todo.place,
      step: todo.step,
      rebase_pending: todo.rebase_pending,
      merge: todo.merge,
      lessons: todo.lessons
    }
    const row = { ...active().items[0]!, ...picked, approval_cleared: undefined }
    expect(HomeCardSchema.parse({ ...active(), items: [row] }).items[0]).toEqual(row)
    const queued = TodoCardSchema.parse(todos.queued_after.model)
    expect(HomeCardSchema.parse({ ...active(), items: [{ ...row, queue: queued.queue }] }).items[0]!.queue).toEqual({
      reason: "merge_order",
      after: 8,
      position: 2
    })
  })
  // Re-homed from CoreDataReview "Home and TODO use the same branch shape": v0.4 drops the machine from Home rows.
  test("a Home row's branch is the TODO branch without its machine, and presence holds agents", () => {
    const todo = TodoCardSchema.parse(todos.working.model)
    const row = HomeCardSchema.parse({
      ...active(),
      items: [{ ...active().items[0]!, branch: todo.branch, present: todo.present }]
    }).items[0]!
    expect(todo.branch).toBeDefined()
    if (todo.branch === undefined) throw new Error("Working TODO fixture must have a branch")
    expect(row.branch).toEqual({ id: todo.branch.id, name: todo.branch.name })
    expect(row.present.some((actor) => actor.kind === "agent")).toBe(true)
  })
})

describe("Home numeric boundaries", () => {
  test("amendments is a nonnegative integer", () => {
    for (const value of [0, 1, -1, 0.5, NaN, Infinity]) {
      const changed = structuredClone(active())
      changed.items[0]!.amendments = value
      expect(HomeCardSchema.safeParse(changed).success, String(value)).toBe(value === 0 || value === 1)
    }
  })
  test("state counts need every state and accept zero but not negative or fractional counts", () => {
    const base = fixtures.fresh.model
    const { queued: _queued, ...missing } = base.counts
    expect(HomeCardSchema.safeParse({ ...base, counts: missing }).success).toBe(false)
    expect(HomeCardSchema.safeParse({ ...base, machines: { in_use: 0, capacity: 0, slots: [] } }).success).toBe(true)
    for (const value of [-1, 0.5]) {
      expect(HomeCardSchema.safeParse({ ...base, counts: { ...base.counts, queued: value } }).success).toBe(false)
      expect(HomeCardSchema.safeParse({ ...base, machines: { ...base.machines, in_use: value } }).success).toBe(false)
      expect(HomeCardSchema.safeParse({ ...base, machines: { ...base.machines, capacity: value } }).success).toBe(false)
    }
  })
  test("elapsed time accepts zero and fractions but refuses negative and nonfinite values", () => {
    for (const value of [0, 0.25, -1, NaN, Infinity]) {
      const changed = structuredClone(active())
      changed.items[0]!.elapsed_s = value
      expect(HomeCardSchema.safeParse(changed).success, String(value)).toBe(value === 0 || value === 0.25)
    }
  })
  test("parallel permits zero effective capacity when present", () => {
    for (const value of [1, 4, 0, -1, 1.5]) {
      expect(HomeCardSchema.safeParse({ ...active(), parallel: value }).success, String(value)).toBe(
        value >= 0 && value % 1 === 0
      )
    }
  })
})

describe("Home daily limit (spec §4.1.1, §10.4.1b)", () => {
  test("a row queued at the daily limit keeps its reason", () => {
    expect(active().items.find((row) => row.n === 18)?.queue).toEqual({ reason: "daily_limit", position: 1 })
  })
  test.each(["daily-limit", "budget", ""])("rejects queue reason %j", (reason) => {
    const base = active()
    const row = { ...base.items.find((item) => item.n === 18)!, queue: { reason, position: 1 } }
    expect(HomeCardSchema.safeParse({ ...base, items: [row] }).success).toBe(false)
  })
})
