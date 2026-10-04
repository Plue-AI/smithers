import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-APP-01.md.
// Written before implementation: mvp.md §6.6 TODO card, Appendix B todo.takeover; lands with T-APP-02
test("C-APP-01: taking over a removed owner preserves place and working attempt", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.6 TODO card, Appendix B todo.takeover; lands with T-APP-02")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed Eve removed, T3 Queued with revisions, T4 Working attempt 1.
  // Owner can take over; member/delegated refusal and broadcasts need host receipts.
  await say(page, '/todo T3')
  await expect(page.getByText(/Eve.*removed/).last()).toBeVisible()
  await expect(page.getByText('Queued', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Take over', exact: true }).last().press('Enter')
  await expect(page.getByRole('region', { name: /T3/ }).last()).toContainText('canary-owner')
  await expect(page.getByRole('region', { name: /T3/ }).last()).toContainText('Queued')
  await expect(page.getByRole('button', { name: 'Take over', exact: true }).last()).toHaveCount(0)
  await say(page, '/todo T4')
  await page.getByRole('button', { name: 'Take over', exact: true }).last().press('Enter')
  await expect(page.getByRole('region', { name: /T4/ }).last()).toContainText('Working')
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await expect(page.getByText(/Attempt 1/).last()).toBeVisible()
  await expect(page.getByText(/Attempt 2/)).toHaveCount(0)
})
