/**
 * Behavioral projection contract checks for Draft.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { DraftCardSchema } from "../../src/DraftCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Draft.ts"

cardContract("Draft", DraftCardSchema, fixtures)

// Literal oracle: spec §14.3 Draft place modes.
const PLACE_MODES = ["append", "before", "amend"] as const
const append = fixtures.append.model

describe("Draft placement", () => {
  test("stories cover every place mode", () => {
    expect([...new Set(Object.values(fixtures).map((story) => story.model.place.mode))].sort()).toEqual(
      [...PLACE_MODES].sort()
    )
  })
  test.each(["after", "insert", "Append", ""])("refuses place mode %j", (mode) => {
    expect(DraftCardSchema.safeParse({ ...append, place: { ...append.place, mode } }).success).toBe(false)
  })
  test.each(["before", "amend"] as const)("%s needs the TODO it places against", (mode) => {
    expect(DraftCardSchema.safeParse({ ...append, place: { mode, options: [] } }).success).toBe(false)
    expect(DraftCardSchema.parse({ ...append, place: { mode, n: 8, options: [] } }).place).toEqual({
      mode,
      n: 8,
      options: []
    })
  })
  test.each(["merged", "dropped"])("offers unmerged items only, never a %s one", (state) => {
    const options = [{ n: 3, title: "Old", state }]
    expect(DraftCardSchema.safeParse({ ...append, place: { mode: "append", options } }).success).toBe(false)
  })
})

describe("Draft issue, seed and commit", () => {
  test("an issue says whether merging closes it", () => {
    expect(DraftCardSchema.parse(fixtures.issue_fixes.model).issue?.fixes).toBe(true)
    expect(DraftCardSchema.parse(fixtures.issue_without_fixes.model).issue?.fixes).toBe(false)
  })
  test("keeps the seed files and commit receipts", () => {
    expect(DraftCardSchema.parse(fixtures.seed.model).seed?.files).toEqual([
      "packages/rpc/src/TodoCard.ts",
      "packages/rpc/test/fixtures/Todo.ts"
    ])
    expect(DraftCardSchema.parse(fixtures.committed.model).committed).toEqual({ n: 12, rev: 1 })
    expect(DraftCardSchema.parse(fixtures.committed_amendment.model).committed).toEqual({ n: 9, rev: 2 })
  })
  test("a draft stays private until Commit and a committed draft has no Commit", () => {
    expect(fixtures.append.model.private).toBe(true)
    expect([fixtures.committed.model.private, fixtures.committed_amendment.model.private]).toEqual([false, false])
    expect([...fixtures.committed.actions, ...fixtures.committed_amendment.actions]).toEqual([])
  })
  test("uncommitted drafts send field edits through the set gesture", () => {
    expect(fixtures.append.gestures.set).toEqual({ tag: "form.set", label: "Edit", args: { entry: "entry-draft-1" } })
  })
  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "ftp://example.com"])(
    "refuses unsafe issue URL %s",
    (url) => {
      const base = fixtures.issue_fixes.model
      expect(DraftCardSchema.safeParse({ ...base, issue: { ...base.issue!, url } }).success).toBe(false)
    }
  )
})
