/**
 * The structured-output boundary: what the model is told, what is extracted
 * from its answer, and what a miss reports.
 */
import * as Digest from "@smthrs/core/Digest"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as StructuredOutput from "../src/StructuredOutput.ts"

const Review = Schema.Struct({
  approved: Schema.Boolean,
  issues: Schema.Array(Schema.String)
})

const attempt = { corrections: 0, limit: 1 }

const decode = <A>(schema: Schema.Codec<A>, text: string) =>
  Effect.runSync(Effect.result(StructuredOutput.decode(schema, text, attempt)))

describe("StructuredOutput.instructions", () => {
  it("renders the declared schema as JSON Schema in the teaching", () => {
    const text = StructuredOutput.instructions(Review)
    expect(text).toContain("Required output shape")
    expect(text).toContain("\"approved\"")
    expect(text).toContain("\"issues\"")
  })

  it("adds no definitions section to a schema that introduces none", () => {
    expect(JSON.stringify(StructuredOutput.jsonSchema(Review))).not.toContain("$defs")
  })

  it("names the call that finishes a cell and never a returned transition", () => {
    const text = StructuredOutput.instructions(Review)
    expect(text).toContain("ctx.done(output)")
    expect(text).not.toContain("intent: \"complete\"")
    expect(text).not.toContain("return {")
  })

  it("asks for the value itself rather than a JSON string", () => {
    const text = StructuredOutput.instructions(Review)
    expect(text).toContain("JavaScript\nvalue")
    expect(text).toContain("Do not stringify it")
    expect(text).not.toContain("JSON document")
  })

  it("renders a schema with no fields at all", () => {
    expect(StructuredOutput.instructions(Schema.Struct({}))).toContain("Required output shape")
  })

  it("inlines definitions a suspended schema introduces", () => {
    interface Chain {
      readonly label: string
      readonly next: Chain | null
    }
    const Chain = Schema.Struct({
      label: Schema.String,
      next: Schema.suspend((): Schema.Codec<Chain | null> => Schema.NullOr(Chain))
    })
    expect(JSON.stringify(StructuredOutput.jsonSchema(Chain))).toContain("$defs")
  })
})

describe("StructuredOutput.digest", () => {
  it("names one boundary for two declarations that render the same shape", () => {
    expect(StructuredOutput.digest(Review)).toBe(
      StructuredOutput.digest(Schema.Struct({ approved: Schema.Boolean, issues: Schema.Array(Schema.String) }))
    )
    expect(StructuredOutput.digest(Review)).not.toBe(StructuredOutput.digest(Schema.String))
  })
})

describe("StructuredOutput.issuesDigest", () => {
  const issue = (
    path: string,
    message: string,
    code: StructuredOutput.OutputIssueCode = "invalid_type"
  ) => new StructuredOutput.OutputIssue({ code, path, message })
  const failure = (issues: ReadonlyArray<StructuredOutput.OutputIssue>) =>
    new StructuredOutput.StructuredOutputFailure({
      code: "schema_mismatch",
      schema: "sha256:schema",
      candidate: "sha256:candidate",
      corrections: 1,
      limit: 2,
      issues,
      message: "did not validate"
    })

  it("says whether two rejections were wrong in the same way", () => {
    expect(StructuredOutput.issuesDigest(failure([issue("approved", "expected boolean")]))).toBe(
      StructuredOutput.issuesDigest(failure([issue("approved", "expected boolean")]))
    )
    expect(StructuredOutput.issuesDigest(failure([issue("approved", "expected boolean")]))).not.toBe(
      StructuredOutput.issuesDigest(failure([issue("issues", "expected array")]))
    )
    // Order is part of what the validator said, so it is part of the digest.
    expect(StructuredOutput.issuesDigest(failure([issue("", "a"), issue("", "b")]))).not.toBe(
      StructuredOutput.issuesDigest(failure([issue("", "b"), issue("", "a")]))
    )
    expect(StructuredOutput.issuesDigest(failure([issue("left", "same")]))).not.toBe(
      StructuredOutput.issuesDigest(failure([issue("right", "same")]))
    )
    expect(StructuredOutput.issuesDigest(failure([issue("same", "same", "invalid_type")]))).toBe(
      StructuredOutput.issuesDigest(failure([issue("same", "same", "constraint")]))
    )
  })
})

describe("StructuredOutput.lastBalanced", () => {
  it("returns the container whose matching close ends last", () => {
    expect(StructuredOutput.lastBalanced("{\"a\":1} then {\"b\":2}")).toBe("{\"b\":2}")
  })

  it("scans arrays as well as objects", () => {
    expect(StructuredOutput.lastBalanced("prose [1, 2, [3]] tail")).toBe("[1, 2, [3]]")
  })

  it("ignores delimiters inside quoted strings and escapes", () => {
    expect(StructuredOutput.lastBalanced("{\"a\":\"}{\\\"\"}")).toBe("{\"a\":\"}{\\\"\"}")
  })

  it("abandons a container a mismatched close would misreport", () => {
    expect(StructuredOutput.lastBalanced("{\"a\": [1}")).toBeUndefined()
    expect(StructuredOutput.lastBalanced("{\"a\": [1]}")).toBe("{\"a\": [1]}")
  })

  it("ignores a close with no opener, and reports nothing for prose", () => {
    expect(StructuredOutput.lastBalanced("} nothing opened")).toBeUndefined()
    expect(StructuredOutput.lastBalanced("plain prose")).toBeUndefined()
  })

  it("does not open a string outside a container", () => {
    expect(StructuredOutput.lastBalanced("\"a quote\" then {\"b\":2}")).toBe("{\"b\":2}")
  })

  it("reports nothing for an empty answer and the container itself for a bare one", () => {
    expect(StructuredOutput.lastBalanced("")).toBeUndefined()
    expect(StructuredOutput.lastBalanced("{}")).toBe("{}")
    expect(StructuredOutput.lastBalanced("[]")).toBe("[]")
    expect(StructuredOutput.lastBalanced("{\"a\":{\"b\":[1]}}")).toBe("{\"a\":{\"b\":[1]}}")
  })

  it("reports nothing for a container the answer never closed", () => {
    expect(StructuredOutput.lastBalanced("{\"a\": [1]")).toBeUndefined()
    expect(StructuredOutput.lastBalanced("{\"a\": \"unclosed}")).toBeUndefined()
    expect(StructuredOutput.lastBalanced("[1, 2")).toBeUndefined()
  })

  it("keeps an earlier complete container when a later one is malformed", () => {
    // The mismatched close abandons only the container it broke, so the answer
    // still offers the last container that actually closed.
    expect(StructuredOutput.lastBalanced("{\"a\":1} then [2}")).toBe("{\"a\":1}")
    expect(StructuredOutput.lastBalanced("{\"a\":1}}")).toBe("{\"a\":1}")
  })
})

describe("StructuredOutput.candidates", () => {
  it("offers the whole answer alone when it already is the container", () => {
    expect(StructuredOutput.candidates(" {\"a\":1} ")).toEqual(["{\"a\":1}"])
  })

  it("offers the whole answer first, then the extracted container", () => {
    expect(StructuredOutput.candidates("here: {\"a\":1}")).toEqual(["here: {\"a\":1}", "{\"a\":1}"])
  })

  it("offers the trimmed answer alone when it holds no container", () => {
    expect(StructuredOutput.candidates("")).toEqual([""])
    expect(StructuredOutput.candidates("   \n ")).toEqual([""])
    expect(StructuredOutput.candidates("no JSON here")).toEqual(["no JSON here"])
  })

  it("strips a byte-order mark before deciding what the answer is", () => {
    expect(StructuredOutput.candidates("﻿{\"a\":1}")).toEqual(["{\"a\":1}"])
    expect(StructuredOutput.candidates("﻿here: {\"a\":1}")).toEqual(["here: {\"a\":1}", "{\"a\":1}"])
  })
})

describe("StructuredOutput.decode completion values", () => {
  const decodeValue = <A>(schema: Schema.Codec<A>, value: Schema.Json) =>
    Effect.runSync(Effect.result(StructuredOutput.decode(
      schema,
      typeof value === "string" ? value : JSON.stringify(value),
      attempt,
      value
    )))

  it.each(["12", "true", "null", "\"hello\"", "", " 12 ", 12, true, false, null])(
    "preserves the completion's original type and contents (%j)",
    (value) => {
      const schema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])
      const result = decodeValue(schema, value)
      expect(result._tag === "Success" ? result.success : undefined).toBe(value)
    }
  )

  it.each(["", "12", "\"x\""])("reports a string refinement on the original value (%j)", (value) => {
    const result = decodeValue(Schema.String.check(Schema.isMinLength(4)), value)
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.code).toBe("schema_mismatch")
    expect(failure?.issues).toEqual([
      { code: "constraint", path: "", message: "Expected a value with a length of at least 4" }
    ])
  })

  it.each([12, true, false, null, [], {}])(
    "never renders a nonstring completion into an accepted string (%j)",
    (value) => {
      const result = decodeValue(Schema.String, value)
      const failure = result._tag === "Failure" ? result.failure : undefined
      expect(failure?.code).toBe("schema_mismatch")
      expect(failure?.issues[0]).toMatchObject({ code: "invalid_type", path: "", message: "Expected string" })
    }
  )

  it("retains text extraction for a string completion whose schema expects an object", () => {
    const result = decodeValue(Review, "Review: {\"approved\":true,\"issues\":[]}")
    expect(result._tag === "Success" ? result.success : undefined).toEqual({ approved: true, issues: [] })
  })

  it("decodes structured completion values directly", () => {
    const value = { approved: true, issues: [] }
    const result = decodeValue(Review, value)
    expect(result._tag === "Success" ? result.success : undefined).toEqual(value)
  })
})

describe("StructuredOutput.decode", () => {
  it("takes a raw answer as the string a string schema declares", () => {
    const result = decode(Schema.String, "Looks fine to me.")
    expect(result._tag === "Success" ? result.success : undefined).toBe("Looks fine to me.")
  })

  it("keeps a raw string answer exactly as written, including an empty one", () => {
    const spaced = decode(Schema.String, "  two spaces  ")
    expect(spaced._tag === "Success" ? spaced.success : undefined).toBe("  two spaces  ")
    const empty = decode(Schema.String, "")
    expect(empty._tag === "Success" ? empty.success : undefined).toBe("")
  })

  it("takes a raw answer that parses as another JSON value as a string", () => {
    const result = decode(Schema.String, "123")
    expect(result._tag === "Success" ? result.success : undefined).toBe("123")
  })

  it("reads a JSON string literal as the string it quotes, never with its quotes", () => {
    const quoted = decode(Schema.String, "\"hi\"")
    expect(quoted._tag === "Success" ? quoted.success : undefined).toBe("hi")
    const short = decode(Schema.String.check(Schema.isMinLength(3)), "\"x\"")
    expect(short._tag).toBe("Failure")
  })

  it("reports a raw string the schema refused on its merits, not the JSON parse", () => {
    const result = decode(Schema.String.check(Schema.isMinLength(3)), "x")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.code).toBe("schema_mismatch")
    expect(failure?.issues[0]).toMatchObject({
      code: "constraint",
      message: "Expected a value with a length of at least 3"
    })
  })

  it("never offers a raw answer to a schema that refuses strings", () => {
    const result = decode(Review, "Looks fine to me.")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.code).toBe("invalid_json")
  })

  it("decodes a bare document", () => {
    const result = decode(Review, "{\"approved\":true,\"issues\":[]}")
    expect(result._tag === "Success" ? result.success : undefined).toEqual({ approved: true, issues: [] })
  })

  it("strips a byte-order mark before parsing", () => {
    const result = decode(Review, "﻿{\"approved\":true,\"issues\":[]}")
    expect(result._tag).toBe("Success")
  })

  it("decodes a document wrapped in prose", () => {
    const result = decode(Review, "Sure:\n\n{\"approved\":false,\"issues\":[\"x\"]}\n\nDone.")
    expect(result._tag === "Success" ? result.success : undefined).toEqual({ approved: false, issues: ["x"] })
  })

  it("accepts a non-object root when the schema declares one", () => {
    const result = decode(Schema.Array(Schema.Number), "the answer is [1,2,3]")
    expect(result._tag === "Success" ? result.success : undefined).toEqual([1, 2, 3])
  })

  it("reports a typed failure with bounded diagnostics when nothing validates", () => {
    const result = decode(Review, "Looks fine to me.")
    expect(result._tag).toBe("Failure")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?._tag).toBe("/harness/StructuredOutputFailure")
    expect(failure?.code).toBe("invalid_json")
    expect(failure?.schema).toBe(StructuredOutput.digest(Review))
    expect(failure?.corrections).toBe(0)
    expect(failure?.limit).toBe(1)
    expect(failure?.issues.length).toBeGreaterThan(0)
    expect(failure?.issues.length).toBeLessThanOrEqual(StructuredOutput.maxIssues)
  })

  it("classifies invalid JSON issues without changing their path or message", () => {
    const result = decode(Review, "not JSON")
    const failure = result._tag === "Failure" ? result.failure : undefined

    expect(failure?.issues).toEqual([
      {
        code: "invalid_json",
        path: "",
        message: "Unexpected token 'o', \"not JSON\" is not valid JSON"
      }
    ])
  })

  it("reports the extracted container's issues when the whole answer is not JSON", () => {
    const result = decode(Review, "Verdict: {\"approved\":\"yes\"}")
    expect(result._tag).toBe("Failure")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.code).toBe("schema_mismatch")
    expect(failure?.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")).toContain("approved")
  })

  it("renders a correction that restates only the diagnostics", () => {
    const result = decode(Review, "Looks fine to me.")
    const failure = result._tag === "Failure" ? result.failure : undefined
    const text = StructuredOutput.correction(failure!)
    expect(text).toContain("did not validate")
    expect(text).toContain(failure!.issues[0]!.message)
    expect(text).toContain("ctx.done(output)")
  })

  it("reports an empty answer as a miss digested on the empty candidate", () => {
    const result = decode(Review, "")

    expect(result._tag).toBe("Failure")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.code).toBe("no_candidate")
    expect(failure?.candidate).toBe(Digest.digest(""))
    expect(failure?.issues.length).toBeGreaterThan(0)
  })

  it("classifies the empty answer's seed issue without changing its prose", () => {
    const result = decode(Review, "")
    const failure = result._tag === "Failure" ? result.failure : undefined

    expect(failure?.issues).toEqual([
      { code: "no_candidate", path: "", message: "the answer held no JSON document" }
    ])
  })

  it("digests the extracted container, not the prose the model wrapped it in", () => {
    const result = decode(Review, "Verdict: {\"approved\":\"yes\"}")

    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.candidate).toBe(Digest.digest("{\"approved\":\"yes\"}"))
  })

  it("lets the container that closes last decide, even when an earlier one would validate", () => {
    const result = decode(
      Review,
      "First I thought {\"approved\":true,\"issues\":[]} but really {\"approved\":\"maybe\"}"
    )

    // Only two candidates are ever offered — the whole answer and the last
    // balanced container — so an earlier valid document is not rescued.
    expect(result._tag).toBe("Failure")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.code).toBe("schema_mismatch")
    expect(failure?.candidate).toBe(Digest.digest("{\"approved\":\"maybe\"}"))
    expect(failure?.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")).toContain("approved")
  })

  it("caps the reported issues at the declared maximum", () => {
    const Wide = Schema.String.pipe(
      Schema.check(
        Schema.makeFilter(() =>
          ["a", "b", "c", "d", "e", "f"].map((path) => ({
            path: [path],
            issue: `invalid ${path}`
          }))
        )
      )
    )

    const result = decode(Wide, "\"wrong\"")

    expect(result._tag).toBe("Failure")
    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.issues).toHaveLength(StructuredOutput.maxIssues)
    expect(failure?.issues.map((issue) => issue.path)).toEqual(["a", "b", "c", "d", "e"])
    expect(StructuredOutput.correction(failure!).split("\n- ")).toHaveLength(StructuredOutput.maxIssues + 1)
  })

  it("decodes an empty document against a schema that declares no fields", () => {
    const result = decode(Schema.Struct({}), "{}")

    expect(result._tag === "Success" ? result.success : undefined).toEqual({})
  })

  it("decodes a deeply nested document extracted from prose", () => {
    const Nested = Schema.Struct({
      outer: Schema.Struct({
        middle: Schema.Struct({
          inner: Schema.Array(Schema.Struct({ leaf: Schema.Number }))
        })
      })
    })

    const result = decode(Nested, "Here you go:\n{\"outer\":{\"middle\":{\"inner\":[{\"leaf\":1},{\"leaf\":2}]}}}\n")

    expect(result._tag === "Success" ? result.success : undefined).toEqual({
      outer: { middle: { inner: [{ leaf: 1 }, { leaf: 2 }] } }
    })
  })

  it("reports a nested schema mismatch with its dot-joined path", () => {
    const Nested = Schema.Struct({ outer: Schema.Struct({ count: Schema.Number }) })

    const result = decode(Nested, "{\"outer\":{\"count\":\"many\"}}")
    const failure = result._tag === "Failure" ? result.failure : undefined

    expect(failure?.code).toBe("schema_mismatch")
    expect(failure?.issues[0]).toMatchObject({ path: "outer.count", message: expect.stringContaining("number") })
    expect(StructuredOutput.correction(failure!)).toContain("outer.count")
  })

  it("classifies a missing struct field without changing its path or message", () => {
    const result = decode(Schema.Struct({ name: Schema.String }), "{}")
    const failure = result._tag === "Failure" ? result.failure : undefined

    expect(failure?.issues[0]).toMatchObject({ code: "missing_key", path: "name", message: "Missing key" })
  })

  it("classifies a field of the wrong type without changing its path or message", () => {
    const result = decode(Schema.Struct({ name: Schema.String }), "{\"name\":1}")
    const failure = result._tag === "Failure" ? result.failure : undefined

    expect(failure?.issues[0]).toMatchObject({ code: "invalid_type", path: "name", message: "Expected string" })
  })

  it("classifies a refinement failure without changing its path or message", () => {
    const NonEmpty = Schema.String.check(Schema.isMinLength(3))
    const result = decode(NonEmpty, "\"x\"")
    const failure = result._tag === "Failure" ? result.failure : undefined

    expect(failure?.issues[0]).toMatchObject({
      code: "constraint",
      path: "",
      message: "Expected a value with a length of at least 3"
    })
  })

  it("reports a root schema mismatch with an empty path", () => {
    const result = decode(Schema.Number, "\"many\"")
    const failure = result._tag === "Failure" ? result.failure : undefined

    expect(failure?.code).toBe("schema_mismatch")
    expect(failure?.issues[0]).toMatchObject({ path: "", message: expect.stringContaining("number") })
  })

  it("uses bracket notation for an array member in an issue path", () => {
    const Nested = Schema.Struct({ items: Schema.Array(Schema.Struct({ count: Schema.Number })) })

    const result = decode(Nested, "{\"items\":[{\"count\":\"many\"}]}")
    const failure = result._tag === "Failure" ? result.failure : undefined

    expect(failure?.issues[0]?.path).toBe("items[0].count")
  })

  it("bounds each structured issue message", () => {
    const detail = "x".repeat(600)
    const Detailed = Schema.String.pipe(Schema.check(Schema.makeFilter(() => detail)))

    const result = decode(Detailed, "\"wrong\"")
    const failure = result._tag === "Failure" ? result.failure : undefined
    const message = failure?.issues[0]?.message

    expect(message).toContain("reissue the answer to see the whole issue")
    expect(message?.length).toBeLessThan(340)
  })

  it("reports the correction budget the boundary was declared with", () => {
    const result = Effect.runSync(
      Effect.result(StructuredOutput.decode(Review, "still prose", { corrections: 2, limit: 2 }))
    )

    const failure = result._tag === "Failure" ? result.failure : undefined
    expect(failure?.code).toBe("correction_exhausted")
    expect(failure?.corrections).toBe(2)
    expect(failure?.limit).toBe(2)
    expect(failure?.message).toContain("after 2 of 2 corrections")
  })
})
