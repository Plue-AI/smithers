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
