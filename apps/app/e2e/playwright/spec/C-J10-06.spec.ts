import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-06.md.
// Requires the forthcoming seeded DesignWorld. Seed fresh sync, advance beyond 120 seconds without success, hold Retry unresolved, then publish successful sync and an installation refusal.
// This scenario does not replace the check's backend, timing or reference-host receipts.
// Written before implementation: mvp.md J10.6, §6.3; lands with T-GH-07
test("C-J10-06: sync age and Retry stay honest while Chat remains usable", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J10.6, §6.3; lands with T-GH-07")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/stack')
  await expect(page.getByText('synced 40 s ago', { exact: true })).toBeVisible()
  await expect(page.getByText('synced 6 min ago', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).first().press('Enter')
  await say(page, '/help')
  await expect(page.getByText('Commands', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('synced 6 min ago', { exact: true })).toBeVisible()
  await say(page, 'retry the GitHub sync')
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0)
  await expect(page.getByText(/synced [0-9]+ s ago/).first()).toBeVisible()
  await say(page, '/github')
  await expect(page.getByText(/App installation/).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings', exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
  await expect(page.getByText(/synced [0-9]+ s ago/).last()).toBeVisible()
})
