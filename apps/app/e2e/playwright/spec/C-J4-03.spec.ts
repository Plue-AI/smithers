import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J4-03.md.
// Real GitHub, authorization, timing and reference-host receipts remain required.
// Requires the forthcoming seeded DesignWorld. Seed three green review items and a subsequent GitHub required-review refusal.
// Written before implementation: mvp.md §4.2, §6.6, §6.10; lands with T-STK-04, T-REL-02
test("C-J4-03: Seed three green review items and a subsequent GitHub required-review refusal.", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.2, §6.6, §6.10; lands with T-STK-04, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/stack')
  const stack = page.getByRole('list', { name: 'Stack', exact: true })
  const row = (ref: string) => stack.getByRole('listitem').filter({ hasText: ref })
  await expect(row('T1').getByRole('button', { name: 'Merge', exact: true })).toBeVisible()
  for (const ref of ['T2', 'T3']) {
    await expect(row(ref)).toContainText('Merges after T1')
    await expect(row(ref).getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
  }
  await row('T1').getByRole('button', { name: 'Merge', exact: true }).press('Enter')
  await expect(page.getByText('Merge T1 into main?', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await expect(page.getByText('Merged T1', { exact: true })).toBeVisible()
  await say(page, '/stack')
  await expect(row('T2').getByRole('button', { name: 'Merge', exact: true })).toBeVisible()
  await expect(row('T3')).toContainText('Merges after T2')
  await row('T2').getByRole('button', { name: 'Merge', exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await expect(page.getByText('At least 1 approving review is required by reviewers with write access.', { exact: true })).toBeVisible()
})
