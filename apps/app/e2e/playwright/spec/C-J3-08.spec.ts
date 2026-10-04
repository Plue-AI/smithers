import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-08.md.
// Requires the forthcoming seeded DesignWorld. Seed retry.ts and webhook.ts open; schedule Maya deletion, rename to deliver.ts after Restore, and atomic save after Follow. Repeat the seed with Alice live edits when co-editing lands.
// This scenario does not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md §6.8, M-27; lands with T-APP-11, T-REL-02
test("C-J3-08: deleted files retain a snapshot and renamed files follow in place", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8, M-27; lands with T-APP-11, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  await say(page, '/file src/retry.ts')
  await say(page, '/file src/webhook.ts')
  await expect(page.getByText('Deleted by Maya via SSH', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Snapshot', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('// latest retry snapshot', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'src/retry.ts', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Restore', exact: true }).last().press('Enter')
  await expect(page.getByText('Deleted by Maya via SSH', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Ben changed 1 file', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Renamed to.*deliver.ts.*Maya via SSH/).last()).toBeVisible()
  await page.getByRole('button', { name: 'Follow', exact: true }).last().press('Enter')
  await expect(page.getByText('src/deliver.ts', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('// atomic save retained', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Follow', exact: true })).toHaveCount(0)
  await expect(page.getByText('Deleted by Maya via SSH', { exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, '/file src/deliver.ts')
  await expect(page.getByText('// atomic save retained', { exact: true }).last()).toBeVisible()
})
