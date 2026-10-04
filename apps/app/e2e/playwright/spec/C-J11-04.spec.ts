import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J11-04.md.
// Written before implementation: mvp.md §6.14 Monitor, Thrashing; lands with T-FLW-07, T-REL-02
test("C-J11-04: thrashing marks only three unchanged failures in one attempt", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.14 Monitor, Thrashing; lands with T-FLW-07, T-REL-02")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed the check's three journals: T4 unchanged failures, T5 an edit
  // between failures, T6 failures split across attempts. T4 later passes.
  // Authenticated ingest, determinism and zero model calls need integration receipts.
  await say(page, '/todo T4')
  await expect(page.getByText('Thrashing: TestRetryBackoff failed 3×', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await expect(page.getByText('TestRetryBackoff', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Ran checks.*1 failed ×3/).last()).toBeVisible()
  for (const todo of ['T5', 'T6']) {
    await say(page, `/todo ${todo}`)
    await expect(page.getByRole('region', { name: new RegExp(todo) }).last()).not.toContainText('Thrashing')
  }
  await say(page, '/todo T4')
  await page.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
  await expect(page.getByRole('region', { name: /T4/ }).last()).toContainText('In review')
  await expect(page.getByRole('region', { name: /T4/ }).last()).not.toContainText('Thrashing')
})
