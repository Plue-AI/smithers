import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-05.md.
// Requires the forthcoming seeded DesignWorld. Seed T7 and T8 In review; deliver ordered GitHub merges, with T7 fixing issue 41 and T8 not fixing issue 42.
// This scenario does not replace the check's backend, timing or reference-host receipts.
// Written before implementation: mvp.md J10.5, §6.3; lands with T-GH-03
test("C-J10-05: GitHub merges update TODOs and only close fixed issues", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J10.5, §6.3; lands with T-GH-03")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/stack')
  await expect(page.getByText('main', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Merged', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await say(page, '/todo T7')
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
  await say(page, '/issue #41')
  await expect(page.getByText('Closed', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('link').filter({ hasText: /T7/ }).last()).toBeVisible()
  await say(page, '/todo T8')
  await expect(page.getByRole('button', { name: 'Merge', exact: true }).last()).toBeVisible()
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible({ timeout: 60_000 })
  await say(page, '/issue #42')
  await expect(page.getByText('Open', { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, '/todo T7')
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible()
})
