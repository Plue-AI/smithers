import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J8-04.md.
// Written before implementation: mvp.md J8.3, §6.9, §6.11 One vault for both agents; lands with T-FLW-10
test("C-J8-04: plan citations keep the exact wiki revision across retry", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J8.3, §6.9, §6.11 One vault for both agents; lands with T-FLW-10")
// UI projection of the integration check: seed T12 Failed after planning, citing
// retry-policy r3 and fresh overview r1; release-process is excluded. Seed a
// later source change making overview stale for T13. Digest/selector receipts
// and PostgreSQL assertions remain the integration qualification.
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T12')
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Plan', exact: true }).last().press('Enter')
  await expect(page.getByRole('link', { name: /retry-policy.*r3/ }).last()).toBeVisible()
  await expect(page.getByRole('link', { name: /overview.*r1/ }).last()).toBeVisible()
  await expect(page.getByRole('link', { name: /release-process/ })).toHaveCount(0)
  await page.getByRole('link', { name: /retry-policy.*r3/ }).last().press('Enter')
  await expect(page.getByText('Webhook retries use retry() with exponential backoff', { exact: true }).last()).toBeVisible()
  await say(page, '/wiki.page retry-policy')
  await page.getByRole('textbox', { name: /Retry policy/i }).last().fill('Webhook retries use retryFixed(5000).')
  await expect(page.getByText('r4', { exact: true }).last()).toBeVisible()
  await say(page, '/todo T12')
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Plan', exact: true }).last().press('Enter')
  await expect(page.getByRole('link', { name: /retry-policy.*r3/ }).last()).toBeVisible()
  await say(page, '/todo T12')
  await page.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Plan', exact: true }).last().press('Enter')
  await expect(page.getByRole('link', { name: /retry-policy.*r4/ }).last()).toBeVisible()
  await say(page, '/todo T13')
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Plan', exact: true }).last().press('Enter')
  await expect(page.getByRole('region', { name: /Selected step/ }).last()).not.toContainText('overview')
})
