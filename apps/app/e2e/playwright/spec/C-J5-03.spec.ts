import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J5-03.md.
// Requires the forthcoming seeded DesignWorld. Seed T1–T5 merged, lint failures on T1/T3/T5, and T5 learning with one proposal. Make TODO creates T6, sync activates v2, and the next TODO T7 passes lint first try. Reference-host receipts cover signatures, closure pins and duplicate learning admission.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J5.5, §6.12 Learning, §10; lands with T-FLW-06, T-REL-02
test("C-J5-03: an evidence-backed learning proposal becomes a human-merged TODO", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J5.5, §6.12 Learning, §10; lands with T-FLW-06, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T5')
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: /1 lesson/ }).last().press('Enter')
  await expect(page.getByText(/3 of the last 5/).last()).toBeVisible()
  for (const ref of ['T1', 'T3', 'T5']) await expect(page.getByRole('link', { name: ref, exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Make TODO', exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Make TODO', exact: true }).last().press('Enter')
  await say(page, '/todo T6')
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await say(page, '/flow todo')
  await expect(page.getByRole('button', { name: /^Active/ }).last()).toBeVisible()
  await say(page, '/todo.new')
  await page.getByLabel('Title', { exact: true }).last().fill('Retry unused imports')
  await page.getByLabel('Prompt', { exact: true }).last().fill('Add retries without unused imports')
  await page.getByRole('button', { name: 'Commit', exact: true }).last().press('Enter')
  await expect(page.getByText('pnpm lint', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Passed/).last()).toBeVisible()
  await expect(page.getByText(/Attempt 1/).last()).toBeVisible()
  await say(page, '/todo T5')
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible()
})
