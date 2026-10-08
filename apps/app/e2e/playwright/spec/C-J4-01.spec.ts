import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Mounted Home projection over the existing DesignWorld. Native mirror/live
// projection and shared run admission have composed-router integration proof;
// real microVM Retry and the reference-host journey still wait for the mini.
test("C-J4-01: Home counts, durable filter and background Retry", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  const home = page.locator(".home").first()
  await expect(home.getByText("5 merged since you looked", { exact: true })).toBeVisible()
  await say(page, "/stack")
  for (const name of ["Needs you 1", "Working 1", "Queued 1", "In review 1"]) {
    await expect(home.getByRole("button", { name, exact: true })).toBeVisible()
  }
  await expect(home.locator(".sync")).toContainText(/synced \d+ (s|min) ago/)
  await expect(home.getByText("3/3 machines", { exact: true })).toBeVisible()
  const filter = home.getByRole("button", { name: "Needs you 1", exact: true })
  await filter.press("Enter")
  await page.reload()
  await expect(filter).toHaveAttribute("aria-pressed", "true")
  await expect(home.locator(".stack-row .ref")).toHaveText(["T9"])
  const failed = home.locator(".run-row", { hasText: "release-notes" })
  await expect(failed).toHaveAttribute("data-state", "failed")
  await failed.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect(failed).toHaveAttribute("data-state", "running")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

test("C-J4-01: Home Dismiss removes the failed background row", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  const home = page.locator(".home").first()
  const failed = home.locator(".run-row", { hasText: "release-notes" })
  await expect(failed).toHaveAttribute("data-state", "failed")
  await failed.getByRole("button", { name: "Dismiss", exact: true }).press("Enter")
  await expect(failed).toHaveCount(0)
  await expect(home.locator(".run-row", { hasText: "Wiki refresh" })).toHaveCount(1)
})
