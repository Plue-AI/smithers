/**
 * Behavioral projection contract checks for ContextLine.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { ContextLineCardSchema } from "../../src/ContextLineCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/ContextLine.ts"

cardContract("ContextLine", ContextLineCardSchema, fixtures)

// Literal oracle from spec §15.1.2 (preflight candidates) and ui-components.md T-UI-07.
const ITEM_KINDS = ["file", "page", "todo", "run", "issue"] as const
const base = fixtures.expanded.model

describe("context line", () => {
  test.each(ITEM_KINDS)("accepts item kind %s", (kind) => {
    expect(ContextLineCardSchema.safeParse({ ...base, items: [{ ...base.items[0]!, kind }] }).success).toBe(true)
  })
  test.each(["entry", "wiki", "terminal", ""])("rejects retired or unknown item kind %j", (kind) => {
    expect(ContextLineCardSchema.safeParse({ ...base, items: [{ ...base.items[0]!, kind }] }).success).toBe(false)
  })
  test("stories cover every item kind and keep a historical revision", () => {
    expect([...new Set(base.items.map((item) => item.kind))].sort()).toEqual([...ITEM_KINDS].sort())
    expect(ContextLineCardSchema.parse(fixtures.collapsed.model).items[0]?.revision).toBe("head")
  })
  test("an empty line still parses; counts are nonnegative integers", () => {
    expect(ContextLineCardSchema.safeParse({ count: 0, items: [], expanded: false }).success).toBe(true)
    for (const count of [-1, 0.5]) expect(ContextLineCardSchema.safeParse({ ...base, count }).success).toBe(false)
  })
})
