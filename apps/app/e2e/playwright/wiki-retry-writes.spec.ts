import { expect, test } from "./browserTest"
import type { MythicalStack } from "@smthrs/rpc/Mythical"
import { installCloudFixture } from "./cloudFixture"
import { fillComposer } from "./composer"

/*
 * #3113: rapid Wiki refresh retries against a refused history (HTTP 409) hit
 * the real OPFS SQLite writer. The app must stay on its handled path and never
 * reach the fatal "Changes could not be saved" panel; a write rejection would
 * log the fixed classification, captured here.
 */
const REPO = "smithersai/smithers"
const BASE = `/api/repos/${REPO}/mythical`
const stack: MythicalStack = {
  repository: REPO, state: "active", generation: 1, mainBehind: false, changes: [], items: [],
  lanes: [{ index: 0, state: "idle" }], limits: { maxParallel: 1 }
}

test("rapid Wiki retries after a 409 keep the writer healthy", async ({ page }) => {
  await installCloudFixture(page)
  const warnings: string[] = []
  page.on("console", message => { if (message.text().includes("local write failed")) warnings.push(message.text()) })
  let posts = 0
  await page.route(url => url.pathname === BASE, route => route.fulfill({ json: stack }))
  await page.route(url => url.pathname === `${BASE}/events`, route => route.fulfill({
    status: 200, headers: { "content-type": "text/event-stream" }, body: `event: mythical\ndata: {"generation":1,"kind":"item"}\n\n`
  }))
  await page.route(url => url.pathname === `${BASE}/wiki`, route => {
    posts += 1
    return route.fulfill({ status: 409, json: { message: "history does not exist" } })
  })
  await page.goto("/")
  await expect(page.getByTestId("first-run-actions")).toBeVisible()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await fillComposer(page, `/wiki.create ${REPO}`)
    await page.getByTestId("composer-send").click()
    await expect.poll(() => posts).toBeGreaterThan(attempt)
  }
  await page.waitForTimeout(3_000)
  expect(warnings).toEqual([])
  await expect(page.getByText("Changes could not be saved")).toHaveCount(0)
})
