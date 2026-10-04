import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J11-01.md.
// Written before implementation: mvp.md J11.1, §6.14 Monitor, Appendix A; lands with T-FLW-07, T-APP-07, T-REL-02
test("C-J11-01: Inspect exposes retries, waits and read-only run evidence", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.1, §6.14 Monitor, Appendix A; lands with T-FLW-07, T-APP-07, T-REL-02")
// Seed merged T5: lint fails then passes, Ben answers after two minutes,
// model usage costs $0.12/1200 tokens on implement; flow-load and Interrupted
// runs also exist. Literal oracles are independent of production projections.
// Atomic admission, summarizer outage/timing and usage math need qualification.
  await owner(page)
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo T5')
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  const timeline = page.getByRole('navigation', { name: 'Run timeline', exact: true }).last()
  await expect(timeline).toContainText('Ran checks · 1 failed')
  await expect(timeline).toContainText('Ran checks')
  await expect(timeline).not.toContainText('agent/trace/checkpoint')
  await expect(timeline).not.toContainText('<seal-step>')
  await page.getByRole('button', { name: 'Engine', exact: true }).last().press('Enter')
  await expect(page.getByText('agent/trace/checkpoint', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Implement', exact: true }).last().press('Enter')
  const detail = page.getByRole('region', { name: 'Selected step', exact: true }).last()
  for (const label of ['Input', 'Output', 'Transcript']) await expect(detail.getByRole('heading', { name: label, exact: true })).toBeVisible()
  await expect(detail).toContainText('1200 tokens')
  await expect(detail).toContainText('$0.12')
  await page.getByRole('button', { name: /Waits/ }).last().press('Enter')
  await expect(page.getByText(/answered by Ben/).last()).toBeVisible()
  await expect(page.getByText(/since.*10:00/).last()).toBeVisible()
  await expect(page.getByText(/10:02/).last()).toBeVisible()
  await page.getByRole('button', { name: /Journal/ }).last().press('Enter')
  await expect(page.getByRole('region', { name: /Journal/ }).last()).toContainText(/lint[\s\S]*failed[\s\S]*lint[\s\S]*passed/)
  const writes: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/rpc')) {
      const call = request.postDataJSON() as { procedure?: string }
      if (/^(Projection\.|Run\.Get|Run\.List)/.test(call.procedure ?? '')) return
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url())
  })
  const replay = page.getByRole('slider', { name: /Replay/ }).last()
  await replay.focus()
  await replay.press('Home')
  await replay.press('ArrowRight')
  await expect(timeline).toBeVisible()
  await replay.press('End')
  await expect(page.getByText('Merged', { exact: true }).last()).toBeVisible()
  expect(writes).toEqual([])
  await say(page, '/monitor')
  await expect(page.getByText(/flow-load/).last()).toBeVisible()
  await expect(page.getByText('Interrupted', { exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry', exact: true }).last()).toBeVisible()
  for (const label of [/^forks$/i, /^Fork$/i, /Rewind/i, /edit.and.rerun/i]) {
    await expect(page.getByRole('button', { name: label })).toHaveCount(0)
  }
})
