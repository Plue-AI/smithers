import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-10.md.
// Requires the forthcoming seeded DesignWorld. Seed T2 checking pnpm test with its Agent terminal; hold completion until the watcher types x, then publish PASS retry.test.ts and exit 0. Reference-host receipts verify dropped input counters and tool-result equality.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md §11 stage 2 item 10, §3.1; lands with T-TRM-05, T-REL-02
test("C-J3-10: the coding agent terminal streams checks and remains watch-only", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §11 stage 2 item 10, §3.1; lands with T-TRM-05, T-REL-02")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  await page.getByRole('tab', { name: /Terminals/ }).last().press('Enter')
  await page.getByRole('button', { name: 'Agent', exact: true }).last().press('Enter')
  const output = page.getByRole('region', { name: 'Agent output', exact: true }).last()
  await expect(output).toContainText('pnpm test')
  await expect(page.getByText('Watching', { exact: true }).last()).toBeVisible()
  await output.click()
  await page.keyboard.type('x')
  await expect(output).not.toContainText('$ x')
  await expect(output).toContainText('PASS retry.test.ts')
  await expect(output).toContainText('exit 0')
  await say(page, '/todo T2')
  await expect(page.getByText('pnpm test', { exact: true }).last()).toBeVisible()
})
