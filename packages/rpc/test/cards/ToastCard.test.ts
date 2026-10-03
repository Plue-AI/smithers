/**
 * Behavioral projection contract checks for Toast, ToastStack and EdgeMap.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { EdgeMapCardSchema, ToastCardSchema, ToastStackCardSchema } from "../../src/ToastCard.ts"
import { cardContract } from "../cardContract.ts"
import { edgeMaps, fixtures, stacks } from "../fixtures/Toast.ts"

cardContract("Toast", ToastCardSchema, fixtures)
cardContract("ToastStack", ToastStackCardSchema, stacks)
cardContract("EdgeMap", EdgeMapCardSchema, edgeMaps)

// Literal oracle from ui-components.md T-UI-08 and spec §14.4.
const TOAST_KINDS = [
  "needs_you",
  "approval",
  "in_review",
  "failed",
  "conflict",
  "merged",
  "progress",
  "allow_notifications"
] as const
const toast = fixtures.needs_you.model

describe("toasts", () => {
  test.each(TOAST_KINDS)("accepts kind %s", (kind) => {
    expect(ToastCardSchema.parse({ ...toast, kind }).kind).toBe(kind)
  })
  test.each(["needs-you", "review", "info", "notification", ""])("rejects kind %j", (kind) => {
    expect(ToastCardSchema.safeParse({ ...toast, kind }).success).toBe(false)
  })
  test("stories cover every kind", () => {
    expect([...new Set(Object.values(fixtures).map((story) => story.model.kind))].sort()).toEqual(
      [...TOAST_KINDS].sort()
    )
  })
  test("keeps a durable detail and links back to its entry", () => {
    const parsed = ToastCardSchema.parse(fixtures.no_action.model)
    expect([parsed.detail, parsed.entry_id]).toEqual(["Checks passed", "entry-done"])
  })
})

describe("toast stack", () => {
  test("holds the hidden toasts too, and more counts them (ui-components.md T-UI-08)", () => {
    const stack = stacks.three_and_more.model
    expect(ToastStackCardSchema.parse(stack).toasts).toHaveLength(5)
    expect(ToastStackCardSchema.parse(stack).more).toBe(2)
    for (const more of [-1, 0.5]) expect(ToastStackCardSchema.safeParse({ ...stack, more }).success).toBe(false)
  })
})

describe("edge map", () => {
  test("stories cover both widths", () => {
    expect(Object.values(edgeMaps).map((story) => story.model.narrow).sort()).toEqual([false, false, true])
  })
  test("keeps above and below apart, in order", () => {
    const parsed = EdgeMapCardSchema.parse(edgeMaps.wide.model)
    expect([parsed.above.map((t) => t.id), parsed.below.map((t) => t.id)]).toEqual([
      ["toast-12", "toast-progress", "toast-review"],
      ["toast-failed"]
    ])
  })
})
