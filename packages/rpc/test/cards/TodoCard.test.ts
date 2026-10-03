/**
 * Behavioral projection contract checks for Todo.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { TodoCardSchema } from "../../src/TodoCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Todo.ts"

cardContract("Todo", TodoCardSchema, fixtures)

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
