/**
 * Behavioral projection contract checks for Docs.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { fixtures } from "../fixtures/Docs.ts"


describe("docs", () => {
  test("a missing page keeps the requested slug and shows the first page", () => {
    const parsed = fixtures.not_found.model
    expect([parsed.not_found, parsed.page.slug]).toEqual(["deploy-to-kubernetes", parsed.toc[0]!.slug])
  })
  test("every story opens pages through the docs gesture with a page argument", () => {
    for (const story of Object.values(fixtures)) {
      if (!story.gestures.open) continue
      expect(story.gestures.open?.tag).toBe("docs")
      if (story.gestures.open?.args?.page) expect(story.gestures.open.args.page).toMatch(/^[a-z-]+(#[a-z-]+)?$/)
    }
  })
  test("toc order is kept", () => {
    expect(fixtures.page.model.toc.map(entry => entry.slug)).toEqual(["quickstart", "todos", "flows"])
  })
})
