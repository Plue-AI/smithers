import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-09.md.
// Requires the forthcoming seeded DesignWorld. Seed Ben on T2 with retry.ts edits. Schedule Maya moving off T2 on entry and again after Return; after Keep hold the move until the next branch reopen, then schedule Maya returning. Reference-host checks cover concurrent Return, recoverable notes.txt, metadata watches and refused agent writes.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md §6.8 External changes, M-14, M-27; lands with T-COL-05
test("C-J3-09: return restores a moved branch; Keep for now preserves Needs you", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8 External changes, M-14, M-27; lands with T-COL-05")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  await expect(page.getByText(/Maya moved (this branch )?off T2/).last()).toBeVisible()
  await expect(page.getByText('Needs you', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Return to T2', exact: true }).last().press('Enter')
  await expect(page.getByText('Working', { exact: true }).last()).toBeVisible()
  await say(page, '/file src/retry.ts')
  await expect(page.getByText('// retained retry edit', { exact: true }).last()).toBeVisible()
  await say(page, '/branch T2')
  await expect(page.getByText(/Maya moved (this branch )?off T2/).last()).toBeVisible()
  await page.getByRole('button', { name: 'Keep for now', exact: true }).last().press('Enter')
  await page.reload()
  await expect(page.getByText('Needs you', { exact: true }).last()).toBeVisible()
  await say(page, '/branch T2')
  await expect(page.getByText('Working', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Return to T2', exact: true })).toHaveCount(0)
})
