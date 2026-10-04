import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J6-01.md.
// Requires the forthcoming seeded DesignWorld. Seed Ben signed in, T1 asking a question and T2 queued. Ben terminal auth reports identity; claude consumes the seeded skill scenario to read wiki, answer, steer and draft a follow-up. Hold the draft until Confirm and merge until Cancel. Token isolation/revocation and separate S1/S2 authorization require reference-host receipts.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J6.1–J6.3, M-21, M-34; lands with T-TRM-02, T-APP-09, T-REL-02
test("C-J6-01: a terminal agent acts for Ben and waits for his confirmation", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J6.1–J6.3, M-21, M-34; lands with T-TRM-02, T-APP-09, T-REL-02")
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T1')
  await page.getByRole('button', { name: 'Terminal', exact: true }).last().press('Enter')
  const terminal = page.getByRole('region', { name: /Ben.*output/ }).last()
  await terminal.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('smthrs auth status')
  await page.keyboard.press('Enter')
  await expect(terminal).toContainText('Ben')
  await page.keyboard.type('claude')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Claude Code for Ben', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Ben answered/).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Confirm', exact: true }).last()).toBeVisible()
  await say(page, '/stack')
  await expect(page.getByText('Agent follow-up', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Confirm', exact: true }).last().press('Enter')
  await expect(page.getByText('Agent follow-up', { exact: true }).last()).toBeVisible()
  await say(page, '/branch T1')
  await expect(page.getByText('Claude Code for Ben', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Review & merge/).last()).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().press('Enter')
  await say(page, '/todo T1')
  await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Merged', { exact: true })).toHaveCount(0)
})
