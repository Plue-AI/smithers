/** Retained card fields require an inventory-row spec change before snapshot updates. */
import { describe, expect, test } from "vitest"
import { z } from "zod"
import { CardSchema } from "../../src/Cards.ts"
import { ChangeFindingSchema, ChangeVerdictSchema } from "../../src/Changes.ts"

const retainedKinds = [
  "issue",
  "pr",
  "change",
  "world",
  "wiki-history",
  "wiki-links",
  "wiki-graph",
  "flow-form",
  "browser",
  "flow-plan",
  "run-list",
  "search-results",
  "approval"
] as const

// CardSchema wraps the legacy decoder and exposes its current public options.
// Enumerate kinds through JSON Schema rather than Zod implementation details.
const retained = CardSchema.options.map((schema) => ({ kind: z.toJSONSchema(schema.shape.kind).const, schema }))

describe("retained card JSON Schema contracts (§14.3.0)", () => {
  test.each(retainedKinds)("pins the %s card", (kind) => {
    const matches = retained.filter((card) => card.kind === kind)
    expect(matches, `exactly one retained ${kind} decoder`).toHaveLength(1)
    expect(z.toJSONSchema(matches[0]!.schema)).toMatchSnapshot()
  })

  // The spec calls this ChangeReviewSchema; the existing retained export is
  // ChangeVerdictSchema. Pin that contract without adding a competing schema.
  test("pins ChangeReviewSchema (existing ChangeVerdictSchema)", () => {
    expect(z.toJSONSchema(ChangeVerdictSchema)).toMatchSnapshot()
  })
  test("pins ChangeFindingSchema", () => {
    expect(z.toJSONSchema(ChangeFindingSchema)).toMatchSnapshot()
  })
})
