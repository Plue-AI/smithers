import { expect, test } from "../browserTest"
import { mergeOwner, say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "../../../../../packages/rpc/src/TodoCard"

// Person-facing confirmation over the real seam. The folded backend race check is separate.
test("C-STK-07: confirmation follows readiness and sends the displayed PR head", async ({ page }) => {
  await mergeOwner(page)
  let model: TodoCard = { ...fixtures.in_review.model, n: 2, title: "Reviewed TODO", place: 1,
    pr: { ...fixtures.in_review.model.pr!, head: "a".repeat(40) },
    merge: { state: "waiting", reason: "checks", detail: "required-ci", on_github: true } }
  const sent: unknown[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/2", route => route.fulfill({ json: model }))
  await page.route("**/api/todos/2/merge", async route => {
    sent.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { state: "accepted" } })
  })
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/settings")
  await say(page, "/todo T2")
  const todo = () => page.locator(".todo-view").last()
  await expect(todo()).toContainText("required-ci")
  await expect(todo().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  expect(sent).toEqual([])
  await say(page, "/merge T2")
  const confirm = () => page.locator(".confirm-view").last()
  await expect(confirm()).toContainText("required-ci")
  await expect(confirm().getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  model = { ...model, pr: { ...model.pr!, head: "b".repeat(40) }, merge: { state: "ready", on_github: true } }
  await expect(todo().getByRole("button", { name: "Merge", exact: true })).toBeVisible()
  await expect(confirm().getByRole("button", { name: "Merge", exact: true })).toBeVisible()
  await expect(confirm()).toContainText("b".repeat(40))
  await confirm().getByRole("button", { name: "Merge", exact: true }).click()
  await expect.poll(() => sent).toEqual([{ reviewed_head_sha: "b".repeat(40) }])
  await expect(todo()).not.toContainText("Merged")
  model = { ...model, state: "merged", merge: { state: "done", on_github: true } }
  await expect(todo()).toContainText("Merged")
  await expect(confirm()).toContainText("Merged T2")
  expect(sent).toHaveLength(1)
})
