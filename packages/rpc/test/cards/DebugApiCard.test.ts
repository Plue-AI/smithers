/**
 * Behavioral projection contract checks for DebugApi.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import type { DebugApiCard } from "../../src/DebugApiCard.ts"
import { fixtures } from "../fixtures/DebugApi.ts"

const fixtureModels: DebugApiCard[] = Object.values(fixtures).map(story => story.model)
void fixtureModels

// Literal oracle from ui-components.md T-UI-22.
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const
const list = fixtures.operations.model

describe("debug api", () => {
  test("stories list every method", () => {
    expect([...new Set(list.operations.map((operation) => operation.method))].sort()).toEqual([...METHODS].sort())
  })
  test("a pending mutation has sent nothing", () => {
    const parsed = fixtures.pending_mutation.model
    expect(parsed.pending).toEqual({ method: "POST", path: "/api/todos/12/drop" })
    expect(parsed).not.toHaveProperty("exchange")
  })
  test("a failure stays typed, with its status", () => {
    expect(fixtures.unauthorized.model.exchange?.failure).toEqual({
      class: "unauthorized",
      message: "Sign in again",
      status: 401
    })
  })
  test("Send and Confirm never share one story's actions", () => {
    for (const story of Object.values(fixtures)) {
      const tags = story.actions.map((action) => action.tag)
      expect(new Set(tags).size).toBe(tags.length)
    }
  })
})
