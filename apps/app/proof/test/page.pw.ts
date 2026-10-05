/*
 * e2e: generate the proof page from the fixture run, open it in a real browser
 * from file://, and drive it the way a reviewer does: keys step a reel, Space
 * plays, 1-9 pick a reel, T flips the Paper theme. No request leaves the page.
 */
import { expect, test } from "@playwright/test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { generate } from "../proof-page.ts"

const fixtures = join(__dirname, "fixtures")
let out = ""

test.beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "proof-page-e2e-"))
  await generate({
    root: join(__dirname, "../../../.."),
    features: join(fixtures, "features.json"), results: join(fixtures, "results.json"), mock: join(fixtures, "mock-steps.json"), out
  })
})
test.afterAll(() => rmSync(out, { recursive: true, force: true }))

test("steps a reel with the keyboard and shows each step's verdict, screenshot and links", async ({ page }) => {
  const remote: Array<string> = []
  page.on("request", request => { if (!request.url().startsWith("file:") && !request.url().startsWith("data:")) remote.push(request.url()) })
  await page.goto(pathToFileURL(join(out, "index.html")).href)

  await expect(page.locator("#count")).toHaveText("0/4")
  await expect(page.locator("#caption")).toHaveText("Maya walks the fixture journey.")
  await expect(page.locator("#total")).toHaveText("2 / 7 features work")
  await expect(page.getByRole("alert")).toContainText("fx-disagree is not-implemented but the run says Works")

  await page.keyboard.press("ArrowRight")
  await expect(page.locator("#count")).toHaveText("1/4")
  await expect(page.locator("#caption")).toHaveText("She continues past setup.")
  const first = page.locator('[data-mock-step="fx#1"]')
  await expect(first).toBeVisible()
  await expect(first.locator(".badge").first()).toHaveText("Works")
  await expect(first.locator(".shot img")).toHaveAttribute("src", /^data:image\/png;base64,/)
  await expect(first.locator('[data-link="test"]')).toHaveAttribute("href", /\/blob\/0123456789abcdef0123456789abcdef01234567\/apps\/app\/proof\/test\/fx\.pw\.ts#L\d+$/)
  await expect(first.locator('[data-link="docs"]')).toHaveAttribute("href", /\/blob\/0123456789abcdef0123456789abcdef01234567\/apps\/app\/docs\/LOCAL-APP\.md$/)
  await expect(first.locator('[data-link="code"]')).toHaveAttribute("href", /apps\/app\/proof\/page\.ts#L1-L10$/)

  await page.keyboard.press("ArrowRight")
  const second = page.locator('[data-mock-step="fx#2"]')
  await expect(second.locator(".badge").first()).toHaveText("Broken")
  await expect(second.locator(".error")).toContainText("Commit")
  await expect(page.locator("#spec")).toHaveText("fx#2")

  await page.keyboard.press("ArrowRight")
  const third = page.locator('[data-mock-step="fx#3"]')
  await expect(third.locator('[data-feature-home="fx-blocked"] .badge')).toHaveText("Blocked by fx-fail")
  await expect(third.locator('[data-feature-ref="fx-fail"]')).toBeVisible()

  await page.keyboard.press("ArrowLeft")
  await expect(page.locator("#count")).toHaveText("2/4")

  // Past the end and before the start clamp.
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight")
  await expect(page.locator("#count")).toHaveText("4/4")
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowLeft")
  await expect(page.locator("#count")).toHaveText("0/4")
  await expect(page.locator("video[data-video=fx]")).toBeVisible()

  // Space plays: the reel advances on its own, and Space again pauses it.
  await page.keyboard.press(" ")
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause")
  await expect(page.locator("#count")).toHaveText("1/4", { timeout: 5000 })
  await page.keyboard.press(" ")
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play")
  const paused = await page.locator("#count").textContent()
  await page.waitForTimeout(3500)
  await expect(page.locator("#count")).toHaveText(paused!)

  // 2 picks the second reel; its uncovered step says so; 9 (no such reel) does nothing.
  await page.keyboard.press("2")
  await expect(page.locator("#count")).toHaveText("0/2")
  await expect(page.locator('.frame:not([hidden]) [data-feature-home="fy-none"]')).toBeVisible()
  await page.keyboard.press("9")
  await expect(page.locator("#count")).toHaveText("0/2")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowRight")
  await expect(page.locator('[data-mock-step="fy#2"]')).toContainText("No feature in features.json covers this step.")
  await expect(page).toHaveURL(/\?j=1&s=2$/)

  // T flips light and dark.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await page.keyboard.press("t")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

  expect(remote).toEqual([])
})

test("opens at the reel and step in the URL, in dark when asked", async ({ page }) => {
  await page.goto(`${pathToFileURL(join(out, "index.html")).href}?j=0&s=3&theme=dark`)
  await expect(page.locator("#count")).toHaveText("3/4")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await expect(page.locator('[data-mock-step="fx#3"]')).toBeVisible()
})
