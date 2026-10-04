import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, test } from "vitest"
import { FACTORY_PROJECTION_PATH, FactoryProjectionSchema, featuredFlows, ruleFlows } from "../src/FactoryProjection.ts"

/*
 * The projection contract the Dispatcher card and the home pane read signed
 * out and the projection target writes: the declaration's own field names,
 * catalog rows with the declared summary, rows in the event vocabulary with
 * a flow id or a list of them and an optional sentence, and the GitHub
 * policy pair. The repository's own projected .smithers/factory.json
 * (written by `//:factoryProjection` from .smithers/FACTORY.ts) has to parse
 * here so the declaring schema in @smthrs/targets and this wire schema never
 * drift apart on a real file.
 */

const repositoryProjection = NodePath.resolve(import.meta.dirname, "../../../.smithers/factory.json")

const review = {
  id: "review",
  description: "Reviews the change.",
  summary: "Review the change.",
  featured: true,
  kind: "mdx",
  path: "flows/review/flow.mdx",
  capabilities: ["fs:read:**"],
  model: null,
  modelInvocable: true
}

describe("the projected .smithers/factory.json of this repository", () => {
  test("parses, features the repository flows first, and declares the day-one rules", () => {
    const projection = FactoryProjectionSchema.parse(JSON.parse(Fs.readFileSync(repositoryProjection, "utf8")))
    expect(featuredFlows(projection).map((flow) => flow.id)).toEqual([
      "review",
      "lint",
      "pr-triage",
      "issue-triage",
      "release-notes",
      "issue-sweep"
    ])
    expect(projection.on.map((rule) => rule.event)).toContain("issue.labeled:todo")
    expect(projection.github?.mirror).toBeDefined()
  })
})

describe("the factory projection", () => {
  test.each([
    { name: "a dispatcher-only projection", projection: { on: [] } },
    { name: "an explicitly empty catalog", projection: { on: [], flows: [] } }
  ])("$name has no featured flows", ({ projection }) => {
    const decoded = FactoryProjectionSchema.parse(projection)
    const before = structuredClone(decoded)
    expect(featuredFlows(decoded)).toEqual([])
    expect(decoded).toEqual(before)
  })

  test("featured rows keep catalog order and a deliberately absent summary", () => {
    const projection = FactoryProjectionSchema.parse({
      on: [],
      flows: [
        { ...review, id: "z-last", summary: null },
        { ...review, id: "hidden", featured: false },
        { ...review, id: "a-first", summary: "Run the checks." }
      ]
    })
    const before = structuredClone(projection)
    expect(featuredFlows(projection)).toEqual([
      { id: "z-last", summary: null },
      { id: "a-first", summary: "Run the checks." }
    ])
    expect(projection).toEqual(before)
  })

  test("lives at .smithers/factory.json", () => {
    expect(FACTORY_PROJECTION_PATH).toBe(".smithers/factory.json")
  })

  test("decodes the day-one table with a flow id or a list per row, and the featured rows", () => {
    const projection = FactoryProjectionSchema.parse({
      summary: "How smithersai/smithers develops itself.",
      flows: [review, { ...review, id: "lint", summary: null, featured: false }],
      github: { mirror: "push", issues: "two-way", changes: "land" },
      on: [
        { event: "issue.opened", flow: "issue", description: "Triage every new issue" },
        { event: "change.landed", flow: ["wiki", "history.fold"] },
        { event: "schedule:0 9 * * 1-5", flow: "review" }
      ]
    })
    expect(projection.on).toHaveLength(3)
    expect(ruleFlows(projection.on[0]!)).toEqual(["issue"])
    expect(ruleFlows(projection.on[1]!)).toEqual(["wiki", "history.fold"])
    expect(featuredFlows(projection)).toEqual([{ id: "review", summary: "Review the change." }])
  })

  test("a schedule row carries its static payload and a non-object payload does not decode", () => {
    const payload = { note: "Traction.md", days: [1, 2], nested: { on: true, none: null } }
    const decoded = FactoryProjectionSchema.parse({
      on: [{ event: "schedule:0 6 * * *", flow: "notes/traction", payload }]
    })
    expect(decoded.on[0]!.payload).toEqual(payload)
    expect(FactoryProjectionSchema.parse({ on: [{ event: "schedule:0 6 * * *", flow: "a" }] }).on[0]).not
      .toHaveProperty("payload")
    for (const bad of ["x", 3, [1], null]) {
      expect(
        FactoryProjectionSchema.safeParse({ on: [{ event: "schedule:0 6 * * *", flow: "a", payload: bad }] }).success
      )
        .toBe(false)
    }
  })

  test("a table alone decodes; an empty flow list, an empty event, a missing table, a bare id row, or a policy outside the pair does not", () => {
    expect(FactoryProjectionSchema.safeParse({ on: [] }).success).toBe(true)
    expect(FactoryProjectionSchema.safeParse({ on: [{ event: "manual", flow: [] }] }).success).toBe(false)
    expect(FactoryProjectionSchema.safeParse({ on: [{ event: "", flow: "issue" }] }).success).toBe(false)
    expect(FactoryProjectionSchema.safeParse({ flows: [review] }).success).toBe(false)
    expect(FactoryProjectionSchema.safeParse({ on: [], flows: ["issue"] }).success).toBe(false)
    expect(
      FactoryProjectionSchema.safeParse({ on: [], github: { mirror: "push-on-land", issues: "read", changes: "none" } })
        .success
    )
      .toBe(false)
  })
})
