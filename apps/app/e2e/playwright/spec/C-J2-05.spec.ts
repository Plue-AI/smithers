import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J2-05.md; reference-host and
// integration receipts (GitHub, SQL, races, timing) remain separate requirements.
// Requires seeded DesignWorld with the check's members, issues, TODOs and evidence.
// T1 fixes #7; T2 links #8 without fixes. Both have passed required checks and a failed optional check. T1 learning publishes a wiki receipt (also requires T-FLW-06).
// Written before implementation: mvp.md J2.6; lands with T-STK-04
test("C-J2-05: A human merges and opens the learning receipt", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J2.6; lands with T-STK-04")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T1')
  await page.getByRole('button', { name: 'Merge', exact: true }).press('Enter')
  await expect(page.getByText('Review & merge', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await expect(page.getByText('Merged', { exact: true }).first()).toBeVisible()
  await say(page, '/issue 7')
  await expect(page.getByText('Closed', { exact: true })).toBeVisible()
  await say(page, '/todo T2')
  await page.getByRole('button', { name: 'Merge', exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await expect(page.getByText('Merged', { exact: true }).first()).toBeVisible()
  await say(page, '/issue 8')
  await expect(page.getByText('Open', { exact: true }).first()).toBeVisible()
  await say(page, '/todo T1')
  await page.getByRole('button', { name: /[1-9]\d* lessons?/ }).click()
  await expect(page.getByText(/wiki/i).first()).toBeVisible()
})
