import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J8-05.md.
// Written before implementation: mvp.md J8.2–J8.3, §12 item 1, §6.11; lands with T-FLW-10, T-COL-09
test("C-J8-05: the next webhook plan follows the co-edited decision", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J8.2–J8.3, §12 item 1, §6.11; lands with T-FLW-10, T-COL-09")
// Seed an independent canary for each repeat with both retry helpers and r1.
// Three real-model reference-host runs prove selection/digests, not this UI double.
  await owner(page)
  await page.route('**/api/user', route => route.fulfill({ json: { id: 1, username: 'ben', is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo.new')
  await page.getByLabel('Title', { exact: true }).fill('Retry webhooks')
  await page.getByLabel('Prompt', { exact: true }).fill('Retry failed webhook deliveries in deliver.ts')
  await page.getByRole('button', { name: 'Commit', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await page.getByRole('button', { name: 'Plan', exact: true }).last().press('Enter')
  const plan = page.getByRole('region', { name: /Selected step/ }).last()
  await expect(plan).toContainText('retryExponential')
  await expect(plan).not.toContainText('retryFixed')
  await expect(plan.getByRole('link', { name: /webhook-retries.*r1/ })).toBeVisible()
  await say(page, '/todo.drop T1')
  await page.getByRole('button', { name: 'Drop', exact: true }).last().press('Enter')
  const alice = await page.context().browser()!.newContext()
  const other = await alice.newPage()
  try {
    await owner(other)
    await other.route('**/api/user', route => route.fulfill({ json: { id: 2, username: 'alice', is_admin: false } }))
    await other.goto('/smithers-mvp-canary/node')
    await say(page, '/wiki.page decisions/webhook-retries')
    await say(other, '/wiki.page decisions/webhook-retries')
    const decision = 'Decision: webhook redelivery uses retryFixed(5000). retryExponential() is not used for webhooks. Reason: the provider’s idempotency window.'
    await other.getByRole('textbox', { name: /Webhook retries/i }).last().fill(decision)
    await expect(page.getByRole('textbox', { name: /Webhook retries/i }).last()).toHaveValue(decision)
    await page.getByRole('textbox', { name: /Webhook retries/i }).last().press('Control+End')
    await page.keyboard.type(' Preserve delivery IDs.')
    await expect(other.getByRole('textbox', { name: /Webhook retries/i }).last()).toHaveValue(/Preserve delivery IDs/)
    await expect(page.getByText('r2', { exact: true }).last()).toBeVisible()
    await say(page, '/todo.new')
    await page.getByLabel('Title', { exact: true }).fill('Retry webhooks')
    await page.getByLabel('Prompt', { exact: true }).fill('Retry failed webhook deliveries in deliver.ts')
    await page.getByRole('button', { name: 'Commit', exact: true }).last().press('Enter')
    await expect(page.getByText('In review', { exact: true }).last()).toBeVisible()
    await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
    await page.getByRole('button', { name: 'Plan', exact: true }).last().press('Enter')
    await expect(plan).toContainText('retryFixed')
    await expect(plan).not.toContainText('retryExponential')
    await expect(plan.getByRole('link', { name: /webhook-retries.*r2/ })).toBeVisible()
    await expect(plan.getByRole('link', { name: /webhook-retries.*r1/ })).toHaveCount(0)
    await say(page, '/diff T2')
    const diff = page.getByRole('region', { name: /Diff/ }).last()
    await expect(diff).toContainText('deliver.ts')
    await expect(diff).toContainText('retryFixed(5000)')
    await expect(diff).not.toContainText('retryExponential(')
  } finally { await alice.close() }
})
