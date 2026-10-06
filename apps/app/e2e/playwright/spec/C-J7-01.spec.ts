import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// UI projection of .specs/engineering/checks/C-J7-01.md.
// Requires the forthcoming seeded DesignWorld. Seed T1 in review, T2 working with a held implement step, T3 queued and next ref T4. Engine ordering, steer delivery and candidate ancestry require reference-host receipts.
// These UI assertions do not replace backend, timing or reference-host receipts.
// Written before implementation: mvp.md J7.1, §4.2, §6.6, M-07; lands with T-STK-02, T-STK-06, T-REL-02
test("C-J7-01: insert precedes T3 and amend retains T2", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J7.1, §4.2, §6.6, M-07; lands with T-STK-02, T-STK-06, T-REL-02")
  await owner(page)
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "ben", is_admin: false } }))
  await page.goto('/smithers-mvp-canary/node')
  await say(page, '/todo.new')
  await page.getByLabel('Title', { exact: true }).last().fill('Add jitter')
  await page.getByLabel('Prompt', { exact: true }).last().fill('Add a jitter helper')
  await page.getByRole('button', { name: 'Append', exact: true }).last().press('Enter')
  await page.getByRole('option', { name: /Before T3/ }).last().press('Enter')
  await page.getByRole('button', { name: 'Commit', exact: true }).last().press('Enter')
  await say(page, '/stack')
  const stack = page.getByRole('region', { name: /Stack/ }).last()
  await expect(stack).toContainText(/T1[\s\S]*T2[\s\S]*T4[\s\S]*T3/)
  await say(page, '/todo.amend T2')
  await page.getByLabel('Prompt', { exact: true }).last().fill('Also log each retry.')
  await page.getByRole('button', { name: 'Commit', exact: true }).last().press('Enter')
  await say(page, '/todo T2')
  await expect(page.getByText('+1', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('Working', { exact: true }).last()).toBeVisible()
  await say(page, '/stack')
  await expect(stack).toContainText(/T1[\s\S]*T2[\s\S]*T4[\s\S]*T3/)
  await expect(stack.getByText('T5', { exact: true })).toHaveCount(0)
})

// Amend's real seam is independent of the placement and candidate-ancestry
// scenario above, whose remaining reference-host providers are still required.
test("C-J7-01: Amend uses PATCH and adds one revision to the same TODO", async ({ page }) => {
  await owner(page)
  let model = { ...fixtures.working.model, prompt_revisions: fixtures.working.model.prompt_revisions.slice(0, 1) }
  const requests: { method: string; body: unknown }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/12", async route => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON()
      requests.push({ method: "PATCH", body })
      model = { ...model, prompt_revisions: [...model.prompt_revisions, {
        text: body.prompt, acceptance: [], by: model.prompt_revisions[0]!.by, at: "2026-10-06T00:00:00Z"
      }] }
      await route.fulfill({ status: 202, json: { state: "accepted", n: 12, rev: 2, attempt: 1 } })
    } else await route.fulfill({ json: model })
  })
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/todo T12")
  await expect(page.getByText("Attempt 1", { exact: true }).last()).toBeVisible()
  await say(page, "/todo.amend T12 Also log each retry.")
  await expect.poll(() => requests).toEqual([{ method: "PATCH", body: { prompt: "Also log each retry." } }])
  await say(page, "/todo T12")
  await expect(page.getByText("+1", { exact: true }).last()).toBeVisible()
  expect(model.n).toBe(12)
  expect(model.run?.id).toBe("run-41")
  expect(model.branch?.id).toBe("todo-12")
})
