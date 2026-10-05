import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J5-02.md.
// CI receipt: real failed-load transaction, admission pins, imported helpers,
// lockfile reload, scheduler coalescing and corrected M4 activation.
// Reference-host receipt: immutable closure restoration after restart/retry.
// The design hides Previous versions; do not require a Previous chip.
test("C-J5-02: a broken merged flow shows its error while the previous version stays Active", async ({ page }) => {
  await owner(page)
  await page.goto('/acme/api')
  await say(page, '/flow todo')
  const flow = page.getByRole('region', { name: 'TODO flow', exact: true }).last()
  const active = flow.getByRole('button', { name: 'Active', exact: true })
  await expect(active).toHaveAttribute('aria-pressed', 'true')
  await flow.getByRole('button', { name: 'Merged · not active', exact: true }).press('Enter')
  await expect(flow).toContainText('Load failed')
  await expect(flow).toContainText('flows/todo/flow.ts:12')
  await expect(active).toBeVisible()
  await active.press('Enter')
  await expect(active).toHaveAttribute('aria-pressed', 'true')
  await expect(flow).toContainText('Run typecheck and the tests the change touches.')
  await expect(flow.getByText('Load failed', { exact: true })).toHaveCount(0)
  await say(page, '/todo T9')
  await expect(page.getByText('TODO flow · v1', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('lockfile_changed', { exact: true })).toHaveCount(0)
})
