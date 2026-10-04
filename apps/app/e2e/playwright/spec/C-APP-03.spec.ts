import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-APP-03.md.
// Written before implementation: mvp.md §6.15, Appendix B image.add; lands with T-APP-02, T-APP-03
test("C-APP-03: a missing package drafts a reviewed machine recipe change", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.15, Appendix B image.add; lands with T-APP-02, T-APP-03")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed T1 failed: figlet missing, recipe packages [jq]. Settings uses
  // the same draft command. Guest rebuild and retry need reference-host evidence.
  await say(page, '/todo T1')
  await expect(page.getByText('figlet', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Add to machine image', exact: true }).last().press('Enter')
  await expect(page.getByLabel('Title', { exact: true }).last()).toHaveValue('Add figlet to the machine image')
  await expect(page.getByText('.smithers/machine.json', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('region', { name: /Seed|Diff/ }).last()).toContainText('"jq", "figlet"')
  await page.getByRole('button', { name: 'Discard', exact: true }).last().press('Enter')
  await say(page, '/settings')
  await page.getByLabel(/Package/).last().fill('Fig Let')
  await page.getByRole('button', { name: 'Add to machine image', exact: true }).last().press('Enter')
  await expect(page.getByLabel(/Package/).last()).toHaveValue('Fig Let')
  await expect(page.getByRole('alert').last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toHaveCount(0)
  await page.getByLabel(/Package/).last().fill('figlet')
  await page.getByRole('button', { name: 'Add to machine image', exact: true }).last().press('Enter')
  await expect(page.getByLabel('Title', { exact: true }).last()).toHaveValue('Add figlet to the machine image')
  await expect(page.getByRole('region', { name: /Seed|Diff/ }).last()).toContainText('"jq", "figlet"')
})
