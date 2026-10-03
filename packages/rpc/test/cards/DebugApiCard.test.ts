/**
 * Behavioral projection contract checks for DebugApi.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { DebugApiCardSchema } from "../../src/DebugApiCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/DebugApi.ts"

cardContract("DebugApi", DebugApiCardSchema, fixtures)

// Literal oracle from ui-components.md T-UI-22.
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const
const list = fixtures.operations.model
const op = list.operations[0]!

describe("debug api", () => {
  test.each(METHODS)("accepts method %s", (method) => {
    expect(DebugApiCardSchema.parse({ operations: [{ ...op, method }] }).operations[0]!.method).toBe(method)
  })
  test.each(["OPTIONS", "TRACE", "CONNECT", "get", ""])("rejects method %j", (method) => {
    expect(DebugApiCardSchema.safeParse({ operations: [{ ...op, method }] }).success).toBe(false)
  })
  test("stories list every method", () => {
    expect([...new Set(list.operations.map((operation) => operation.method))].sort()).toEqual([...METHODS].sort())
  })
  test("a pending mutation has sent nothing", () => {
    const parsed = DebugApiCardSchema.parse(fixtures.pending_mutation.model)
    expect(parsed.pending).toEqual({ method: "POST", path: "/api/todos/12/drop" })
    expect(parsed).not.toHaveProperty("exchange")
  })
  test("a failure stays typed, with its status", () => {
    expect(DebugApiCardSchema.parse(fixtures.unauthorized.model).exchange?.failure).toEqual({
      class: "unauthorized",
      message: "Sign in again",
      status: 401
    })
  })
  test("statuses are HTTP status codes and headers are name-value pairs", () => {
    const exchange = fixtures.get_200.model.exchange!
    for (const status of [99, 600, 200.5]) {
      const response = { ...exchange.response!, status }
      expect(DebugApiCardSchema.safeParse({ ...list, exchange: { ...exchange, response } }).success).toBe(false)
    }
    const headers = [["content-type"]]
    expect(
      DebugApiCardSchema.safeParse({ ...list, exchange: { ...exchange, request: { ...exchange.request, headers } } })
        .success
    ).toBe(false)
  })
  test.each(["javascript:alert(1)", "file:///etc/passwd", "/api/todos/12"])("rejects request URL %s", (url) => {
    const exchange = fixtures.get_200.model.exchange!
    expect(
      DebugApiCardSchema.safeParse({ ...list, exchange: { ...exchange, request: { ...exchange.request, url } } })
        .success
    ).toBe(false)
  })
  test("Send and Confirm never share one story's actions", () => {
    for (const story of Object.values(fixtures)) {
      const tags = story.actions.map((action) => action.tag)
      expect(new Set(tags).size).toBe(tags.length)
    }
  })
})
