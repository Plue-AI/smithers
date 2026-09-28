import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { describe, expect, it } from "vitest"
import { firstPath } from "../src/IssuePath.ts"

/** The `SchemaError` a decode or encode of `schema` throws for `input`. */
const errorOf = (run: () => unknown): Schema.SchemaError => {
  try {
    run()
  } catch (error) {
    if (Schema.isSchemaError(error)) return error
    throw error
  }
  throw new Error("expected the schema to reject the input")
}

describe("firstPath", () => {
  it("renders object keys with a dot and array indices with brackets", () => {
    const nested = Schema.Struct({ a: Schema.Struct({ b: Schema.Array(Schema.Number) }) })
    expect(firstPath(errorOf(() => Schema.decodeUnknownSync(nested)({ a: { b: [1, "x"] } })))).toBe("$.a.b[1]")
  })

  it("stops at the first leaf without rendering the rejected value", () => {
    const error = errorOf(() =>
      Schema.decodeUnknownSync(Schema.Struct({ secret: Schema.Number }))({ secret: "hunter2" })
    )
    const path = firstPath(error)
    expect(path).toBe("$.secret")
    expect(path).not.toContain("hunter2")
  })

  it("returns the root for a leaf issue carrying no path", () => {
    expect(firstPath(errorOf(() => Schema.decodeUnknownSync(Schema.String)(1)))).toBe("$")
  })

  it("descends through a failed refinement", () => {
    // `FiniteFromString` parses, then checks finiteness: Composite -> Filter -> leaf.
    const filtered = Schema.Struct({ count: Schema.FiniteFromString })
    expect(firstPath(errorOf(() => Schema.decodeUnknownSync(filtered)({ count: "abc" })))).toBe("$.count")
  })

  it("descends through a failed transformation", () => {
    // Encoding a non-finite number back to a string fails inside the
    // transformation itself, which reports an `Encoding` issue.
    const document = Schema.Struct({ doc: Schema.FiniteFromString })
    expect(firstPath(errorOf(() => Schema.encodeUnknownSync(document)({ doc: Infinity })))).toBe("$.doc")
  })

  it("follows the first branch of a union that matched no member", () => {
    const union = Schema.Union([Schema.Struct({ a: Schema.String }), Schema.Struct({ b: Schema.Number })])
    expect(firstPath(errorOf(() => Schema.decodeUnknownSync(union)({ a: 1 })))).toBe("$.a")
  })

  it("returns the accumulated path when a branching issue carries no children", () => {
    // A union of primitives reports the no-match as an `AnyOf` with no child issues.
    const union = Schema.Union([Schema.String, Schema.Number])
    expect(firstPath(errorOf(() => Schema.decodeUnknownSync(union)(true)))).toBe("$")
    const nested = Schema.Struct({ field: union })
    expect(firstPath(errorOf(() => Schema.decodeUnknownSync(nested)({ field: true })))).toBe("$.field")
  })

  it("stops after 64 levels so a pathological issue tree cannot run unbounded", () => {
    let issue: SchemaIssue.Issue = new SchemaIssue.InvalidType(Schema.String.ast)
    for (let depth = 0; depth < 100; depth++) issue = new SchemaIssue.Pointer([`level${depth}`], issue)
    const path = firstPath(new Schema.SchemaError(issue))
    expect(path.split(".").slice(1)).toHaveLength(64)
    expect(path.startsWith("$.level99.level98.")).toBe(true)
  })

  it("quotes a key that would otherwise read as a different field", () => {
    const spoofing = Schema.Record(Schema.String, Schema.Number)
    const error = errorOf(() => Schema.decodeUnknownSync(spoofing)({ "admin.role": "x" }))
    expect(firstPath(error)).toBe("$[\"admin.role\"]")
    const bracket = errorOf(() => Schema.decodeUnknownSync(spoofing)({ "a[0]": "x" }))
    expect(firstPath(bracket)).toBe("$[\"a[0]\"]")
  })

  it("renders a symbol key in brackets", () => {
    const issue = new SchemaIssue.Pointer([Symbol.for("k")], new SchemaIssue.InvalidType(Schema.String.ast))
    expect(firstPath(new Schema.SchemaError(issue))).toBe("$[Symbol(k)]")
  })
})
