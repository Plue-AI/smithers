import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-ACC-02.md.
// Written before implementation: mvp.md §6.10, §6.13, M-05, M-21; lands with T-ACC-04, T-APP-04, T-STK-04
test("C-ACC-02: an agent requests a merge and the person reviews the current revision", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.10, §6.13, M-05, M-21; lands with T-ACC-04, T-APP-04, T-STK-04")
  // Seed owner, T1 ready on h1, and a held h1→h2 rebase after the first card opens.
  // h2 has running checks; release those after the stale approval is visible.
  // Credential refusals, generation races and merge sends belong to integration.
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "Merge T1")
  await expect(page.getByText("Merge T1 into main?", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("rev h1", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Merged", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Merge", exact: true }).last().press("Enter")
  await expect(page.getByText("Checks running on h2", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Merged", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await expect(page.getByText("You approved h1. Review h2.", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("rev h2", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Review & merge", exact: true }).last().press("Enter")
  await expect(page.getByText("Merged T1", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/todo T1")
  await expect(page.getByText("Merged", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
})
