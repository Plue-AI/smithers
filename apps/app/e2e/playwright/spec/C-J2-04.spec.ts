import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J2-04.md; reference-host and
// integration receipts (GitHub, SQL, races, timing) remain separate requirements.
// Requires seeded DesignWorld with the check's members, issues, TODOs and evidence.
// T1 attempt 1 is In review: clamp diff, passing machine checks, required ci, review, usage and authorized log. Producer-ownership and denied-log cases belong to the integration receipt.
// Written before implementation: mvp.md J2.5; lands with T-STK-01
test("C-J2-04: In-review evidence includes machine checks, GitHub checks and review", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J2.5; lands with T-STK-01")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T1')
  await expect(page.getByText('In review', { exact: true }).first()).toBeVisible()
  for (const text of ['pnpm test', 'pnpm lint', 'ci', 'required']) {
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible()
  }
  await expect(page.getByText(/clamp.*review|review.*clamp/i)).toBeVisible()
  await expect(page.getByText(/tokens/).first()).toBeVisible()
  await expect(page.getByText(/ChatGPT|provider key/).first()).toBeVisible()
  await expect(page.getByText('not measured yet', { exact: false })).toHaveCount(0)
  await page.getByRole('button', { name: 'Diff', exact: true }).press('Enter')
  await expect(page.getByText('src/math.ts', { exact: false }).first()).toBeVisible()
  await say(page, '/todo T1')
  await page.getByRole('link', { name: /pnpm test|Log/ }).first().click()
  await expect(page.getByText(/tests passed/).first()).toBeVisible()
})
