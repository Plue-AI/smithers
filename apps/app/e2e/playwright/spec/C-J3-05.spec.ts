import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-05.md.
// Requires the forthcoming seeded DesignWorld. Seed T1 implementing webhook delivery; Ben is the signed-in member; schedule Claude Code for Ben sending keep the max at 5, then the same attempt reaching In review.
// This scenario does not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J3.6, §6.6, §6.8, M-21; lands with T-STK-06
test("C-J3-05: steers keep their authors and the same attempt while chat stays usable", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.6, §6.6, §6.8, M-21; lands with T-STK-06")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T1')
  await expect(page.getByText('Implement', { exact: true }).last()).toBeVisible()
  await say(page, '/todo.steer T1 "use the existing retry helper"')
  await expect(page.getByText('use the existing retry helper', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Ben', { exact: true }).last()).toBeVisible()
  await say(page, '/diff')
  await expect(page.getByText('keep the max at 5', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Claude Code for Ben', { exact: true }).last()).toBeVisible()
  await say(page, '/branch T1')
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Attempt 1', { exact: true }).last()).toBeVisible()
  await say(page, '/diff')
  await expect(page.getByText(/import.*withRetry.*retry/).last()).toBeVisible()
  await expect(page.getByText(/maxAttempts.*5/).last()).toBeVisible()
  await page.reload()
  await say(page, '/branch T1')
  await expect(page.getByText('use the existing retry helper', { exact: true })).toHaveCount(1)
  await expect(page.getByText('keep the max at 5', { exact: true })).toHaveCount(1)
})
