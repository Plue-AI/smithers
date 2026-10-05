import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J11-04.md.
// Authenticated ingest of the three journals, edit/attempt boundaries, replay
// determinism, clearing after a passing check and zero detector model calls need
// packages/backend/internal/services/run_thrash_integration_test.go receipts.
// The mounted design fixture uses T9 and pnpm test (journeys/run.ts).
test("C-J11-04: unchanged failures show a thrashing indicator and failed output", async ({ page }) => {
  await owner(page)
  await page.goto("/acme/api")
  await say(page, '/todo T9')
  const todo = page.getByRole('region', { name: 'T9 Retry failed webhooks with backoff', exact: true })
  await expect(todo.getByText('Thrashing: pnpm test failed 3×', { exact: true })).toBeVisible()
  await todo.getByRole('button', { name: 'Inspect', exact: true }).press('Enter')
  const timeline = page.getByRole('navigation', { name: 'Run timeline', exact: true })
  await expect(timeline).toContainText('Ran tests · 1 failed ×3')
  await expect(timeline.locator('li[data-tone="thrash"]')).toContainText('Thrashing: pnpm test failed 3×')
  await timeline.getByRole('button', { name: /Ran them a third time/ }).press('Enter')
  await expect(page.getByRole('region', { name: 'Selected cell', exact: true })).toContainText('test timed out after 5000 ms')
  await page.getByRole('button', { name: 'Restore', exact: true }).press('Enter')
  for (const ref of ['T8', 'T10']) {
    await say(page, `/todo ${ref}`)
    await expect(page.locator('[data-kind="todo"]').last()).not.toContainText('Thrashing')
  }
})
