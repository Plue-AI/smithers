import { describe, expect, test } from "bun:test"
import { validFeature } from "./fixtures.ts"
import { codeRefSchema, featureSchema, featuresSchema, mockStepRefSchema, parseCodeRef, parseMockStepRef } from "./schema.ts"

describe("featureSchema", () => {
  test("accepts the contract's example entry", () => {
    expect(featureSchema.parse(validFeature)).toEqual(validFeature as never)
  })

  test("accepts a not-implemented entry with no proof", () => {
    expect(featureSchema.safeParse({ ...validFeature, status: "not-implemented", proof: [], gap: "No recorded run." }).success).toBe(true)
  })

  test.each([
    ["an unknown key", { ...validFeature, owner: "maya" }],
    ["a missing gap", (({ gap: _gap, ...rest }) => rest)(validFeature)],
    ["a partial status", { ...validFeature, status: "partial" }],
    ["a non-kebab id", { ...validFeature, id: "J1_merge" }],
    ["a double dash id", { ...validFeature, id: "j1--merge" }],
    ["an empty title", { ...validFeature, title: "" }],
    ["a journey with spaces", { ...validFeature, journey: "J 1" }],
    ["a zero mock step", { ...validFeature, mockSteps: ["j1#0"] }],
    ["a mock step with no number", { ...validFeature, mockSteps: ["j1"] }],
    ["an absolute docs path", { ...validFeature, docs: ["/etc/passwd"] }],
    ["a docs path that climbs", { ...validFeature, docs: ["docs/../../secret.md"] }],
    ["a backwards line range", { ...validFeature, code: ["a.go#L9-L3"] }],
    ["a single-line anchor", { ...validFeature, code: ["a.go#L9"] }],
    ["line zero", { ...validFeature, code: ["a.go#L0-L3"] }],
    ["a proof with an extra key", { ...validFeature, proof: [{ file: "a.spec.ts", step: "x", line: 3 }] }],
    ["a proof step that is not an id", { ...validFeature, proof: [{ file: "a.spec.ts", step: "Merge it" }] }],
    ["a two-line gap", { ...validFeature, gap: "one\ntwo" }]
  ])("refuses %s", (_name, entry) => {
    expect(featureSchema.safeParse(entry).success).toBe(false)
  })

  test("featuresSchema is an array of entries", () => {
    expect(featuresSchema.safeParse([validFeature]).success).toBe(true)
    expect(featuresSchema.safeParse(validFeature).success).toBe(false)
  })
})

describe("references", () => {
  test("parseCodeRef splits a path and its range", () => {
    expect(parseCodeRef("a/b.go#L3-L9")).toEqual({ path: "a/b.go", range: { start: 3, end: 9 } })
    expect(parseCodeRef("a/b.go")).toEqual({ path: "a/b.go" })
  })

  test("codeRefSchema accepts a one-line range", () => {
    expect(codeRefSchema.safeParse("a.go#L4-L4").success).toBe(true)
  })

  test("parseMockStepRef splits a journey file and a 1-based step", () => {
    expect(parseMockStepRef("j10#15")).toEqual({ journey: "j10", n: 15 })
    expect(mockStepRefSchema.safeParse("run#1").success).toBe(true)
  })
})
