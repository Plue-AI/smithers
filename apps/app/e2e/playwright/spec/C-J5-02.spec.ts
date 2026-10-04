import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J5-02.md.
// Requires the forthcoming seeded DesignWorld. Seed a real-loader projection of failed M2 with D1 active, a held v1 TODO T1 and a new v1 TODO T2. Schedule corrected M4 activation on reopening the flow; immutable resolver and loader transactions remain integration evidence.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J5.3, §6.12 Pinned versions; lands with T-FLW-03, T-FLW-04, T-FLW-11
test("C-J5-02: a broken merged version leaves the previous flow Active", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J5.3, §6.12 Pinned versions; lands with T-FLW-03, T-FLW-04, T-FLW-11")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/flow todo')
  const flow = page.getByRole('region', { name: 'TODO flow', exact: true }).last()
  await expect(flow.getByRole('button', { name: /^Active/ })).toBeVisible()
  await flow.getByRole('button', { name: /^Merged · not active/ }).press('Enter')
  await expect(flow).toContainText('Load failed')
  await expect(flow).toContainText('flows/todo/flow.ts:12')
  await flow.getByRole('button', { name: /^Active/ }).press('Enter')
  await expect(flow).toContainText('pnpm test')
  await say(page, '/todo T2')
  await expect(page.getByText('v1', { exact: true }).last()).toBeVisible()
  await say(page, '/flow todo')
  await expect(page.getByRole('button', { name: /^Previous/ }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: /^Active/ }).last()).toBeVisible()
  await say(page, '/todo T1')
  await page.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
  await expect(page.getByText('v1', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('lockfile_changed', { exact: true })).toHaveCount(0)
})
