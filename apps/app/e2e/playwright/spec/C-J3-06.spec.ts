import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-06.md.
// Requires the forthcoming seeded DesignWorld. Seed T2 asleep, configured public address maya-mini.tail1234.ts.net; schedule Maya joining through SSH and saving retry.ts after the SSH line is copied. SSH authentication, forwarding, SFTP and revocation remain reference-host evidence.
// This scenario does not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J3.2, J3.4, J10.3, §6.15, M-24, M-28, M-29; lands with T-TRM-03, T-ACC-02, T-TRM-07, T-COL-04, T-COL-06, T-REL-02
test("C-J3-06: SSH uses the install address and saved remote edits appear with Maya", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.2, J3.4, J10.3, §6.15, M-24, M-28, M-29; lands with T-TRM-03, T-ACC-02, T-TRM-07, T-COL-04, T-COL-06, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  await expect(page.getByText('Asleep', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'SSH', exact: true }).last().press('Enter')
  await expect(page.getByText('ssh -p 2222 retry-webhooks@maya-mini.tail1234.ts.net', { exact: false }).last()).toBeVisible()
  await expect(page.getByText('Copied', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Maya via SSH', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'retry.ts:12', exact: true }).last()).toBeVisible()
  await expect(page.getByText('Awake', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Maya via SSH changed 1 file', exact: true }).last().press('Enter')
  await expect(page.getByText('src/retry.ts', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/maya remote edit/).last()).toBeVisible()
  await page.reload()
  await say(page, '/branch T2')
  await expect(page.getByText('Maya via SSH', { exact: true }).last()).toBeVisible()
})
