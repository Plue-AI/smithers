import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J8-06.md.
// Written before implementation: mvp.md §6.11 Generated pages, §6.12, §6.4, M-11; lands with T-FLW-02, T-APP-01, T-REL-02
test("C-J8-06: generated wiki refresh retries and dismissal persist for everyone", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.11 Generated pages, §6.12, §6.4, M-11; lands with T-FLW-02, T-APP-01, T-REL-02")
// Seed T1–T3 with healthCheck, readyCheck and web patches. Test-world T2/T3
// refreshes fail once; Retry succeeds. Both members share the same world.
// GitHub timing, flow pinning and dismissed_by need reference-host receipts.
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  const ben = await page.context().browser()!.newContext()
  const other = await ben.newPage()
  try {
    await owner(other)
    await other.route('**/api/user', route => route.fulfill({ json: { id: 2, username: 'ben', is_admin: false } }))
    await other.goto('/smithers-mvp-canary/node')
    await say(page, '/wiki.page api')
    await expect(page.getByText('r1', { exact: true }).last()).toBeVisible()
    for (const ref of ['T1', 'T2', 'T3']) {
      await say(other, `/todo ${ref}`)
      await other.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
      await other.getByRole('button', { name: 'Merge', exact: true }).last().press('Enter')
      await say(page, '/stack')
      await say(other, '/stack')
      if (ref === 'T1') {
        await expect(page.getByText(/Wiki refresh/).last()).toBeVisible()
        await expect(other.getByText(/Wiki refresh/).last()).toBeVisible()
        await say(page, '/wiki.page api')
        await expect(page.getByText(/healthCheck/).last()).toBeVisible()
        await expect(page.getByText('r2', { exact: true }).last()).toBeVisible()
        await page.getByRole('button', { name: /History/ }).last().press('Enter')
        await expect(page.getByText('Smithers', { exact: true }).last()).toBeVisible()
      } else {
        for (const browserPage of [page, other]) {
          await expect(browserPage.getByRole('button', { name: 'Retry', exact: true }).last()).toBeVisible()
          await expect(browserPage.getByRole('button', { name: 'Dismiss', exact: true }).last()).toBeVisible()
        }
        if (ref === 'T2') {
          await other.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
          await say(page, '/wiki.page api')
          await expect(page.getByText(/readyCheck/).last()).toBeVisible()
          await expect(page.getByText('r3', { exact: true }).last()).toBeVisible()
        } else {
          await page.getByRole('button', { name: 'Dismiss', exact: true }).last().press('Enter')
          for (const browserPage of [page, other]) {
            await browserPage.reload()
            await say(browserPage, '/stack')
            await expect(browserPage.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0)
          }
          await say(page, '/monitor')
          await expect(page.getByText(/Wiki refresh/).last()).toBeVisible()
        }
      }
    }
  } finally { await ben.close() }
})
