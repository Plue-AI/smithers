import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J3-02.md.
// Requires the forthcoming seeded DesignWorld. Seed Ben signed in, T1 awake, Alice owning a running terminal with five ordered ticks; schedule Alice removal after reload. Raw socket attacks and host permission evidence belong to the reference-host check.
// This scenario does not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J3.3, J6.5, §6.8, M-18; lands with T-TRM-01, T-APP-12
test("C-J3-02: a personal terminal runs as its owner and watched output stays read-only", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.3, J6.5, §6.8, M-18; lands with T-TRM-01, T-APP-12")
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/branch T1')
  await page.getByRole('button', { name: 'New terminal', exact: true }).press('Enter')
  const own = page.getByRole('region', { name: "Ben’s terminal output", exact: true }).last()
  await own.press('Enter')
  await page.keyboard.insertText('id -un; echo $HOME; pwd; umask')
  await page.keyboard.press('Enter')
  await expect(own).toContainText('ben')
  await expect(own).toContainText('/home/ben')
  await expect(own).toContainText('/workspace')
  await expect(own).toContainText('0002')
  await say(page, '/branch T1')
  await page.getByRole('tab', { name: /^Terminals/ }).last().press('Enter')
  await page.getByRole('button', { name: /Alice.*terminal/ }).last().press('Enter')
  const watched = page.getByRole('region', { name: "Alice’s terminal output", exact: true }).last()
  await expect(page.getByText('Watching', { exact: true }).last()).toBeVisible()
  await expect(watched).toContainText(/tick 1[\s\S]*tick 2[\s\S]*tick 3[\s\S]*tick 4[\s\S]*tick 5/)
  await watched.press('Enter')
  await page.keyboard.insertText('touch /workspace/ben-was-here')
  await page.keyboard.press('Enter')
  await expect(watched).not.toContainText('touch /workspace/ben-was-here')
  await expect(page.getByRole('button', { name: 'Ask to type', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(watched).toContainText('tick 5')
  await expect(watched).toHaveCount(0)
  await expect(own).toBeVisible()
})
