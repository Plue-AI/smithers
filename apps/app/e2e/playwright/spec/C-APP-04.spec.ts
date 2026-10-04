import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-APP-04.md.
// Written before implementation: mvp.md §3 Conversation, §6.4 Branch conversations, M-08; lands with T-APP-16
test("C-APP-04: shared entries persist while drafts and Earlier stay private", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §3 Conversation, §6.4 Branch conversations, M-08; lands with T-APP-16")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed main's shared entries plus three owner-private legacy archives.
  // Multi-member isolation, ordered subscriptions and host execution need
  // the ticket's integration suite; this projection tests the UI doors.
  await say(page, 'Show the repository summary')
  await expect(page.getByText('Show the repository summary', { exact: true }).last()).toBeVisible()
  await say(page, '/todo.new')
  await page.getByLabel('Title', { exact: true }).last().fill('Private draft canary-7Q4')
  await page.getByLabel('Prompt', { exact: true }).last().fill('Keep this private until Commit')
  await page.reload()
  await expect(page.getByText('Show the repository summary', { exact: true }).last()).toBeVisible()
  await expect(page.getByLabel('Title', { exact: true }).last()).toHaveValue('Private draft canary-7Q4')
  await page.getByRole('button', { name: 'Earlier', exact: true }).press('Enter')
  await expect(page.getByRole('button', { name: /Legacy conversation/ })).toHaveCount(3)
  await page.getByRole('button', { name: /Legacy conversation/ }).first().press('Enter')
  await expect(page.getByText('Read-only', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Archived greeting', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByText('Show the repository summary', { exact: true }).last()).toBeVisible()
})
