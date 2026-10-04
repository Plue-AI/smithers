import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-04.md.
// Requires the forthcoming seeded DesignWorld. Seed retry.ts with eighty lines; Alice types remotely at lines 40 and 20 while Ben edits, agent writes line 70, then an outside overlapping save occurs. Restart and forty watcher-ordering trials remain reference-host evidence.
// This scenario does not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J3.5, §6.8, §9, §12.1, M-02; lands with T-COL-08, T-APP-14, T-APP-14a, T-COL-08a, T-COL-08b
test("C-J3-04: live file editing preserves remote characters and exposes outside comparison", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.5, §6.8, §9, §12.1, M-02; lands with T-COL-08, T-APP-14, T-APP-14a, T-COL-08a, T-COL-08b")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T2')
  await say(page, '/file retry.ts')
  const editor = page.getByRole('textbox', { name: 'retry.ts', exact: true }).last()
  await editor.press('Control+Home')
  await editor.press('End')
  await editor.press('Enter')
  await editor.pressSequentially('// Ben keeps retries bounded', { delay: 125 })
  await expect(editor).toHaveValue(/Ben keeps retries bounded/)
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(page.getByText('Alice', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Saved to the machine', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await expect(editor).toHaveValue(/Coding agent comment/)
  await expect(page.getByText('Changed outside Smithers', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Compare', exact: true }).last().press('Enter')
  await expect(page.getByRole('group', { name: 'Live and outside versions', exact: true }).last()).toContainText('maya')
  await expect(editor).toHaveValue(/Ben keeps retries bounded/)
  await page.reload()
  await say(page, '/file retry.ts')
  await expect(editor).toHaveValue(/Ben keeps retries bounded/)
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  for (const path of ['big.json', 'logo.png']) {
    await say(page, `/file ${path}`)
    await expect(page.getByText('too large to co-edit', { exact: true }).last()).toBeVisible()
    await expect(page.getByRole('textbox', { name: path, exact: true })).toHaveCount(0)
  }
})
