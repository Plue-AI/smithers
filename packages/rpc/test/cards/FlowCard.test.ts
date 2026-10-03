/**
 * Behavioral projection contract checks for Flow.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { FlowCardSchema } from "../../src/FlowCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Flow.ts"

cardContract("Flow", FlowCardSchema, fixtures)

describe("Flow merge wait", () => {
  test("reserves merge for the wait with rebase and steer signals", () => {
    const base = FlowCardSchema.parse(fixtures.active)
    const invalid = structuredClone(base)
    invalid.versions[0]!.steps = [{ id: "merge", label: "Merge" }]
    expect(FlowCardSchema.safeParse(invalid).success).toBe(false)
    const valid = structuredClone(base)
    valid.versions[0]!.steps = [{
      id: "merge",
      wait: true,
      signals: [{ on: "rebase", to: "check" }, { on: "steer", to: "implement" }]
    }]
    expect(FlowCardSchema.safeParse(valid).success).toBe(true)
  })
})
