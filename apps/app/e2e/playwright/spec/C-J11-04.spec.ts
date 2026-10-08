import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-J11-04.md.
// Written before implementation: mvp.md §6.14 Monitor, Thrashing; lands with T-FLW-07, T-REL-02
test("C-J11-04: thrashing marks only three unchanged failures in one attempt", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.14 Monitor, Thrashing; lands with T-FLW-07, T-REL-02")
  await owner(page)
  await page.goto("/smithers-mvp-canary/node")
  // Seed the check's three journals: T4 unchanged failures, T5 an edit
  // between failures, T6 failures split across attempts. T4 later passes.
  // Authenticated ingest, determinism and zero model calls need integration receipts.
  await say(page, '/todo T4')
  await expect(page.getByText('Thrashing: TestRetryBackoff failed 3×', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Inspect', exact: true }).last().press('Enter')
  await expect(page.getByText('TestRetryBackoff', { exact: true }).last()).toBeVisible()
  await expect(page.getByText(/Ran checks.*1 failed ×3/).last()).toBeVisible()
  for (const todo of ['T5', 'T6']) {
    await say(page, `/todo ${todo}`)
    await expect(page.getByRole('region', { name: new RegExp(todo) }).last()).not.toContainText('Thrashing')
  }
  await say(page, '/todo T4')
  await page.getByRole('button', { name: 'Retry', exact: true }).last().press('Enter')
  await expect(page.getByRole('region', { name: /T4/ }).last()).toContainText('In review')
  await expect(page.getByRole('region', { name: /T4/ }).last()).not.toContainText('Thrashing')
})


test("native Retry launches another pinned attempt and retains the failed journal", async ({ page, context }) => {
  test.setTimeout(180_000)
  const origin = process.env.SMITHERS_J11_ORIGIN
  const n = process.env.SMITHERS_J11_RETRY_N
  const id = process.env.SMITHERS_J11_RETRY_RUN
  test.skip(!origin || !n || !id, "Run TestJ11NativeRetryBrowser with SMITHERS_J11_RETRY_BROWSER=1")
  const cookies: Array<{ Name: string; Value: string }> = JSON.parse(process.env.SMITHERS_J11_COOKIES!)
  await context.addCookies(cookies.map(c => ({ name: c.Name, value: c.Value, url: origin! })))
  const before = await (await page.request.get(`${origin}/api/todos/${n}`)).json()
  expect(before.run.attempt).toBe(1)
  await page.goto(origin!)
  await say(page, `/run.inspect ${id}`)
  const run = page.locator('.mvp-run[data-maximized]')
  await expect(run).toBeVisible()
  await run.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(async () => (await (await page.request.get(`${origin}/api/todos/${n}`)).json()).run?.attempt, { timeout: 120_000 }).toBe(2)
  await expect.poll(async () => (await (await page.request.get(`${origin}/api/todos/${n}`)).json()).state, { timeout: 120_000 }).toBe("failed")
  const after = await (await page.request.get(`${origin}/api/todos/${n}`)).json()
  expect(after.run.id).not.toBe(before.run.id)
  expect(after.flow_version).toEqual(before.flow_version)
  const previous = await page.request.get(`${origin}/api/runs/${encodeURIComponent(id!)}/trace`)
  expect(previous.status()).toBe(200)
  expect((await previous.json()).state).toBe("failed")
  const currentID = `${after.branch.id}:${after.run.id}`
  const current = await page.request.get(`${origin}/api/runs/${encodeURIComponent(currentID)}/trace`)
  expect(current.status()).toBe(200)
  const monitor = await current.json()
  expect(monitor.state).toBe("failed")
  expect(monitor.version).toEqual(before.flow_version.digest)
  expect(monitor.attempts.map((attempt: { n: number }) => attempt.n)).toEqual([1, 2])
  await page.getByRole("button", { name: "Restore", exact: true }).press("Enter")
  await say(page, `/run.inspect ${currentID}`)
  const retried = page.locator('.mvp-run[data-maximized]')
  await expect(retried.getByRole("list", { name: "Attempt 1", exact: true })).toBeVisible()
  await expect(retried.getByRole("list", { name: "Attempt 2", exact: true })).toBeVisible()
  const earlier = retried.getByRole("list", { name: "Attempt 1", exact: true }).getByRole("button").first()
  await earlier.focus()
  await earlier.press("Enter")
  await expect(retried.locator(".mvp-run-detail")).toBeVisible()
  await expect(earlier).toHaveAttribute("data-selected", "true")
})
