import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-03.md; not a qualification receipt.
// Written before implementation: mvp.md §6.7, J3; lands with T-MCH-07
test("C-MCH-03: Captured sleeping files remain readable and only a terminal wakes the branch", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.7, J3; lands with T-MCH-07")
  await owner(page)
  await page.goto("/")
  // Seed captured retry.ts and uncommitted backoff.ts on an asleep branch.
  // Capture ordering, hostile hooks and runtime start counts require integration evidence.
  await say(page, "/branch upgrade-stripe")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await say(page, "/file src/backoff.ts")
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("return Math.min(1000 * 2 ** attempt, 30000)")
  await say(page, "/diff upgrade-stripe")
  await expect(page.getByText("src/backoff.ts", { exact: true }).last()).toBeVisible()
  await say(page, "/branch upgrade-stripe")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  await expect(page.getByText("Awake", { exact: true }).last()).toBeVisible()
})

// Mounted snapshot projection; runtime wake/capture qualification remains above.
test("C-MCH-03: Reading sleeping branch panels preserves Asleep after reload", async ({ page }) => {
  await page.goto("/")
  await say(page, "/branch upgrade-stripe")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  const files = page.getByRole("tab", { name: /^Files/ }).last()
  await files.press("Enter")
  await expect(files).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await page.getByRole("tab", { name: /^Activity/ }).last().press("Enter")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("tab", { name: /^Activity/ }).last()).toHaveAttribute("aria-selected", "true")
})
