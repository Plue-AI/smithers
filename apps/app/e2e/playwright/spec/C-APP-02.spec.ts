import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-APP-02.md.
// Written before implementation: mvp.md §6.6 TODO card; lands with T-APP-02
test("C-APP-02: a queued prompt saves once and an agent amendment requires confirmation", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.6 TODO card; lands with T-APP-02")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed parallel 1, T1 Working, T2 Queued with PROMPT-A.
  // The planner later receives PROMPT-B; revision uniqueness needs host receipts.
  await say(page, '/todo T2')
  await page.getByRole('button', { name: 'Edit', exact: true }).last().press('Enter')
  await expect(page.getByLabel('Prompt', { exact: true }).last()).toHaveValue('PROMPT-A')
  await page.getByLabel('Prompt', { exact: true }).last().fill('PROMPT-B')
  await page.getByLabel('Acceptance', { exact: true }).last().fill('The greeting is visible')
  const save = page.getByRole('button', { name: 'Save', exact: true }).last()
  await save.press('Enter')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: /T2/ }).last()).toContainText('PROMPT-B')
  await expect(page.getByText('+1', { exact: true }).last()).toBeVisible()
  await say(page, "Change T2's prompt to PROMPT-C")
  await expect(page.getByRole('button', { name: 'Confirm', exact: true }).last()).toBeVisible()
  await say(page, '/todo T2')
  await expect(page.getByRole('region', { name: /T2/ }).last()).toContainText('PROMPT-B')
  await expect(page.getByRole('region', { name: /T2/ }).last()).not.toContainText('PROMPT-C')
  await page.reload()
  await say(page, '/todo T2')
  await expect(page.getByRole('region', { name: /T2/ }).last()).toContainText('PROMPT-B')
})
