import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-07.md.
// Requires the forthcoming seeded DesignWorld. Seed main rewritten on GitHub at M1-prime; advance its tip again before the first owner reset, then admit the current reset. Role and write-fencing proofs remain integration checks.
// This scenario does not replace the check's backend, timing or reference-host receipts.
// Written before implementation: mvp.md §6.3 main rewritten on GitHub; lands with T-GH-07, T-ACC-03
test("C-J10-07: main rewrite waits for the owner and refuses stale confirmation", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.3 main rewritten on GitHub; lands with T-GH-07, T-ACC-03")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/stack')
  await expect(page.getByText(/main rewritten on GitHub/)).toBeVisible()
  await expect(page.getByText('Needs you', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset to GitHub main', exact: true })).toBeVisible()
  await say(page, '/todo T1')
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
  await say(page, '/stack')
  await page.getByRole('button', { name: 'Reset to GitHub main', exact: true }).last().press('Enter')
  await expect(page.getByText(/stale/i).last()).toBeVisible()
  await expect(page.getByText(/main rewritten on GitHub/).last()).toBeVisible()
  await page.getByRole('button', { name: 'Reset to GitHub main', exact: true }).last().press('Enter')
  await expect(page.getByText('Rebase pending', { exact: true }).first()).toBeVisible()
  await page.reload()
  await say(page, '/stack')
  await expect(page.getByText(/main rewritten on GitHub/)).toHaveCount(0)
})
