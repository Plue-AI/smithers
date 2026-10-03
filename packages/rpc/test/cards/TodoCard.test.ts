/**
 * Behavioral projection contract checks for Todo.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { TodoCardSchema } from "../../src/TodoCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Todo.ts"

cardContract("Todo", TodoCardSchema, fixtures)

// Literal oracles (spec §4.1, §10.8.0): a weakened enum in the schema fails here, not only in derived mutations.
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

describe("TODO state", () => {
  test.each(TODO_STATES)("accepts %s", (state) => {
    expect(TodoCardSchema.parse({ ...fixtures.working, state }).state).toBe(state)
  })
  test.each(["", "unknown", "draft", "needs-you", "in-review", "Working", "blocked", "landed", "cancelled", 3])(
    "rejects %j",
    (state) => {
      expect(TodoCardSchema.safeParse({ ...fixtures.working, state }).success).toBe(false)
    }
  )
  test("fixtures cover all nine states and both waits at once", () => {
    expect([...new Set(Object.values(fixtures).map((todo) => todo.state))].sort()).toEqual([...TODO_STATES].sort())
    expect(fixtures.two_waits.waits).toHaveLength(2)
  })
})

describe("TODO open waits, steers and rebase", () => {
  const wait = fixtures.needs_you.waits[0]!
  test.each(WAIT_KINDS)("accepts a %s wait", (kind) => {
    expect(TodoCardSchema.parse({ ...fixtures.needs_you, waits: [{ ...wait, kind }] }).waits[0]!.kind).toBe(kind)
  })
  test.each(["order", "force_push", "pause", "sleep", "signal", "Question", ""])("rejects a %j wait", (kind) => {
    expect(TodoCardSchema.safeParse({ ...fixtures.needs_you, waits: [{ ...wait, kind }] }).success).toBe(false)
  })
  test("keeps independent waits in order, each with its own id and action", () => {
    const parsed = TodoCardSchema.parse(fixtures.two_waits)
    expect(parsed.waits.map(({ id, kind, actions }) => ({ id, kind, actions: actions.map((a) => [a.tag, a.args]) })))
      .toEqual([
        { id: "wait-conflict-1", kind: "conflict", actions: [["branch", { name: "todo/12" }]] },
        { id: "wait-question-1", kind: "question", actions: [["todo.answer", { n: "12", wait: "wait-question-1" }]] }
      ])
  })
  test("each wait requires its id, kind, prompt, since and actions", () => {
    for (const key of ["id", "kind", "prompt", "since", "actions"] as const) {
      const { [key]: _removed, ...rest } = wait
      expect(TodoCardSchema.safeParse({ ...fixtures.needs_you, waits: [rest] }).success, key).toBe(false)
    }
  })
  test("waits and steers are required lists; the single needs_you object is gone", () => {
    const { waits: _waits, ...noWaits } = fixtures.needs_you
    const { steers: _steers, ...noSteers } = fixtures.steered
    expect(TodoCardSchema.safeParse(noWaits).success).toBe(false)
    expect(TodoCardSchema.safeParse(noSteers).success).toBe(false)
    const legacy = { ...fixtures.working, needs_you: { kind: "question", prompt: "Old?", since: "t" } }
    expect(TodoCardSchema.parse(legacy)).not.toHaveProperty("needs_you")
  })
  test("steers keep their authors and order", () => {
    expect(TodoCardSchema.parse(fixtures.steered).steers.map(({ text, by }) => [text, by.kind])).toEqual([
      ["Keep the S3 fields optional", "person"],
      ["Name the fixture after the state", "agent"]
    ])
  })
  test("rebase_pending names what it rebases onto and refuses the old boolean", () => {
    expect(TodoCardSchema.parse(fixtures.rebase_pending).rebase_pending).toEqual({ onto: "T8" })
    expect(TodoCardSchema.safeParse({ ...fixtures.working, rebase_pending: true }).success).toBe(false)
    expect(TodoCardSchema.safeParse({ ...fixtures.working, rebase_pending: {} }).success).toBe(false)
  })
})

describe("TODO merge wait and numeric boundaries", () => {
  test("reserves the merge id for a trailing wait, never an ordinary labeled step", () => {
    const base = TodoCardSchema.parse(fixtures.queued)
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
    const base = TodoCardSchema.parse(fixtures.queued)
    for (const value of [1, 0, -1, 0.5]) {
      expect(TodoCardSchema.safeParse({ ...base, [field]: value }).success).toBe(value === 1)
    }
  })
  test.each(["lessons"] as const)(
    "%s allows zero and refuses negative/fractional counts",
    (field) => {
      const base = TodoCardSchema.parse(fixtures.queued)
      for (const value of [0, 1, -1, 0.5]) {
        expect(TodoCardSchema.safeParse({ ...base, [field]: value }).success).toBe(value === 0 || value === 1)
      }
    }
  )
  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "ftp://example.com"])(
    "rejects unsafe TODO links %s",
    (url) => {
      const base = TodoCardSchema.parse(fixtures.in_review)
      expect(TodoCardSchema.safeParse({ ...base, issue: { ...base.issue!, url } }).success).toBe(false)
      expect(TodoCardSchema.safeParse({ ...base, pr: { ...base.pr!, url } }).success).toBe(false)
      expect(
        TodoCardSchema.safeParse({
          ...base,
          evidence: [{ attempt: 1, revision: "r1", items: [{ kind: "test", label: "Result", url }] }]
        }).success
      ).toBe(false)
      expect(TodoCardSchema.safeParse({ ...base, owner: { ...base.owner, avatar_url: url } }).success).toBe(false)
    }
  )
})
