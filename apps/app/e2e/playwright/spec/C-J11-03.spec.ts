import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J11-03.md.
// Written before implementation: mvp.md J11.4, §6.5 Models, §6.14 Configure an agent; lands with T-FLW-08
test("C-J11-03: the owner switches the reviewer model immediately", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.4, §6.5 Models, §6.14 Configure an agent; lands with T-FLW-08")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed reviewer on Opus 5.5, an in-flight call on that model, and a
  // later review waiting to start. Host receipts prove call timing and digest.
  await say(page, '/agents')
  for (const name of ['Planner agent', 'Implementer agent', 'Reviewer agent', 'App agent'])
    await expect(page.getByText(name, { exact: true }).last()).toBeVisible()
  await say(page, '/agent reviewer')
  await page.getByRole('button', { name: 'Model: Opus 5.5', exact: true }).last().press('Enter')
  await page.getByRole('option', { name: /Sonnet 5.5/ }).press('Enter')
  await expect(page.getByRole('button', { name: 'Model: Sonnet 5.5', exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Opus 5.5 → Sonnet 5.5/).last()).toBeVisible()
  await page.reload()
  await say(page, '/agent reviewer')
  await expect(page.getByRole('button', { name: 'Model: Sonnet 5.5', exact: true }).last()).toBeVisible()
  await say(page, '/agent app')
  await page.getByRole('button', { name: '.smithers/instructions/app.md', exact: true }).last().press('Enter')
  await expect(page.getByText('.smithers/instructions/app.md', { exact: true }).last()).toBeVisible()
  await say(page, 'Always end answers with the word DONE')
  await expect(page.getByRole('button', { name: 'Confirm', exact: true }).last()).toBeVisible()
  await say(page, '/help')
  await expect(page.getByText('model.compose', { exact: true })).toHaveCount(0)
  await expect(page.getByText('model.ask', { exact: true })).toHaveCount(0)
})
