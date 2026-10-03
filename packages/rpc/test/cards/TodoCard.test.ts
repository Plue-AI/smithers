/**
 * Behavioral projection contract checks for Todo.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { TodoCardSchema } from "../../src/TodoCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Todo.ts"

cardContract("Todo", TodoCardSchema, fixtures)

// Literal oracles (spec §4.1, §10.8.0, §10.4.3): a weakened enum in the schema fails here, not only in derived
// mutations.
const TODO_STATES = [
  "queued",
  "starting",
  "working",
  "needs_you",
  "paused",
  "failed",
  "in_review",
  "merged",
  "dropped"
] as const
const WAIT_KINDS = ["question", "approval", "conflict", "moved_off", "foreign_push"] as const
const MERGE_STATES = ["ready", "waiting", "blocked", "merging", "done"] as const
const QUEUE_REASONS = ["machine", "merge_order", "rebase", "daily_limit"] as const
const PAUSE_REASONS = ["person", "daily_token_budget"] as const
const model = (name: keyof typeof fixtures) => TodoCardSchema.parse(fixtures[name].model)

describe("TODO state", () => {
  test.each(TODO_STATES)("accepts %s", (state) => {
    expect(TodoCardSchema.parse({ ...fixtures.working.model, state }).state).toBe(state)
  })
  test.each(["", "unknown", "draft", "needs-you", "in-review", "Working", "blocked", "landed", "cancelled", 3])(
    "rejects %j",
    (state) => {
      expect(TodoCardSchema.safeParse({ ...fixtures.working.model, state }).success).toBe(false)
    }
  )
  test("stories cover all nine states, every merge state and two open waits at once", () => {
    const models = Object.values(fixtures).map((story) => story.model)
    expect([...new Set(models.map((todo) => todo.state))].sort()).toEqual([...TODO_STATES].sort())
    expect([...new Set(models.map((todo) => todo.merge.state))].sort()).toEqual([...MERGE_STATES].sort())
    expect(fixtures.two_waits.model.waits).toHaveLength(2)
  })
})

describe("TODO open waits, steers and rebase", () => {
  const wait = fixtures.needs_you.model.waits[0]!
  test.each(WAIT_KINDS)("accepts a %s wait", (kind) => {
    expect(TodoCardSchema.parse({ ...fixtures.needs_you.model, waits: [{ ...wait, kind }] }).waits[0]!.kind).toBe(kind)
  })
  test.each(["order", "force_push", "pause", "sleep", "signal", "Question", ""])("rejects a %j wait", (kind) => {
    expect(TodoCardSchema.safeParse({ ...fixtures.needs_you.model, waits: [{ ...wait, kind }] }).success).toBe(false)
  })
  test("keeps independent waits in order, each with its own id and action", () => {
    expect(
      model("two_waits").waits.map(({ id, kind, actions }) => ({
        id,
        kind,
        actions: actions.map((action) => [action.tag, action.args])
      }))
    ).toEqual([
      { id: "wait-conflict-1", kind: "conflict", actions: [["branch", { name: "todo/12" }]] },
      { id: "wait-question-1", kind: "question", actions: [["todo.answer", { n: "12", wait: "wait-question-1" }]] }
    ])
  })
  test("each wait requires its id, kind, prompt, since and actions", () => {
    for (const key of ["id", "kind", "prompt", "since", "actions"] as const) {
      const { [key]: _removed, ...rest } = wait
      expect(TodoCardSchema.safeParse({ ...fixtures.needs_you.model, waits: [rest] }).success, key).toBe(false)
    }
  })
  test("waits and steers are required lists; the single needs_you object is gone", () => {
    const { waits: _waits, ...noWaits } = fixtures.needs_you.model
    const { steers: _steers, ...noSteers } = fixtures.steered.model
    expect(TodoCardSchema.safeParse(noWaits).success).toBe(false)
    expect(TodoCardSchema.safeParse(noSteers).success).toBe(false)
    const legacy = { ...fixtures.working.model, needs_you: { kind: "question", prompt: "Old?", since: "t" } }
    expect(TodoCardSchema.parse(legacy)).not.toHaveProperty("needs_you")
  })
  test("steers keep their authors and order", () => {
    expect(model("steered").steers.map(({ text, by }) => [text, by.kind])).toEqual([
      ["Keep the S3 fields optional", "person"],
      ["Name the fixture after the state", "agent"]
    ])
  })
  test("rebase_pending names what it rebases onto and refuses the old boolean", () => {
    expect(model("rebase_pending").rebase_pending).toEqual({ onto: "T8" })
    expect(TodoCardSchema.safeParse({ ...fixtures.working.model, rebase_pending: true }).success).toBe(false)
    expect(TodoCardSchema.safeParse({ ...fixtures.working.model, rebase_pending: {} }).success).toBe(false)
  })
})

describe("TODO evidence items", () => {
  const evidence = (items: unknown[]) => ({
    ...fixtures.in_review.model,
    evidence: [{ attempt: 1, revision: "r", items }]
  })
  test("a failed and a passing required GitHub check keep their distinguishing fields", () => {
    const checks = model("failed").evidence.flatMap((attempt) => attempt.items)
      .filter((item) => item.kind === "github_check")
      .map((item) => [item.name, item.state, item.required])
    expect(checks).toEqual([["required-ci", "passed", true], ["required-ci", "failed", true], [
      "preview",
      "pending",
      false
    ]])
  })
  test.each(["diff", "check", "github_check", "review", "usage", "flow", "model_access"])(
    "fixtures carry a %s item",
    (kind) => {
      const kinds = Object.values(fixtures).flatMap((story) =>
        story.model.evidence.flatMap((attempt) => attempt.items.map((item) => item.kind))
      )
      expect(kinds).toContain(kind)
    }
  )
  test.each(["test", "log", "label", "github", ""])("rejects free-form evidence kind %j", (kind) => {
    expect(TodoCardSchema.safeParse(evidence([{ kind, label: "Result" }])).success).toBe(false)
  })
  test.each(
    [
      ["check", ["running", "passed", "failed"], ["pending", "passing", "failing", "unknown"]],
      ["github_check", ["pending", "passed", "failed"], ["running", "passing", "failing", "unknown"]]
    ] as const
  )("%s states", (kind, valid, invalid) => {
    const item = { kind, name: "ci", required: true, url: "https://github.com/smithersai/smithers/actions/runs/1" }
    for (const state of valid) expect(TodoCardSchema.safeParse(evidence([{ ...item, state }])).success).toBe(true)
    for (const state of invalid) expect(TodoCardSchema.safeParse(evidence([{ ...item, state }])).success).toBe(false)
  })
  test("a GitHub check without required or url fails rather than losing data", () => {
    const check = { kind: "github_check", name: "required-ci", state: "failed", required: true, url: "https://x.dev" }
    for (const key of ["required", "url", "name", "state"] as const) {
      const { [key]: _removed, ...rest } = check
      expect(TodoCardSchema.safeParse(evidence([rest])).success, key).toBe(false)
    }
  })
})

describe("TODO merge wait and numeric boundaries", () => {
  test("reserves the merge id for a trailing wait, never an ordinary labeled step", () => {
    const base = model("queued")
    expect(TodoCardSchema.safeParse({ ...base, steps: [{ id: "merge", label: "Merge", state: "next" }] }).success).toBe(
      false
    )
    expect(
      TodoCardSchema.safeParse({
        ...base,
        steps: [{ id: "merge", kind: "wait", state: "held", since: "2026-10-02T00:00:00Z" }]
      }).success
    ).toBe(true)
  })
  test.each(["n", "place"] as const)("%s requires a positive integer", (field) => {
    const base = model("queued")
    for (const value of [1, 0, -1, 0.5]) {
      expect(TodoCardSchema.safeParse({ ...base, [field]: value }).success).toBe(value === 1)
    }
  })
  test("lessons allows zero and refuses negative/fractional counts", () => {
    const base = model("queued")
    for (const value of [0, 1, -1, 0.5]) {
      expect(TodoCardSchema.safeParse({ ...base, lessons: value }).success).toBe(value === 0 || value === 1)
    }
  })
  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "ftp://example.com"])(
    "rejects unsafe TODO links %s",
    (url) => {
      const base = model("in_review")
      expect(TodoCardSchema.safeParse({ ...base, issue: { ...base.issue!, url } }).success).toBe(false)
      expect(TodoCardSchema.safeParse({ ...base, pr: { ...base.pr!, url } }).success).toBe(false)
      const check = { kind: "github_check", name: "ci", state: "passed", required: true, url }
      expect(TodoCardSchema.safeParse({ ...base, evidence: [{ attempt: 1, revision: "r1", items: [check] }] }).success)
        .toBe(false)
      expect(TodoCardSchema.safeParse({ ...base, owner: { ...base.owner, avatar_url: url } }).success).toBe(false)
    }
  )
})

describe("TODO daily limit and pause reason (spec §4.1.1, §10.4.1b, §15.2.2)", () => {
  const queued = fixtures.queued.model
  const paused = fixtures.paused_by_budget.model
  test.each(QUEUE_REASONS)("accepts queue reason %s", (reason) => {
    expect(TodoCardSchema.parse({ ...queued, queue: { reason, position: 1 } }).queue?.reason).toBe(reason)
  })
  test.each(["daily-limit", "daily", "budget", "limit", ""])("rejects queue reason %j", (reason) => {
    expect(TodoCardSchema.safeParse({ ...queued, queue: { reason, position: 1 } }).success).toBe(false)
  })
  test.each(PAUSE_REASONS)("accepts pause reason %s", (reason) => {
    expect(TodoCardSchema.parse({ ...paused, pause: { ...paused.pause!, reason } }).pause?.reason).toBe(reason)
  })
  test.each(["budget", "token_budget", "daily_limit", "stop", ""])("rejects pause reason %j", (reason) => {
    expect(TodoCardSchema.safeParse({ ...paused, pause: { ...paused.pause!, reason } }).success).toBe(false)
  })
  test("a budget pause names the install owner and when it resumes; a person's pause needs neither", () => {
    expect(TodoCardSchema.parse(paused).pause).toEqual({
      reason: "daily_token_budget",
      owner: { login: "williamcory", name: "Will Cory", avatar_url: paused.owner.avatar_url },
      since: "2026-10-02T17:42:00.000Z",
      resume_at: "2026-10-03T00:00:00.000Z"
    })
    expect(TodoCardSchema.parse(fixtures.paused.model).pause).toEqual({
      reason: "person",
      since: "2026-10-02T17:42:00.000Z"
    })
    const { since: _since, ...noSince } = paused.pause!
    expect(TodoCardSchema.safeParse({ ...paused, pause: noSince }).success).toBe(false)
  })
  test("stories include a daily-limit queue and a budget pause", () => {
    expect(fixtures.queued_daily_limit.model.queue?.reason).toBe("daily_limit")
    expect(fixtures.paused_by_budget.model.pause?.reason).toBe("daily_token_budget")
  })
})
