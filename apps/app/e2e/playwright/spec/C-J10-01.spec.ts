import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-01.md.
// Real GitHub, authorization, timing and reference-host receipts remain required.
// Requires the forthcoming seeded DesignWorld. Seed T1 and T2 PR evidence; T2 includes T1, but its diff contains only retry.ts.
// Written before implementation: mvp.md J10.1, §6.3; lands with T-GH-03, T-REL-02
test("C-J10-01: Seed T1 and T2 PR evidence", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J10.1, §6.3; lands with T-GH-03, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T2')
  await expect(page.getByText('Retry webhooks', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('into main · includes T1', { exact: true })).toBeVisible()
  const pr = page.getByRole('link', { name: /on GitHub/ }).last()
  const originalPR = await pr.getAttribute('href')
  expect(originalPR).toMatch(/github\.com\/.+\/pull\/\d+$/)
  await expect(page.getByText('Checks', { exact: true })).toBeVisible()
  await expect(page.getByText('Review', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Diff', exact: true }).last().press('Enter')
  await expect(page.getByText('src/retry.ts', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('src/helper.ts', { exact: true })).toHaveCount(0)
  await say(page, '/todo.amend T2')
  await page.getByLabel('Prompt', { exact: true }).fill('Retry webhooks; also log each retry')
  await page.getByRole('button', { name: 'Commit', exact: true }).press('Enter')
  await expect(page.getByText('Amended', { exact: true })).toBeVisible()
  await say(page, '/todo T2')
  await expect(page.getByRole('link', { name: /on GitHub/ }).last()).toHaveAttribute('href', originalPR!)
  await say(page, '/merge T1')
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await say(page, '/todo T2')
  await expect(page.getByText('into main · includes T1', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /on GitHub/ }).last()).toHaveAttribute('href', originalPR!)
})
