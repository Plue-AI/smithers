import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J8-02.md.
// Requires the forthcoming seeded DesignWorld. Seed decisions/retries with three earlier revisions and shared Ben/Alice documents. UI bodies below assert concurrent text and recovery; reference-host receipts measure 400 character latencies, idle batching and retired protocol removal.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J8.2, §6.11 Pages and editing; lands with T-COL-09
test("C-J8-02: wiki edits converge across members and survive offline reload", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J8.2, §6.11 Pages and editing; lands with T-COL-09")
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  const alice = await page.context().browser()!.newContext()
  const other = await alice.newPage()
  try {
    await owner(other)
    await other.route('**/api/user', route => route.fulfill({ json: { id: 2, username: 'alice', is_admin: false } }))
    await other.goto('/smithers-mvp-canary/node')
    await say(page, '/wiki.page decisions/retries')
    await say(other, '/wiki.page decisions/retries')
    const benDoc = page.getByRole('textbox', { name: /Retries/ }).last()
    const aliceDoc = other.getByRole('textbox', { name: /Retries/ }).last()
    const benText = 'B'.repeat(200), aliceText = 'A'.repeat(200)
    await benDoc.focus()
    await page.keyboard.press('Control+Home')
    await aliceDoc.focus()
    await other.keyboard.press('Control+End')
    await Promise.all([page.keyboard.type(benText, { delay: 125 }), other.keyboard.type(aliceText, { delay: 125 })])
    await expect(benDoc).toHaveValue(new RegExp(aliceText))
    await expect(aliceDoc).toHaveValue(new RegExp(benText))
    await Promise.all([benDoc.press('Control+Home'), aliceDoc.press('Control+Home')])
    await Promise.all([page.keyboard.type('x'.repeat(30)), other.keyboard.type('y'.repeat(30))])
    await alice.setOffline(true)
    await aliceDoc.press('Control+End')
    await other.keyboard.type('z'.repeat(50))
    await other.reload()
    await alice.setOffline(false)
    await other.reload()
    await say(other, '/wiki.page decisions/retries')
    await expect(aliceDoc).toHaveValue(new RegExp('z'.repeat(50)))
    await expect(benDoc).toHaveValue(await aliceDoc.inputValue())
    const body = await benDoc.inputValue()
    for (const [letter, count] of [['B', 200], ['A', 200], ['x', 30], ['y', 30], ['z', 50]] as const) {
      expect(body.split(letter).length - 1).toBe(count)
    }
    await page.getByRole('button', { name: /History/ }).last().press('Enter')
    for (const revision of ['r1', 'r2', 'r3']) await expect(page.getByText(revision, { exact: true }).last()).toBeVisible()
    await page.getByText('r2', { exact: true }).last().click()
    await expect(page.getByText(/Retries/).last()).toBeVisible()
  } finally {
    await alice.close()
  }
})
