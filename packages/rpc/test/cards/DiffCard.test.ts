/**
 * Behavioral projection contract checks for Diff.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { type DiffCard, DiffCardSchema } from "../../src/DiffCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Diff.ts"

cardContract("Diff", DiffCardSchema, fixtures)

// Literal oracles from ui-components.md v0.4 T-UI-11; never read from the schema.
const AGAINST_KINDS = ["item_base", "fork", "burst"] as const
const CHANGES = ["added", "modified", "deleted", "renamed"] as const
const OPS = [" ", "+", "-"] as const
const base = () => structuredClone(fixtures.item_base.model)

describe("Diff vocabularies", () => {
  test("stories cover every against kind and change kind, and a binary diff", () => {
    const models = Object.values(fixtures).map((story) => story.model)
    expect([...new Set(models.map((diff) => diff.against.kind))].sort()).toEqual([...AGAINST_KINDS].sort())
    expect([...new Set(models.map((diff) => diff.change))].sort()).toEqual([...CHANGES].sort())
    expect(models.some((diff) => diff.binary !== undefined)).toBe(true)
  })
  test.each(["", "main", "base", "item"])("rejects against kind %j", (kind) => {
    expect(DiffCardSchema.safeParse({ ...base(), against: { kind, rev: "r" } }).success).toBe(false)
  })
  test.each(["", "changed", "copied", "moved"])("rejects change %j", (change) => {
    expect(DiffCardSchema.safeParse({ ...base(), change }).success).toBe(false)
  })
  test.each(OPS)("accepts line op %j", (op) => {
    expect(
      DiffCardSchema.safeParse({ ...base(), hunks: [{ old_start: 1, new_start: 1, lines: [{ op, text: "x" }] }] })
        .success
    ).toBe(true)
  })
  test.each(["", "~", "!", "++"])("rejects line op %j", (op) => {
    expect(
      DiffCardSchema.safeParse({ ...base(), hunks: [{ old_start: 1, new_start: 1, lines: [{ op, text: "x" }] }] })
        .success
    ).toBe(false)
  })
})

describe("Diff behavior", () => {
  test("a burst names its burst, author and time; a revision base names its revision", () => {
    expect(DiffCardSchema.parse(fixtures.burst.model).against).toMatchObject({ kind: "burst", burst: "burst-17" })
    expect(DiffCardSchema.safeParse({ ...base(), against: { kind: "burst", rev: "r" } }).success).toBe(false)
    expect(DiffCardSchema.safeParse({ ...base(), against: { kind: "fork" } }).success).toBe(false)
  })
  test("Restore this file is offered only on the burst story", () => {
    for (const [name, story] of Object.entries(fixtures)) {
      const restores = story.actions.filter((action) => action.tag === "file.restore")
      expect(restores.length, name).toBe(story.model.against.kind === "burst" ? 1 : 0)
    }
  })
  test("renamed_to belongs to a rename", () => {
    expect(DiffCardSchema.parse(fixtures.renamed.model).renamed_to).toBe("flows/todo-next/flow.ts")
    expect(DiffCardSchema.safeParse({ ...base(), renamed_to: "elsewhere.ts" }).success).toBe(false)
  })
  test("hunk starts allow 0 for an added or deleted side and refuse negatives", () => {
    for (const [start, valid] of [[0, true], [1, true], [-1, false], [1.5, false]] as const) {
      const hunk = { old_start: start, new_start: 1, lines: [] }
      expect(DiffCardSchema.safeParse({ ...base(), hunks: [hunk] }).success, String(start)).toBe(valid)
    }
  })
  test("binary sizes reject negatives", () => {
    expect(DiffCardSchema.safeParse({ ...base(), binary: { before_bytes: -1, after_bytes: 1 } }).success).toBe(false)
  })
  test("the frozen base string and hunk header are not the contract", () => {
    const { against: _against, ...legacy } = base()
    expect(DiffCardSchema.safeParse({ ...legacy, base: "4bc79ae" }).success).toBe(false)
  })
})

// Library review (smithers-38): a Diff model carries enough to write a unified patch. The counts in each hunk
// header come from its lines, so the model needs no separate header field.
const unifiedPatch = (diff: DiffCard): string => {
  const from = diff.change === "added" ? "/dev/null" : `a/${diff.path}`
  const to = diff.change === "deleted" ? "/dev/null" : `b/${diff.renamed_to ?? diff.path}`
  const hunks = diff.hunks.map(({ old_start, new_start, lines }) => {
    const old = lines.filter((line) => line.op !== "+").length
    const next = lines.filter((line) => line.op !== "-").length
    return [`@@ -${old_start},${old} +${new_start},${next} @@`, ...lines.map((line) => `${line.op}${line.text}`)]
  })
  return [`--- ${from}`, `+++ ${to}`, ...hunks.flat()].join("\n") + "\n"
}

describe("Diff as a unified patch", () => {
  test("a modified file", () => {
    expect(unifiedPatch(DiffCardSchema.parse(fixtures.item_base.model))).toBe(
      [
        "--- a/flows/todo/flow.ts",
        "+++ b/flows/todo/flow.ts",
        "@@ -2,2 +2,2 @@",
        " export default Flow.make(\"todo\", {",
        "-  description: \"Build\",",
        "+  description: \"Complete one TODO\","
      ].join("\n") + "\n"
    )
  })
  test("an added and a deleted file use /dev/null and a zero start", () => {
    expect(unifiedPatch(DiffCardSchema.parse(fixtures.fork.model))).toBe(
      ["--- /dev/null", "+++ b/flows/todo/flow.ts", "@@ -0,0 +1,1 @@", "+export const repro = true"].join("\n") + "\n"
    )
    expect(unifiedPatch(DiffCardSchema.parse(fixtures.deleted.model))).toBe(
      ["--- a/flows/todo/flow.ts", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-export const legacy = true"].join("\n") + "\n"
    )
  })
})
