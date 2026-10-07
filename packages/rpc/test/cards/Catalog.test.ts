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
    "settings",
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


test("retired Settings tags stay out of the executable catalog", () => {
  for (const tag of ["settings.address", "settings.capacity", "settings.parallel", "settings.preapprove-default", "settings.daily-admissions", "settings.obsidian", "settings.model-key", "settings.setup"]) {
    expect(CatalogTagSchema.safeParse(tag).success).toBe(false)
  }
})
