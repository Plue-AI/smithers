import { describe, expect, test } from "bun:test"
import { renderMockSteps } from "./mock-steps.ts"
import { fixtureFiles, fixtureMock, fixtureRepo, validFeature } from "./fixtures.ts"
import { type IssueKind, validateFeatures, validateMockSteps } from "./validate.ts"

const kinds = (entries: unknown, files = fixtureFiles) => validateFeatures(entries, fixtureRepo(files), fixtureMock).map(issue => issue.kind)

describe("validateFeatures", () => {
  test("passes a valid registry", () => {
    expect(kinds([validFeature])).toEqual([])
  })

  test("passes an empty registry", () => {
    expect(kinds([])).toEqual([])
  })

  const cases: ReadonlyArray<[IssueKind, unknown]> = [
    ["schema", { not: "an array" }],
    ["schema", [{ ...validFeature, status: "partial" }]],
    ["duplicate-id", [validFeature, { ...validFeature, title: "Again" }]],
    ["mock-step-missing", [{ ...validFeature, mockSteps: ["j1#31"] }]],
    ["mock-step-missing", [{ ...validFeature, mockSteps: ["j99#1"] }]],
    ["proof-file-missing", [{ ...validFeature, proof: [{ file: "apps/app/e2e/proof/j2.spec.ts", step: "j1-merge-in-app" }] }]],
    ["proof-step-missing", [{ ...validFeature, proof: [{ file: "apps/app/e2e/proof/j1.spec.ts", step: "j1-other" }] }]],
    ["implemented-without-proof", [{ ...validFeature, proof: [] }]],
    ["code-path-missing", [{ ...validFeature, code: ["packages/backend/internal/routes/gone.go#L1-L2"] }]],
    ["code-path-missing", [{ ...validFeature, code: ["packages/backend/internal/routes/gone.go"] }]],
    ["code-range-out-of-bounds", [{ ...validFeature, code: ["packages/backend/internal/routes/todos.go#L290-L301"] }]],
    ["docs-path-missing", [{ ...validFeature, docs: ["packages/backend/docs/gone.md#heading"] }]],
    ["spec-path-missing", [{ ...validFeature, spec: ".specs/product/gone.md#j1" }]],
    ["gap-missing", [{ ...validFeature, status: "not-implemented", proof: [], gap: " " }]],
    ["gap-on-implemented", [{ ...validFeature, gap: "Still flaky." }]]
  ]
  test.each(cases)("reports %s", (kind, entries) => {
    expect(kinds(entries)).toEqual([kind])
  })

  test("a range ending on the last line passes", () => {
    expect(kinds([{ ...validFeature, code: ["packages/backend/internal/routes/todos.go#L1-L300"] }])).toEqual([])
  })

  test("a file with no trailing newline counts its last line", () => {
    const files = { ...fixtureFiles, "a.go": "one\ntwo" }
    expect(kinds([{ ...validFeature, code: ["a.go#L2-L2"] }], files)).toEqual([])
    expect(kinds([{ ...validFeature, code: ["a.go#L3-L3"] }], files)).toEqual(["code-range-out-of-bounds"])
  })

  test("reports every issue of a feature, each naming the feature", () => {
    const issues = validateFeatures([{ ...validFeature, docs: ["x.md"], code: ["y.go"], mockSteps: ["j1#99"] }], fixtureRepo(fixtureFiles), fixtureMock)
    expect(issues.map(issue => issue.kind).sort()).toEqual(["code-path-missing", "docs-path-missing", "mock-step-missing"])
    expect(issues.every(issue => issue.id === "j1-merge-in-app" && issue.message.startsWith("j1-merge-in-app: "))).toBe(true)
  })

  test("a duplicated id is reported once per repeat", () => {
    expect(kinds([validFeature, validFeature, validFeature])).toEqual(["duplicate-id", "duplicate-id"])
  })
})

describe("validateMockSteps", () => {
  test("passes when the committed file renders the same", () => {
    expect(validateMockSteps(renderMockSteps(fixtureMock), fixtureMock)).toEqual([])
  })

  test("reports a stale or missing file", () => {
    expect(validateMockSteps("[]\n", fixtureMock).map(issue => issue.kind)).toEqual(["mock-steps-stale"])
    expect(validateMockSteps(undefined, fixtureMock).map(issue => issue.kind)).toEqual(["mock-steps-stale"])
  })
})
