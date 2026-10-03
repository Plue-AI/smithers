/**
 * Behavioral projection contract checks for File.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { FileCardSchema } from "../../src/FileCard.ts"
import { cardContract } from "../cardContract.ts"
import { person } from "../fixtures/_shared.ts"
import { fixtures } from "../fixtures/File.ts"

cardContract("File", FileCardSchema, fixtures)

// Literal oracles from ui-components.md v0.4 T-UI-11, T-UI-16 and T-UI-19; never read from the schema.
const CONTENT_KINDS = ["text", "too_large", "binary"] as const
const MODES = ["read_only", "live"] as const
const GONE_KINDS = ["deleted", "renamed"] as const
const SAVED = ["saving", "saved"] as const
const model = (name: keyof typeof fixtures) => FileCardSchema.parse(fixtures[name].model)
const text = () => structuredClone(fixtures.text.model)

describe("File vocabularies", () => {
  test("stories cover every content kind, mode, gone kind and saved state", () => {
    const models = Object.values(fixtures).map((story) => story.model)
    expect([...new Set(models.map((file) => file.content.kind))].sort()).toEqual([...CONTENT_KINDS].sort())
    expect([...new Set(models.map((file) => file.mode))].sort()).toEqual([...MODES].sort())
    expect([...new Set(models.flatMap((file) => file.gone ? [file.gone.kind] : []))].sort()).toEqual(
      [...GONE_KINDS].sort()
    )
    expect([...new Set(models.flatMap((file) => file.saved ? [file.saved] : []))].sort()).toEqual([...SAVED].sort())
  })
  test.each(["", "image", "large", "Text"])("rejects content kind %j", (kind) => {
    expect(FileCardSchema.safeParse({ ...text(), content: { kind, text: "x", bytes: 1 } }).success).toBe(false)
  })
  test.each(["", "edit", "read-only", "write"])("rejects mode %j", (mode) => {
    expect(FileCardSchema.safeParse({ ...text(), mode }).success).toBe(false)
  })
  test.each(["stale", "unsaved", ""])("rejects saved state %j", (saved) => {
    expect(FileCardSchema.safeParse({ ...text(), saved }).success).toBe(false)
  })
  test.each(["moved", "missing", ""])("rejects gone kind %j", (kind) => {
    expect(FileCardSchema.safeParse({ ...text(), gone: { kind, by: person, to: "x" } }).success).toBe(false)
  })
})

describe("File content and mode", () => {
  test("only text content opens live", () => {
    expect(FileCardSchema.safeParse({ ...text(), mode: "live" }).success).toBe(true)
    expect(FileCardSchema.safeParse({ ...fixtures.too_large.model, mode: "live" }).success).toBe(false)
    expect(FileCardSchema.safeParse({ ...fixtures.binary.model, mode: "live" }).success).toBe(false)
  })
  test("too large means over 1 MiB, and keeps its text", () => {
    const content = model("too_large").content
    expect(content).toEqual({ kind: "too_large", bytes: 2_400_000, text: "{" })
    for (const [bytes, valid] of [[1_048_577, true], [1_048_576, false], [0, false]] as const) {
      const changed = { ...text(), content: { kind: "too_large", bytes, text: "{" } }
      expect(FileCardSchema.safeParse(changed).success, String(bytes)).toBe(valid)
    }
  })
  test("binary content carries a byte count and no text", () => {
    expect(model("binary").content).toEqual({ kind: "binary", bytes: 18_204 })
    expect(FileCardSchema.safeParse({ ...text(), content: { kind: "binary", bytes: -1 } }).success).toBe(false)
  })
  test("the old free-standing text field is not the contract", () => {
    const { content: _content, ...legacy } = text()
    expect(FileCardSchema.safeParse({ ...legacy, text: "x" }).success).toBe(false)
  })
})

describe("File gestures, hover and reveal", () => {
  test("hover and definition are named gestures on code.hover and code.definition", () => {
    expect(Object.entries(fixtures.text.gestures).map(([name, action]) => [name, action.tag])).toEqual([
      ["hover", "code.hover"],
      ["definition", "code.definition"]
    ])
    expect(fixtures.binary.gestures).toEqual({})
  })
  test("hover and reveal positions are 1-based lines with UTF-16 columns from 0", () => {
    expect(model("hover").hover).toMatchObject({ line: 1, col: 20 })
    expect(model("reveal").reveal).toEqual({ line: 1, col: 15, to_line: 1 })
    for (const [line, col, valid] of [[1, 0, true], [0, 0, false], [1, -1, false], [1.5, 0, false]] as const) {
      const hover = { line, col, markdown: "m" }
      expect(FileCardSchema.safeParse({ ...text(), hover }).success, `${line}:${col}`).toBe(valid)
    }
  })
  test("a cursor line in the view feeds presence", () => {
    expect(fixtures.text.view).toEqual({ maximized: false, line: 1 })
    expect(fixtures.comparing.view.compare).toBe(true)
  })
})

describe("File states and co-editing", () => {
  test("delete and rename keep their attribution", () => {
    expect(model("deleted").gone).toEqual({ kind: "deleted", by: person })
    const renamed = model("renamed")
    expect(renamed.gone).toEqual({ kind: "renamed", to: "flows/todo-next/flow.ts", by: person })
    expect(renamed.branch).toBe("todo/12")
    expect(FileCardSchema.safeParse({ ...text(), gone: { kind: "renamed", by: person } }).success).toBe(false)
  })
  test("outside names the version Compare reads and when it changed", () => {
    expect(model("outside").outside).toEqual({ version: "git:7d1e0c2", at: "2026-10-02T17:42:00.000Z" })
    expect(FileCardSchema.safeParse({ ...text(), outside: { snapshot: "x" } }).success).toBe(false)
  })
  test("authors and editors are actors and required lists, empty before their stage", () => {
    expect(model("text")).toMatchObject({ authors: [], editors: [] })
    expect(model("live").authors.map((actor) => actor.kind)).toEqual(["person", "agent"])
    for (const key of ["authors", "editors"] as const) {
      const { [key]: _removed, ...rest } = text()
      expect(FileCardSchema.safeParse(rest).success, key).toBe(false)
    }
    expect(FileCardSchema.safeParse({ ...text(), authors: [{ actor: person }] }).success).toBe(false)
  })
  test("unsaved counts the lost edits", () => {
    expect(model("unsaved").unsaved?.count).toBe(3)
    for (const count of [0, -1, 1.5]) {
      expect(FileCardSchema.safeParse({ ...text(), unsaved: { count, text: "x" } }).success).toBe(false)
    }
  })
})
