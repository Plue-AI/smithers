import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-06.md.
// Reference-host receipts still required: network loss, persisted Retry-After/budget
// admission, unresolved remote Retry, installation refusal, live deltas and restart.
test("C-J10-06: sync age becomes stale and Retry refreshes main", async ({ page }) => {
  await page.clock.install()
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/stack')
  const sync = page.locator('.mvp-sync').first()
  await expect(sync).toContainText(/synced [0-9]+ s ago/)
  await expect(sync).not.toHaveAttribute('data-stale', 'true')
  await page.clock.fastForward(70_000)
  await expect(sync).not.toHaveAttribute('data-stale', 'true')
  await expect(sync.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await page.clock.fastForward(290_000)
  await expect(sync).toContainText(/synced [67] min ago/)
  await expect(sync).toHaveAttribute('data-stale', 'true')
  await sync.getByRole('button', { name: 'Retry', exact: true }).press('Enter')
  await expect(sync).toContainText(/synced [0-9]+ s ago/)
  await expect(sync).not.toHaveAttribute('data-stale', 'true')
  await say(page, '/github')
  await expect(page.locator('.mvp-home').first()).toBeVisible()
  await expect(page.getByTestId('composer-input')).toHaveValue('')
})
