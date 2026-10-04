import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J6-02.md.
// Requires the forthcoming seeded DesignWorld. Seed Ben as maintainer, a laptop Claude Code delegated action creating T4, and its pending merge request for T1. CLI credential scope, direct API refusals and GitHub merge counts require integration receipts.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J6.3–J6.4, §6.13, M-21; lands with T-ACC-04, T-APP-04, T-REL-02
test("C-J6-02: a laptop agent leaves merge approval to the member", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J6.3–J6.4, §6.13, M-21; lands with T-ACC-04, T-APP-04, T-REL-02")
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/settings')
  await expect(page.getByText('Laptop agents', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/smthrs login https:\/\/maya-mini/).last()).toBeVisible()
  await say(page, '/todo T4')
  await expect(page.getByText('Claude Code for Ben', { exact: true }).last()).toBeVisible()
  await say(page, '/todo T1')
  await expect(page.getByText(/Review & merge/).last()).toBeVisible()
  await expect(page.getByText('Merged', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible()
})
