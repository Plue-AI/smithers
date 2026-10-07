import { expect, test } from "../browserTest"
import { mergeOwner, say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "../../../../../packages/rpc/src/TodoCard"

// UI boundary over the real TODO seam. PostgreSQL/GitHub race receipts are separate.
test("C-STK-13: pre-approval waits for readiness and can be removed", async ({ page }) => {
  const defaultWrites: boolean[] = []
  await mergeOwner(page, defaultWrites)
  let model: TodoCard = { ...fixtures.in_review.model, n: 2, title: "Pre-approved TODO", place: 2,
    pr: { ...fixtures.in_review.model.pr!, head: "a".repeat(40) },
    merge: { state: "waiting", reason: "order", detail: "T1", on_github: true } }
  const writes: string[] = []
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/2", route => route.fulfill({ json: model }))
  await page.route("**/api/todos/2/preapproval", async route => {
    const op = route.request().method() === "DELETE" ? "unapprove" : "preapprove"
    writes.push(op)
    model = { ...model, preapproval: op === "preapprove" ? { by: "ben", at: "2026-10-05T17:00:00Z" } : undefined }
    await route.fulfill({ status: 202, json: { state: "accepted" } })
  })
  await page.goto("/smithers-mvp-canary/node")
  await say(page, "/settings")
  const defaultControl = page.getByRole("checkbox", { name: "New TODOs start pre-approved", exact: true })
  await expect(defaultControl).not.toBeChecked()
  await defaultControl.click()
  await expect(defaultControl).toBeChecked()
  await defaultControl.click()
  await expect(defaultControl).not.toBeChecked()
  expect(defaultWrites).toEqual([true, false])
  await say(page, "/todo T2")
  const card = () => page.locator(".todo-view").last()
  await card().getByRole("button", { name: "Pre-approve", exact: true }).click()
  await expect(card()).toContainText("Merges after T1")
  await expect(card().getByRole("button", { name: "Remove pre-approval", exact: true })).toBeVisible()
  await expect(card()).not.toContainText("Merged")
  await card().getByRole("button", { name: "Remove pre-approval", exact: true }).click()
  await expect(card().getByRole("button", { name: "Pre-approve", exact: true })).toBeVisible()
  await card().getByRole("button", { name: "Pre-approve", exact: true }).click()
  await expect(card().getByRole("button", { name: "Remove pre-approval", exact: true })).toBeVisible()
  await page.reload()
  await say(page, "/settings")
  await say(page, "/todo T2")
  await expect(card().getByRole("button", { name: "Remove pre-approval", exact: true })).toBeVisible()
  model = { ...model, merge: { state: "waiting", reason: "checks", detail: "Checks running", on_github: true } }
  await expect(card()).toContainText("Checks running")
  await expect(card()).not.toContainText("Merged")
  expect(writes).toEqual(["preapprove", "unapprove", "preapprove"])
  model = { ...model, state: "merged", merge: { state: "done", on_github: true } }
  await expect(card()).toContainText("Merged")
  await expect(card()).toContainText("pre-approved by ben")
  await expect(card().getByRole("button", { name: "Remove pre-approval", exact: true })).toHaveCount(0)
})
