import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { issueTodoInstall } from "./issue-todo-fixture"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

// Real card, typed flow and install seam against a test-only HTTP contract.
// Machine checkpoint ancestry and GitHub publication require separate receipts.
test("C-J10-03: a newer outside push refuses the stale Discard and binds the next press", async ({ page }) => {
  await issueTodoInstall(page)
  const model = structuredClone(fixtures.foreign_push.model)
  model.n = 4
  model.title = "Retry webhooks"
  model.branch!.name = "smithers/retry-webhooks"
  const foreign = model.waits[0]!
  foreign.sha = "a".repeat(40)
  foreign.prompt = "Alice pushed to smithers/retry-webhooks on GitHub"
  foreign.actions = [{ tag: "branch.discard-foreign", label: "Discard" }]
  model.waits.push(structuredClone(fixtures.needs_you.model.waits[0]!))
  const evidence = structuredClone(model.evidence)
  const writes: { body: unknown; key: string }[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/4", route => route.fulfill({ json: model }))
  let finish!: () => void
  const completion = new Promise<void>(resolve => { finish = resolve })
  await page.route(url => url.pathname.startsWith("/api/branches/"), async route => {
    expect(decodeURIComponent(new URL(route.request().url()).pathname)).toBe("/api/branches/smithers/retry-webhooks")
    writes.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"]! })
    if (writes.length === 1) {
      foreign.sha = "b".repeat(40)
      foreign.prompt = "Alice pushed again to smithers/retry-webhooks on GitHub"
      return route.fulfill({ status: 409, json: { code: "conflict", class: "conflict", message: "Outside push changed; refresh the TODO" } })
    }
    await route.fulfill({ status: 202, json: { state: "accepted", n: 4 } })
    await completion
    model.waits = model.waits.filter(wait => wait.id !== foreign.id)
  })
  await page.goto("/")
  await say(page, "/todo T4")
  const card = page.getByRole("article", { name: "TODO T4" }).last()
  await expect(card.getByText(foreign.prompt, { exact: true })).toBeVisible()
  const discard = card.getByRole("button", { name: "Discard", exact: true })
  await discard.press("Enter")
  expect(writes).toEqual([])
  await page.getByRole("button", { name: "Confirm: discard this outside push", exact: true }).last().press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]!.body).toEqual({ op: "discard-foreign", id: foreign.id, revision: "a".repeat(40) })
  await expect(card.getByText("Alice pushed again to smithers/retry-webhooks on GitHub", { exact: true })).toBeVisible()
  await expect(card.locator("header .state")).toContainText("Needs you")
  await discard.press("Enter")
  await page.getByRole("button", { name: "Confirm: discard this outside push", exact: true }).last().press("Enter")
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]!.body).toEqual({ op: "discard-foreign", id: foreign.id, revision: "b".repeat(40) })
  expect(writes.every(write => !!write.key)).toBe(true)
  expect(writes[1]!.key).not.toBe(writes[0]!.key)
  const notice = page.locator('.notice[data-tone="live"]').filter({ hasText: model.title })
  await expect(notice).toBeVisible()
  await say(page, "/todo T4")
  await expect(page.getByTestId("composer-input")).toBeEditable()
  finish()
  await expect(discard).toHaveCount(0)
  await expect(notice).toHaveCount(0)
  await expect(card.getByRole("button", { name: "Answer", exact: true })).toBeVisible()
  expect(model.evidence).toEqual(evidence)
  await page.reload()
  await say(page, "/todo T4")
  const reloaded = page.getByRole("article", { name: "TODO T4" }).last()
  await expect(reloaded.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0)
  await expect(reloaded.getByRole("button", { name: "Answer", exact: true })).toBeVisible()
  expect(writes).toHaveLength(2)
})
