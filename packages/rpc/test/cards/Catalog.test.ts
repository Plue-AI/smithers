/** Generated card command reject cases; app fixtures prove Appendix parity. */
import { describe, expect, test } from "vitest"
import { CatalogTagSchema } from "../../src/CatalogTags.ts"

describe("generated catalog tags", () => {
  // MVP Appendix A and B.4, frozen lead ruling 2026-10-02.
  test.each([
    "docs",
    "image.add",
    "context.inspect",
    "debug-api",
    "todo.return-to-item",
    "todo.preapprove",
    "todo.unapprove",
    "settings.preapprove-default",
    "merge.confirm",
    "background.retry",
    "notifications.allow",
    "members.role",
    "secrets.scope",
    "form.set",
    "code.hover",
    "code.definition",
    "draft.discard",
    "confirm.cancel",
    "settings.model.set"
  ])("accepts published %s", (tag) => {
    expect(CatalogTagSchema.parse(tag)).toBe(tag)
  })
  test.each(["", "/todo", "todo.merge", "arbitrary.command"])("rejects unpublished %s", (tag) => {
    expect(CatalogTagSchema.safeParse(tag).success).toBe(false)
  })
})
