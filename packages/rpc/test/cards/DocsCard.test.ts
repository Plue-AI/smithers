/**
 * Behavioral projection contract checks for Docs.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { DocsCardSchema } from "../../src/DocsCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Docs.ts"

cardContract("Docs", DocsCardSchema, fixtures)

describe("docs", () => {
  test("a missing page keeps the requested slug and shows the first page", () => {
    const parsed = DocsCardSchema.parse(fixtures.not_found.model)
    expect([parsed.not_found, parsed.page.slug]).toEqual(["deploy-to-kubernetes", parsed.toc[0]!.slug])
  })
  test("every story opens pages through the docs gesture with a page argument", () => {
    for (const story of Object.values(fixtures)) {
      expect(story.gestures.open?.tag).toBe("docs")
      expect(story.gestures.open?.args?.page).toMatch(/^[a-z-]+(#[a-z-]+)?$/)
    }
  })
  test("toc order is kept and every page field is required", () => {
    const page = fixtures.page.model
    expect(DocsCardSchema.parse(page).toc.map((entry) => entry.slug)).toEqual(["quickstart", "todos", "flows"])
    for (const key of ["slug", "title", "summary", "markdown"] as const) {
      const { [key]: _removed, ...rest } = page.page
      expect(DocsCardSchema.safeParse({ ...page, page: rest }).success, key).toBe(false)
    }
  })
})
