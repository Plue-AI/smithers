import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J2-03.md; reference-host and
// integration receipts (GitHub, SQL, races, timing) remain separate requirements.
// Requires seeded DesignWorld with the check's members, issues, TODOs and evidence.
// T1 has an open retry-policy question; Ben wins the held answer race. The current member retains a losing answer. Multi-browser toast/timing receipts await the member seed seam.
// Written before implementation: mvp.md J2.4; lands with T-STK-01
test("C-J2-03: A question keeps Chat usable and a late answer can become a steer", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J2.4; lands with T-STK-01")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T1')
  await expect(page.getByText('Needs you', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/backoff or a fixed delay/)).toBeVisible()
  await page.getByRole('textbox', { name: /Answer the coding agent/ }).fill('Use backoff')
  await page.getByRole('button', { name: 'Answer', exact: true }).last().press('Enter')
  // Seed a competing accepted answer by Ben before this answer is admitted.
  await expect(page.getByText('Ben answered', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: /Answer the coding agent/ })).toHaveValue('Use backoff')
  await page.getByRole('button', { name: 'Send as steer', exact: true }).press('Enter')
  await expect(page.getByText('Use backoff', { exact: true })).toBeVisible()
  await say(page, 'Show the current retry policy')
  await expect(page.getByText('Show the current retry policy', { exact: true }).first()).toBeVisible()
})
