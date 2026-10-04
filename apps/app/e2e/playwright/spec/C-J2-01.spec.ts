import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J2-01.md; reference-host and
// integration receipts (GitHub, SQL, races, timing) remain separate requirements.
// Requires seeded DesignWorld with the check's members, issues, TODOs and evidence.
// Issue #7 has three comments, including the retry requirement; T1 and T2 are queued.
// Written before implementation: mvp.md J2.2; lands with T-STK-09
test("C-J2-01: Issue discussion drafts an editable, placed TODO", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J2.2; lands with T-STK-09")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/issue 7')
  await page.getByRole('button', { name: 'Make TODO', exact: true }).press('Enter')
  const prompt = page.getByLabel('Prompt', { exact: true })
  await expect(prompt).toHaveValue(/retry at most 5 times with jittered backoff/)
  await expect(page.getByLabel('Closes #7 when merged')).toBeChecked()
  await prompt.fill(`${await prompt.inputValue()} Log each retry.`)
  await page.getByRole('button', { name: 'Append', exact: true }).click()
  await page.getByRole('option', { name: /Before T2/ }).click()
  await page.getByRole('button', { name: 'Commit', exact: true }).press('Enter')
  await expect(page.getByText(/Committed as T3/)).toBeVisible()
  await say(page, '/todo T3')
  await expect(page.getByText(/Log each retry\./)).toBeVisible()
  await say(page, '/home')
  const stack = page.getByRole('list', { name: 'Stack', exact: true })
  await expect(stack.getByRole('listitem').filter({ hasText: /T[123]/ })).toHaveText([/T1/, /T3/, /T2/])
  await page.reload()
  await expect(stack.getByRole('listitem').filter({ hasText: 'T3' })).toHaveCount(1)
})
