import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-09.md.
// Requires the forthcoming seeded DesignWorld. Seed member PR 50 with cache.ts:20 off-by-one and outsider PR 51; review completion has a Fix finding and the PR link. Machine and GitHub write proofs remain reference-host checks.
// This scenario does not replace the check's backend, timing or reference-host receipts.
// Written before implementation: mvp.md §6.3, §14, Appendix A /review; lands with T-FLW-13, T-MCH-06, T-REL-02
test("C-J10-09: review shows teammate findings and confirms delegated review", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.3, §14, Appendix A /review; lands with T-FLW-13, T-MCH-06, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/review #50')
  await expect(page.getByText('Review', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Fix', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'cache.ts:20', exact: true })).toBeVisible()
  await expect(page.getByRole('link').filter({ hasText: /50/ }).last()).toBeVisible()
  await say(page, 'review PR 50')
  await expect(page.getByRole('button', { name: /^Run review/ }).last()).toBeVisible()
  await expect(page.getByText('/review #50', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: /^Run review/ }).last().press('Enter')
  await expect(page.getByText('Review', { exact: true }).last()).toBeVisible()
  await say(page, '/review #51')
  await expect(page.getByText(/permission/i).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
})
