import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J7-03.md.
// Requires the forthcoming seeded DesignWorld. Seed one agent-resolved T2 and one failed-conflict T3 on retry.ts. Done rejects conflict markers and accepts a clean edit. Resolution attempt counts, approval invalidation and restart fences require integration receipts.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J7.4, §4.2 Rebase, §4.1 Needs you; lands with T-STK-08, T-REL-02
test("C-J7-03: an unresolved rebase waits for a clean human resolution", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J7.4, §4.2 Rebase, §4.1 Needs you; lands with T-STK-08, T-REL-02")
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  await expect(page.getByText('Rebased onto main', { exact: true }).last()).toBeVisible()
  await say(page, '/todo T3')
  await expect(page.getByText('Needs you', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Resolve', exact: true }).last().press('Enter')
  await expect(page.getByText('src/retry.ts', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Done', exact: true }).last().press('Enter')
  await expect(page.getByText(/still.*conflict/i).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Done', exact: true }).last()).toBeVisible()
  await page.getByRole('textbox', { name: /src\/retry.ts/ }).last().fill('export const retry = () => 2')
  await page.getByRole('button', { name: 'Done', exact: true }).last().press('Enter')
  await say(page, '/todo T3')
  await expect(page.getByText('Working', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('pnpm test', { exact: true }).last()).toBeVisible()
})
