import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J7-02.md.
// Requires the forthcoming seeded DesignWorld. Seed T2 working with verified retry.ts and an unrelated uncaptured edit. Fork form creates retry-v2; terminal commit captures the backoff edit; agent Add to stack waits for confirmation. GitHub absence, head equality and uninterrupted run need reference-host receipts.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J7.2–J7.3, §6.7, Appendix A, M-22; lands with T-MCH-08, T-STK-05
test("C-J7-02: scratch work joins the stack before its source is dropped", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J7.2–J7.3, §6.7, Appendix A, M-22; lands with T-MCH-08, T-STK-05")
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  await page.getByRole('button', { name: 'Fork', exact: true }).last().press('Enter')
  await page.getByLabel('Name', { exact: true }).last().fill('retry-v2')
  await page.getByRole('button', { name: 'Fork', exact: true }).last().press('Enter')
  await expect(page.getByText('scratch/ben/retry-v2', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Terminal', exact: true }).last().press('Enter')
  const terminal = page.getByRole('region', { name: /Ben.*output/ }).last()
  await terminal.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type("printf 'export const backoff = 2\n' >> src/retry.ts")
  await page.keyboard.press('Enter')
  await page.keyboard.type('jj commit -m "try exponential backoff"')
  await page.keyboard.press('Enter')
  await say(page, 'Add scratch/ben/retry-v2 to the stack')
  await expect(page.getByRole('button', { name: /Add to stack/ }).last()).toBeVisible()
  await say(page, '/stack')
  await expect(page.getByText('T4', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /Add to stack/ }).last().press('Enter')
  await say(page, '/todo.drop T2')
  await page.getByRole('button', { name: 'Drop', exact: true }).last().press('Enter')
  await expect(page.getByText('Dropped', { exact: true }).last()).toBeVisible()
  await say(page, '/stack')
  await expect(page.getByRole('region', { name: /Stack/ }).last()).toContainText(/T1[\s\S]*T4[\s\S]*T3/)
  await say(page, '/branch T4')
  await page.getByRole('tab', { name: /Files/ }).last().press('Enter')
  await page.getByText('src/retry.ts', { exact: true }).last().click()
  await expect(page.getByText('export const backoff = 2', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Replace T2', exact: true })).toHaveCount(0)
})
