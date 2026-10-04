import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J4-01.md; reference-host and
// integration receipts (GitHub, SQL, races, timing) remain separate requirements.
// Requires seeded DesignWorld with the check's members, issues, TODOs and evidence.
// Seed J4 counts, five unseen merges, host capacity, and two failed background runs. Shared-member snapshots and role restrictions require the forthcoming member seed seam.
// Written before implementation: mvp.md J4.1; lands with T-APP-01
test("C-J4-01: Home exposes stack counts, durable filters and background failures", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J4.1; lands with T-APP-01")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/home')
  const filters = page.getByRole('toolbar', { name: 'Filter by state' })
  for (const name of [/Needs you.*2/, /Working.*3/, /Queued.*1/, /In review.*4/]) {
    await expect(filters.getByRole('button', { name })).toBeVisible()
  }
  await expect(page.getByText('5 merged since you looked', { exact: true })).toBeVisible()
  await expect(page.getByText(/synced \d+ s ago/)).toBeVisible()
  await expect(page.getByText(/\d+\/\d+ machines/)).toBeVisible()
  await filters.getByRole('button', { name: /Needs you/ }).press('Enter')
  await page.reload()
  await expect(filters.getByRole('button', { name: /Needs you/ })).toHaveAttribute('aria-pressed', 'true')
  const stack = page.getByRole('list', { name: 'Stack', exact: true })
  await expect(stack.getByText('Working', { exact: true })).toHaveCount(0)
  const runs = page.getByRole('list', { name: 'Background runs' })
  await expect(runs.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(2)
  await runs.getByRole('button', { name: 'Dismiss', exact: true }).last().press('Enter')
  await page.reload()
  await expect(runs.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(1)
  await runs.getByRole('button', { name: 'Retry', exact: true }).press('Enter')
  await expect(runs.getByText(/Working|Running/).first()).toBeVisible()
})
