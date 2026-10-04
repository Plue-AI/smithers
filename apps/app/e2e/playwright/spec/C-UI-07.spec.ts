import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-UI-07; acceptance now lives in T-APP-17.
// Reference-host and integration evidence remains required separately.
// Written before implementation: mvp.md §6.5 Context preflight, J9; lands with T-APP-17
test("C-UI-07: Stored context opens pinned sources and Inspect", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.5 Context preflight, J9; lands with T-APP-17")
  // Required seed: recorded host preflight selects four revision-pinned sources,
  // with a newer unselected wiki revision and private draft canary excluded.
  await owner(page)
  await page.goto("/")
  await say(page, "Why is the checkout test flaky?")
  const context = page.getByRole("button", { name: "Context · 4", exact: true }).last()
  await context.press("Enter")
  for (const title of ["checkout.test.ts", "Payments testing", "T10", "T10 run"]) {
    await expect(page.getByText(title, { exact: true }).last()).toBeVisible()
  }
  await page.getByText("checkout.test.ts", { exact: true }).last().press("Enter")
  await expect(page.locator(".smithers-card").last()).toContainText("checkout.test.ts")
  await context.press("Enter")
  await context.press("Enter")
  await page.getByText("Payments testing", { exact: true }).last().press("Enter")
  await expect(page.locator(".smithers-card").last()).toContainText("r4")
  await page.getByRole("button", { name: "Inspect", exact: true }).last().press("Enter")
  const run = page.locator(".smithers-card").last()
  await expect(run).toContainText("Preflight")
  await expect(run).toContainText("checkout.test.ts")
  await expect(run).not.toContainText("private-draft-canary")
  await page.reload()
  await page.getByRole("button", { name: "Context · 4", exact: true }).last().press("Enter")
  await expect(page.getByText("Payments testing", { exact: true }).last()).toBeVisible()
})
