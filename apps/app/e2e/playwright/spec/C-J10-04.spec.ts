import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-04.md.
// Real GitHub, authorization, timing and reference-host receipts remain required.
// Requires the forthcoming seeded DesignWorld. Seed unrelated main movement with Ben present on A, agent alone on B, and Ben's terminal write delaying a rebase.
// Written before implementation: mvp.md J10.4, §4.2; lands with T-STK-08
test("C-J10-04: Seed unrelated main movement with Ben present on A, agent alone on B, and Ben's terminal write delaying a rebase.", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J10.4, §4.2; lands with T-STK-08")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/stack')
  await expect(page.getByText('docs: unrelated update', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Rebase pending', { exact: true }).first()).toBeVisible()
  await say(page, '/todo T6')
  await page.getByRole('button', { name: 'Open branch', exact: true }).last().press('Enter')
  await expect(page.getByText('Rebased onto main', { exact: true }).last()).toBeVisible()
  await say(page, '/todo T5')
  await page.getByRole('button', { name: 'Open branch', exact: true }).last().press('Enter')
  await expect(page.getByText(/Rebase pending onto/)).toBeVisible()
  await page.getByRole('button', { name: 'Rebase now', exact: true }).press('Enter')
  await expect(page.getByText('Rebasing…', { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Waiting for a write in Ben's terminal", { exact: true })).toBeVisible()
  await expect(page.getByText(/Rebase pending/).first()).toBeVisible()
  await expect(page.getByText('Rebased onto main', { exact: true }).last()).toBeVisible()
  await say(page, '/todo T5')
  await expect(page.getByText('Approval cleared by rebase · checks rerun', { exact: true })).toBeVisible()
  await page.reload()
  await say(page, '/todo T5')
  await expect(page.getByText(/Reviewed .*same change/).last()).toBeVisible()
})
