import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J8-01.md.
// Requires the forthcoming seeded DesignWorld. Seed merged T7 with two attempts, PR 41 and completed learning citing Ben’s retry-helper steer. Replay once on reload. Database authorship, run admission and durable delta idempotency require integration receipts.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J8.1, §6.12 Learning, M-15; lands with T-FLW-06, T-REL-02
test("C-J8-01: learning records a decision with its source change", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J8.1, §6.12 Learning, M-15; lands with T-FLW-06, T-REL-02")
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T7')
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: /1 lesson/ }).last().press('Enter')
  await page.getByRole('link', { name: /retries/i }).last().press('Enter')
  await expect(page.getByText('Decision', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Learning', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/use the existing retry helper/).last()).toBeVisible()
  await expect(page.getByRole('link', { name: /#41/ }).last()).toBeVisible()
  await expect(page.getByRole('link', { name: /Attempt 1/ }).last()).toBeVisible()
  await expect(page.getByRole('link', { name: /Attempt 2/ }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText('Decision', { exact: true })).toHaveCount(1)
  await say(page, '/todo T7')
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible()
})
