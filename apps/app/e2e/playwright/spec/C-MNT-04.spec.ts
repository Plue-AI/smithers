import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MNT-04.md; not a qualification receipt.
// Written before implementation: mvp.md §14; lands with T-MNT-04
test("C-MNT-04: Outside PR review keeps contributor identity and revision", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §14; lands with T-MNT-04")
  await owner(page)
  await page.goto("/")
  // Future Stage-M fixture: outsider PR 73, admitted review, capacity contention,
  // followed by a pushed head and a failing second attempt.
  await say(page, "/pr 73")
  await expect(page.getByText("#73", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Merge", exact: true }).last()).not.toBeVisible()
  await say(page, "/review 73")
  await page.getByRole("button", { name: "Confirm", exact: true }).last().press("Enter")
  await expect(page.getByText("Queued", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Blocker", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("src/retry.ts:12", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Stale", { exact: true }).last()).toBeVisible()
  await say(page, "/review 73")
  await page.getByRole("button", { name: "Confirm", exact: true }).last().press("Enter")
  await expect(page.getByText("Failed", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
  await expect(page.getByText("Blocker", { exact: true }).last()).toBeVisible()
  await say(page, "/pr 73")
  await expect(page.getByText("#73", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "GitHub", exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Merge", exact: true }).last()).not.toBeVisible()
  // Shared reviewer identity, no GitHub writes and separate commit-work admission
  // require protocol and reference-host evidence beyond this UI projection.
})
