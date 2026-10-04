import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J4-02.md.
// Real GitHub, authorization, timing and reference-host receipts remain required.
// Requires the forthcoming seeded DesignWorld. Seed T1 green, T2 asking, T3 failed and T4 green; hold action completion while chat streams.
// Written before implementation: mvp.md J4.2, J4.3; lands with T-STK-02, T-STK-05, T-APP-02
test("C-J4-02: Seed T1 green, T2 asking, T3 failed and T4 green", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J4.2, J4.3; lands with T-STK-02, T-STK-05, T-APP-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, 'where do we retry webhooks?')
  await say(page, '/todo T2')
  await page.getByLabel('Answer', { exact: true }).fill('Use the existing helper')
  await page.getByRole('button', { name: 'Answer', exact: true }).press('Enter')
  await expect(page.getByText(/requested|accepted/i).last()).toBeVisible()
  await say(page, '/todo T1')
  await expect(page.getByText('Checks', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await expect(page.getByText('Merge T1 into main?', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await say(page, '/stack')
  const stack = page.getByRole('list', { name: 'Stack', exact: true })
  const fourth = stack.getByRole('listitem').filter({ hasText: 'T4' })
  await fourth.getByRole('button', { name: /^Order / }).press('Enter')
  await page.getByRole('menuitem', { name: /Move up/ }).press('Enter')
  await say(page, '/todo T3')
  await page.getByLabel('Steer the retry', { exact: true }).fill('FIXED: fix the real bug, keep the test')
  await page.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
  await expect(page.getByText('Attempt 2', { exact: true })).toBeVisible()
  await say(page, '/stack')
  await expect(stack.getByRole('listitem').filter({ hasText: /T[234]/ })).toHaveText([/T2/, /T4.*Merges after T2/, /T3/])
  await expect(stack.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
  await say(page, 'Which helper should we use?')
  await expect(page.getByText('Which helper should we use?', { exact: true })).toBeVisible()
})
