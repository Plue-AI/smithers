/**
 * Behavioral projection contract checks for Agent.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { AgentCardSchema } from "../../src/AgentCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Agent.ts"

cardContract("Agent", AgentCardSchema, fixtures)

// Literal oracle: mvp.md §6.5 model roles.
const ROLES = ["fast", "coding", "jev"] as const
const coding = fixtures.coding.model

describe("Agent", () => {
  test.each(ROLES)("accepts role %s", (role) => {
    expect(AgentCardSchema.parse({ ...coding, role }).role).toBe(role)
  })
  test.each(["gateway", "app", "reviewer", "Fast", ""])("refuses role %j", (role) => {
    expect(AgentCardSchema.safeParse({ ...coding, role }).success).toBe(false)
  })
  test("stories cover every role", () => {
    expect([...new Set(Object.values(fixtures).map((story) => story.model.role))].sort()).toEqual([...ROLES].sort())
  })
  test("Change model is the owner's only", () => {
    expect(fixtures.coding.actions.map((action) => action.label)).toEqual(["Change model"])
    expect(fixtures.member_view.model.owner).toBe(false)
    expect(fixtures.member_view.actions).toEqual([])
  })
  test("no story binds a command that commits a TODO", () => {
    // Edit instructions must open a Draft; `todo.new` with text commits one at once.
    const tags = Object.values(fixtures).flatMap((story) => story.actions.map((action) => action.tag))
    expect(tags).not.toContain("todo.new")
  })
  test("Change model offers the owner's available models", () => {
    expect(fixtures.coding.actions[0]!.input?.[0]?.choices).toEqual(coding.available)
  })
  test("owner and provider are required", () => {
    for (const key of ["owner", "provider"] as const) {
      const { [key]: _removed, ...rest } = coding
      expect(AgentCardSchema.safeParse(rest).success, key).toBe(false)
    }
  })
})
