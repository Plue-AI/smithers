import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J10-03.md.
// Real GitHub, authorization, timing and reference-host receipts remain required.
// Requires the forthcoming seeded DesignWorld. Seed Alice foreign pushes A1 then A2, and hold a candidate until each displayed wait is settled.
// Written before implementation: mvp.md J10.3, M-33; lands with T-GH-06
test("C-J10-03: Seed Alice foreign pushes A1 then A2, and hold a candidate until each displayed wait is settled.", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J10.3, M-33; lands with T-GH-06")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T4')
  await expect(page.getByText("Alice pushed to smithers/retry-webhooks on GitHub", { exact: true })).toBeVisible()
  await expect(page.getByText('Needs you', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: "Bring in Alice's commit", exact: true }).press('Enter')
  await expect(page.getByText('Working', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Diff', exact: true }).last().press('Enter')
  await expect(page.getByText("// Alice's retry log", { exact: true })).toBeVisible()
  await say(page, '/todo.steer T4 also log the attempt number')
  await say(page, '/todo T4')
  await expect(page.getByText('Needs you', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('link', { name: 'A2', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Discard', exact: true }).last().press('Enter')
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Open branch', exact: true }).last().press('Enter')
  await expect(page.getByText(/Discarded.*Alice/).last()).toBeVisible()
  await page.reload()
  await say(page, '/todo T4')
  await expect(page.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(0)
})
