/** Temporary catalog reject cases; Appendix parity belongs to T-CAT-01. */
import { describe, expect, test } from "vitest"
import { CatalogTagSchema } from "../../src/catalog/index.ts"

describe("temporary catalog tags", () => {
  // MVP Appendix A and B.4, frozen lead ruling 2026-10-02.
  test.each([
    "docs",
    "debug-api",
    "todo.return-to-item",
    "merge.confirm",
    "background.retry",
    "notifications.allow",
    "members.role",
    "secrets.scope"
  ])("accepts published %s", (tag) => {
    expect(CatalogTagSchema.parse(tag)).toBe(tag)
  })
  test.each(["", "/todo", "todo.merge", "arbitrary.command"])("rejects unpublished %s", (tag) => {
    expect(CatalogTagSchema.safeParse(tag).success).toBe(false)
  })
})
