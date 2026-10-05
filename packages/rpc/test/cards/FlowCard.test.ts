/**
 * Behavioral projection contract checks for Flow.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { FlowCardSchema } from "../../src/FlowCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Flow.ts"

cardContract("Flow", FlowCardSchema, fixtures)

// Literal oracle from ui-components.md T-UI-10; never read from the schema.
const VERSION_STATES = ["active", "proposed", "merged-syncing", "merged-failed", "previous"] as const

describe("Flow versions", () => {
  test("stories cover every version state", () => {
    const states = Object.values(fixtures).flatMap((story) => story.model.versions.map((version) => version.state))
    expect([...new Set(states)].sort()).toEqual([...VERSION_STATES].sort())
  })
  // v0.4 reverses the frozen snake_case states (OtherContracts "rejects retired … vocabularies").
  test.each(["merged_syncing", "merged_failed", "draft", "Active", ""])("rejects version state %j", (state) => {
    const base = FlowCardSchema.parse(fixtures.active.model)
    expect(FlowCardSchema.safeParse({ ...base, versions: [{ ...base.versions[0]!, state }] }).success).toBe(false)
  })
  test("a step's agent is its agent's name", () => {
    const base = FlowCardSchema.parse(fixtures.active.model)
    expect(base.versions[0]!.steps.flatMap((step) => "agent" in step ? [step.agent] : [])).toEqual([
      "planner",
      "implementer",
      "reviewer"
    ])
    const invalid = structuredClone(base)
    invalid.versions[0]!.steps = [{ id: "plan", label: "Plan", agent: { name: "planner", model: "sol" } as never }]
    expect(FlowCardSchema.safeParse(invalid).success).toBe(false)
  })
  test("the version's TODO is a positive integer", () => {
    const base = FlowCardSchema.parse(fixtures.proposed.model)
    for (const todo of [0, -1, 1.5]) {
      expect(FlowCardSchema.safeParse({ ...base, versions: [{ ...base.versions[1]!, todo }] }).success).toBe(false)
    }
  })
})

describe("Flow system flag", () => {
  test("a built-in flow is not a system flow by its source", () => {
    const base = FlowCardSchema.parse(fixtures.active.model)
    expect(base.source).toEqual({ builtin: true })
    expect(base.system).toBe(false)
    expect(FlowCardSchema.parse({ ...base, name: "merge", system: true }).system).toBe(true)
  })
  test("the flag is required and boolean", () => {
    const { system: _system, ...base } = FlowCardSchema.parse(fixtures.active.model)
    expect(FlowCardSchema.safeParse(base).success).toBe(false)
    expect(FlowCardSchema.safeParse({ ...base, system: "false" }).success).toBe(false)
  })
})

describe("Flow merge wait", () => {
  test("reserves merge for the wait with rebase and steer signals", () => {
    const base = FlowCardSchema.parse(fixtures.active.model)
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
  test.each(["answer", "merge", ""])("rejects signal %j", (on) => {
    const base = FlowCardSchema.parse(fixtures.active.model)
    const invalid = structuredClone(base)
    invalid.versions[0]!.steps = [{ id: "merge", wait: true, signals: [{ on: on as "rebase", to: "check" }] }]
    expect(FlowCardSchema.safeParse(invalid).success).toBe(false)
  })
})
