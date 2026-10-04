import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-03.md.
// Requires the forthcoming seeded DesignWorld. Seed T2 Needs you and retry.ts open; schedule Maya formatting twelve files, a newer deliver.ts write after diff opens, ignored-path writes, then an unattributable two-session burst.
// This scenario does not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J3.4, §6.8, M-27; lands with T-COL-04, T-COL-12, T-APP-10
test("C-J3-03: outside edits arrive live as one attributed burst and restore refuses stale files", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.4, §6.8, M-27; lands with T-COL-04, T-COL-12, T-APP-10")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  await say(page, '/file retry.ts')
  const burst = page.getByRole('button', { name: 'Maya via SSH changed 12 files', exact: true })
  await expect(burst).toHaveCount(1)
  await expect(page.getByText('Maya via SSH', { exact: true }).last()).toBeVisible()
  await burst.press('Enter')
  await expect(page.getByText('deliver.ts', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'retry.ts', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Restore this file', exact: true }).last().press('Enter')
  await expect(page.getByText('Ben changed 1 file', { exact: true }).last()).toBeVisible()
  await burst.press('Enter')
  await page.getByRole('button', { name: 'deliver.ts', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Restore this file', exact: true }).last().press('Enter')
  await expect(page.getByRole('group', { name: 'Live and outside versions', exact: true }).last()).toBeVisible()
  await expect(page.getByText(/node_modules\//)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Changed outside Smithers.*1 file/ }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
  await expect(page.getByText('ran pnpm format', { exact: true })).toHaveCount(0)
  await say(page, '/todo.answer T2 "use the existing retry helper"')
  await expect(page.getByText('Read', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'retry.ts', exact: true }).last()).toBeVisible()
})
