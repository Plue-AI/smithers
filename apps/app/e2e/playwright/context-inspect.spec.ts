import { installCloudFixture } from "./cloudFixture"
import { expect, test } from "./browserTest"

// Projection proof over the existing durable chat fixture. This is not the
// C-UI-07 PostgreSQL/packaged-host/SharedEntries acceptance journey.
test("stored host preflight opens Inspect and survives reload", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await page.getByTestId("composer-input").fill("stub-context-preflight")
  await page.getByTestId("composer-input").press("Enter")
  const context = page.getByRole("button", { name: "Context · 1", exact: true }).last()
  await expect(context).toBeVisible()
  await page.getByTestId("composer-input").press("Escape")
  await context.press("Enter")
  await expect(page.locator(".context-chip").last()).toHaveAttribute("title",
    "src/webhooks/retry.ts · 0123456789abcdef0123456789abcdef01234567 · Retry implementation")
  await page.getByRole("button", { name: "Inspect", exact: true }).last().press("Enter")
  const monitor = page.locator('.mvp-run[data-maximized]')
  await expect(monitor).toBeVisible()
  await expect(monitor.locator(".mvp-run-step-head").first()).toHaveText("Preflight")
  await expect(monitor).toContainText("src/webhooks/retry.ts")
  await expect(monitor).toContainText("Retry implementation")
  await expect(monitor).toContainText("owner-fast")
  await page.reload()
  await expect(monitor).toBeVisible()
  await expect(monitor).toContainText("Retry implementation")
})


test("Context opens a pinned wiki revision by keyboard and mouse and retains it after reload", async ({ page }) => {
  await installCloudFixture(page)
  await page.route("**/api/agent/**", route => route.continue())
  await page.route("**/api/chat/**", route => route.continue())
  const writes: string[] = []
  page.on("request", request => { if (request.url().includes("/wiki") && request.method() !== "GET") writes.push(request.url()) })
  await page.route("**/api/repos/smithersai/smithers/wiki/navigation/index?*", route => route.fulfill({ json: { pages: [{
    id: 42, slug: "retries", title: "Retries", path: "Retries.md", revision: 9,
    author: { id: 1, login: "alice" }, created_at: "2026-10-01", updated_at: "2026-10-06", metadata: {}
  }] } }))
  await page.route("**/api/repos/smithersai/smithers/wiki/history/42/4/content?*", route => route.fulfill({
    contentType: "text/markdown; charset=utf-8", body: "# Retries\n\nRetry three times."
  }))
  await page.goto("/")
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await page.getByTestId("composer-input").fill("stub-wiki-preflight")
  await page.getByTestId("composer-input").press("Enter")
  const context = page.getByRole("button", { name: "Context · 1", exact: true }).last()
  await expect(context).toBeVisible()
  await page.getByTestId("composer-input").press("Escape")
  await context.press("Enter")
  const item = page.locator('.context-chip[data-flow="wiki.page"]').last()
  await expect(item).toHaveAttribute("title", "retries · 4 · Retry policy")
  await item.press("Enter")
  const content = page.getByTestId("wiki-pinned-content")
  await expect(content).toContainText("Retry three times.")
  await expect(content).toHaveAttribute("data-revision", "4")
  await expect(content.locator('textarea,[contenteditable="true"]')).toHaveCount(0)
  await item.click()
  await expect(content).toHaveCount(1)
  await page.reload()
  await expect(content).toContainText("Retry three times.")
  expect(writes).toEqual([])
})
