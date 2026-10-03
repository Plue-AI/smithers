import { expect, test } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import { stories } from "./PrimitivesView.stories"
import { fixtures } from "@smthrs/rpc/fixtures/ActorChip"
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("actor stories keep the independent RPC oracle without sibling labels", () => {
  expect(fixtures.system.expect).toEqual(["Smithers"])
  for (const [key, fixture] of Object.entries(fixtures)) {
    expect(stories.find(story => story.name === `actor-fixture-${key}`)!.expect).toBe(fixture.expect)
  }
  const source = read("./PrimitivesView.stories.tsx")
  expect(source).not.toContain("<span>{actorLabels")
  expect(source).not.toContain("<span>{actorName")
})
test("queued flow steps do not become queue places", () => {
  const story = stories.find(story => story.name === "state-queued-step")!
  expect(story.expect).toEqual(["Waiting for a machine"])
})
test("production input excludes stories unless explicitly enabled", () => {
  const config = read("../../../../vite.config.ts")
  expect(config).toContain('process.env.SMITHERS_VIEW_STORIES === "1" ? { stories:')
  expect(read("../../../../playwright.config.ts")).toContain('SMITHERS_VIEW_STORIES: "1"')
})
test("browser evidence defaults to the C-UI-12 artifact directory", () => {
  const source = read("../../../../e2e/playwright/view-stories.spec.ts")
  expect(source).toContain(".artifacts/checks/C-UI-12")
  expect(source).toContain("new Date().toISOString()")
  expect(source).not.toContain("design-lanes/shots")
})
test("DOM stories assert actual chip names and do not claim viewport layout", () => {
  const source = read("./Views.test.tsx")
  expect(source).toContain('chip.getAttribute("aria-label")')
  expect(source).not.toContain("[1280, 390]")
  expect(read("../../../../../../packages/rpc/test/fixtures/_story.ts")).toContain("case-sensitive")
})
test("CSS owns the tone tokens and public clipboard has a documented entry", () => {
  expect(existsSync(new URL("./Tone.ts", import.meta.url))).toBe(false)
  expect(read("../../../../../../packages/smithers/ui/docs/reference/contracts.md")).toContain('`copyText` is a public export from `@smthrs/ui`')
})
