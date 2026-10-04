import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J5-01.md.
// Requires the forthcoming seeded DesignWorld. Seed T1 waiting at v1; the chat edit drafts T2 at v1, merge holds sync until the Flow card opens, and T3 starts at v2. T1 fails once after Answer. Real activation, immutable closure bytes and watchdogs remain reference-host evidence.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J5.1–J5.4, §6.12 Pinned versions; lands with T-FLW-03, T-FLW-04, T-FLW-05, T-FLW-11, T-APP-05, T-REL-02
test("C-J5-01: flow edits activate after merge while existing TODOs keep their pin", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J5.1–J5.4, §6.12 Pinned versions; lands with T-FLW-03, T-FLW-04, T-FLW-05, T-FLW-11, T-APP-05, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T1')
  await expect(page.getByText('v1', { exact: true }).last()).toBeVisible()
  await say(page, 'Every TODO must run pnpm test and update the changelog.')
  await expect(page.getByRole('region', { name: 'TODO flow', exact: true }).last()).toBeVisible()
  await expect(page.getByText('flows/todo/flow.ts', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Make TODO', exact: true }).last().press('Enter')
  await say(page, '/todo T2')
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('v1', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await expect(page.getByText('Merged · active after sync', { exact: true }).last()).toBeVisible()
  await say(page, '/flow todo')
  await expect(page.getByRole('button', { name: /^Active/ }).last()).toBeVisible()
  await say(page, '/todo.new')
  await page.getByLabel('Title', { exact: true }).last().fill('Add retry coverage')
  await page.getByLabel('Prompt', { exact: true }).last().fill('Add retry coverage and update the changelog')
  await page.getByRole('button', { name: 'Commit', exact: true }).last().press('Enter')
  await expect(page.getByText('v2', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('pnpm test', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/changelog/i).last()).toBeVisible()
  await say(page, '/todo T1')
  await page.getByPlaceholder('Answer the coding agent').last().fill('Edit retry.ts')
  await page.getByRole('button', { name: 'Answer', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
  await expect(page.getByText('v1', { exact: true }).last()).toBeVisible()
})
