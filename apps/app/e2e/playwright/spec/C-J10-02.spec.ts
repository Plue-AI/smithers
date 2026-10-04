import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-02.md.
// Real GitHub, authorization, timing and reference-host receipts remain required.
// Requires the forthcoming seeded DesignWorld. Seed timed GitHub review delivery from Alice, a verified fix, outsider activity and owner approval.
// Written before implementation: mvp.md J10.2, §6.10; lands with T-GH-04
test("C-J10-02: Seed timed GitHub review delivery from Alice, a verified fix, outsider activity and owner approval.", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J10.2, §6.10; lands with T-GH-04")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T3')
  await page.getByRole('button', { name: 'Open branch', exact: true }).press('Enter')
  await expect(page.getByText('Use the existing backoff helper', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Alice', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('src/retry.ts:12', { exact: true })).toBeVisible()
  await expect(page.getByText('Working', { exact: true }).last()).toBeVisible()
  await say(page, '/todo T3')
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Diff', exact: true }).last().press('Enter')
  await expect(page.getByText(/backoff\(/).last()).toBeVisible()
  await page.reload()
  await say(page, '/todo T3')
  await page.getByRole('button', { name: 'Open branch', exact: true }).last().press('Enter')
  await expect(page.getByText('Use the existing backoff helper', { exact: true })).toHaveCount(1)
  await expect(page.getByText('@dana', { exact: true })).toBeVisible()
  await say(page, '/todo T3')
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Approved by/).last()).toBeVisible()
  await expect(page.getByText(/Merged into main/)).toHaveCount(0)
})
