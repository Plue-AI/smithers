import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-08.md.
// Requires the forthcoming seeded DesignWorld. Seed T1/T2/T3 in order; deliver Alice closing T2 twice, reopening within seven days twice, and closing T3 then reopening after eight days.
// This scenario does not replace the check's backend, timing or reference-host receipts.
// Written before implementation: mvp.md §6.3 PR closed without merging; lands with T-GH-03, T-STK-05, T-MCH-14
test("C-J10-08: GitHub close carries its actor and timely reopen restores position", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.3 PR closed without merging; lands with T-GH-03, T-STK-05, T-MCH-14")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T2')
  await expect(page.getByText('Dropped', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('closed on GitHub by @alice', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Failed', { exact: true })).toHaveCount(0)
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await say(page, '/stack')
  const refs = page.getByRole('button').filter({ hasText: /^T[123]\b/ })
  await expect(refs).toHaveText([/T1/, /T2/, /T3/])
  await say(page, '/todo T2')
  await expect(page.getByText(/Attempt 2/)).toHaveCount(0)
  await say(page, '/todo T3')
  await expect(page.getByText('Dropped', { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, '/todo T3')
  await expect(page.getByText('Dropped', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
})
