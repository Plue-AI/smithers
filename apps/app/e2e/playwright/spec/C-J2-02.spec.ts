import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J2-02.md; reference-host and
// integration receipts (GitHub, SQL, races, timing) remain separate requirements.
// Requires seeded DesignWorld with the check's members, issues, TODOs and evidence.
// Issue #5 is edited to B2 after label admission captured B1 in T1. Replay label deliveries before reload. Backend migration/crash cases belong to the cited integration check.
// Written before implementation: mvp.md J2.2; lands with T-STK-09
test("C-J2-02: Label admission preserves the captured prompt across issue edits", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J2.2; lands with T-STK-09")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T1')
  await expect(page.getByText('Retry webhooks', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('B1', { exact: true })).toBeVisible()
  await say(page, '/issue 5')
  await expect(page.getByText('Retry webhooks v2', { exact: true })).toBeVisible()
  await expect(page.getByText('B2', { exact: true })).toBeVisible()
  await say(page, '/todo T1')
  await expect(page.getByText('B1', { exact: true })).toBeVisible()
  await expect(page.getByText('B2', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('B1', { exact: true })).toBeVisible()
  await say(page, '/home')
  await expect(page.getByRole('list', { name: 'Stack', exact: true }).getByRole('listitem').filter({ hasText: 'T1' })).toHaveCount(1)
})
