/**
 * Behavioral projection contract checks for Timeline.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { TimelineCardSchema } from "../../src/TimelineCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Timeline.ts"

cardContract("Timeline", TimelineCardSchema, fixtures)

const ENTRY_KINDS = ["prompt", "answer", "card", "event"] as const
const base = fixtures.timeline.model

describe("timeline", () => {
  test("on_screen is exactly the first and last entry ids", () => {
    expect(TimelineCardSchema.parse(base).on_screen).toEqual(["entry-11", "entry-12"])
    for (const on_screen of [[], ["entry-11"], ["entry-11", "entry-12", "entry-13"], ["entry-11", 12]]) {
      expect(TimelineCardSchema.safeParse({ ...base, on_screen }).success, JSON.stringify(on_screen)).toBe(false)
    }
  })
  test("lines cover every entry kind and keep their order", () => {
    expect([...new Set(base.lines.map((line) => line.kind))].sort()).toEqual([...ENTRY_KINDS].sort())
    expect(TimelineCardSchema.parse(base).lines.map((line) => line.entry_id)).toEqual(
      base.lines.map((line) => line.entry_id)
    )
  })
  test.each(["message", ""])("rejects line kind %j", (kind) => {
    expect(TimelineCardSchema.safeParse({ ...base, lines: [{ ...base.lines[0]!, kind }] }).success).toBe(false)
  })
})
