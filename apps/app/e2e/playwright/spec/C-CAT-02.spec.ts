import { expect, test } from "../browserTest"
import { owner } from "./j1-fixtures"

// UI projection of C-CAT-02; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md §6.1.2a, Appendix A, B.6; lands with T-CAT-01
test("C-CAT-02: External CLI confirmation waits for the person", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1.2a, Appendix A, B.6; lands with T-CAT-01")
  // Required seed: real CLI delegated request already ingested into main,
  // plus its waiting confirmation. This is the UI half; CLI argv/schema and
  // refusal exit codes require the ticket's CLI integration suite.
  await owner(page)
  await page.goto("/")
  await expect(page.getByText("Codex for Ben", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Waiting for Ben to confirm", { exact: true })).toBeVisible()
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Waiting for Ben to confirm", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Review & merge", exact: true }).last().press("Enter")
  const confirmation = page.locator(".smithers-card").last()
  await expect(confirmation).toContainText("Upgrade Stripe to v15")
  await expect(confirmation).toContainText("Required checks")
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
})
