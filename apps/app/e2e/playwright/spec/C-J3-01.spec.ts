import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-01.md.
// Requires the forthcoming seeded DesignWorld. Seed T2 awake with Alice at retry.ts:12, Maya over SSH, coding agent implementing retry.ts, Claude Code for Ben, Smithers for Ben and Reviewer for Ben; scheduled participant departure follows terminal watch.
// This scenario does not replace the check's backend, timing or reference-host receipts.
// Written before implementation: mvp.md J3.2–J3.3, §6.8, M-17; lands with T-COL-06, T-APP-10, T-REL-02
test("C-J3-01: branch presence names participants and their live location", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.2–J3.3, §6.8, M-17; lands with T-COL-06, T-APP-10, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  const presence = page.getByRole('list', { name: 'On this branch', exact: true }).last()
  await expect(presence.getByText('Alice', { exact: true }).last()).toBeVisible()
  await expect(presence.getByText('Maya via SSH', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'retry.ts:12', exact: true }).first()).toBeVisible()
  for (const name of ['Coding agent for Ben', 'Claude Code for Ben', 'Smithers for Ben', 'Reviewer for Ben']) {
    await expect(page.getByText(name, { exact: true }).last()).toBeVisible()
  }
  await expect(page.getByText(/Implement/).last()).toBeVisible()
  await page.getByRole('button', { name: 'New terminal', exact: true }).press('Enter')
  await expect(page.getByText(/Ben.*terminal/).last()).toBeVisible()
  await say(page, '/branch T2')
  await expect(page.getByText('watching', { exact: true }).last()).toBeVisible()
  await expect(presence.getByText('Alice', { exact: true })).toHaveCount(1)
  await expect(presence.getByText('Maya via SSH', { exact: true })).toHaveCount(0)
  await expect(presence.getByText('Claude Code for Ben', { exact: true })).toHaveCount(0)
  await expect(presence.getByText('Alice', { exact: true })).toHaveCount(0)
  await page.reload()
  await say(page, '/branch T2')
  await expect(presence.getByText('Maya via SSH', { exact: true })).toHaveCount(0)
})
