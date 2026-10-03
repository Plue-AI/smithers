/**
 * Behavioral projection contract checks for EntryRow.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { EntryRowCardSchema } from "../../src/EntryRowCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/EntryRow.ts"

cardContract("EntryRow", EntryRowCardSchema, fixtures)

// Literal oracles from spec §14.5.1 and ui-components.md T-UI-07.
const ENTRY_KINDS = ["prompt", "answer", "card", "event"] as const
const TONES = ["live", "attention", "failed", "done", "quiet"] as const
const base = fixtures.prompt.model

describe("entry rows", () => {
  test.each(ENTRY_KINDS)("accepts kind %s", (kind) => {
    expect(EntryRowCardSchema.parse({ ...base, kind }).kind).toBe(kind)
  })
  test.each(["message", "toast", "Prompt", ""])("rejects kind %j", (kind) => {
    expect(EntryRowCardSchema.safeParse({ ...base, kind }).success).toBe(false)
  })
  test.each(TONES)("accepts tone %s", (tone) => {
    expect(EntryRowCardSchema.parse({ ...base, tone }).tone).toBe(tone)
  })
  test.each(["warning", "ok", ""])("rejects tone %j", (tone) => {
    expect(EntryRowCardSchema.safeParse({ ...base, tone }).success).toBe(false)
  })
  test("stories cover every kind and every tone", () => {
    const models = Object.values(fixtures).map((story) => story.model)
    expect([...new Set(models.map((row) => row.kind))].sort()).toEqual([...ENTRY_KINDS].sort())
    expect([...new Set(models.map((row) => row.tone))].sort()).toEqual([...TONES].sort())
  })
  test("an entry with no TODO omits state; null is not a state", () => {
    expect(EntryRowCardSchema.parse(base)).not.toHaveProperty("state")
    expect(EntryRowCardSchema.safeParse({ ...base, state: null }).success).toBe(false)
  })
  test("the row carries no entry id; the timeline line does", () => {
    expect(EntryRowCardSchema.parse({ ...base, entry_id: "entry-12" })).not.toHaveProperty("entry_id")
  })
  test("distinguishes event entries", () => {
    expect(EntryRowCardSchema.parse(fixtures.event.model).kind).toBe("event")
  })
})
