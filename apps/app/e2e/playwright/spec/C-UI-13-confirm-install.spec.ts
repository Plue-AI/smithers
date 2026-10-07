import { expect, test } from "../browserTest"
import { fixtures as confirms } from "../../../../../packages/rpc/test/fixtures/Confirm"
import { fixtures as todos } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { id, privateRow, fixture, roster, open } from "./confirmation-fixtures"

for (const verb of ["Commit", "Amend", "Bring in", "Discard"] as const) test(`C-UI-13 Confirm: ${verb} keeps progress through the running subject`, async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(), todo: TodoCard = todos.working.model, calls = 0
  if (verb === "Amend") row = { ...row, command: "todo.amend", payload: { ...row.payload, input: { prompt: "Publish card projections" }, card: { ...row.payload.card, action: { tag: "todo.amend", verb: "Amend" }, text: "Publish card projections" } } }
  if (verb === "Discard" || verb === "Bring in") {
    todo = todos.foreign_push.model
    row = { ...row, command: verb === "Bring in" ? "branch.bring-in" : "branch.discard-foreign", payload: { ...row.payload, input: { id: todo.waits[0]!.id, revision: todo.waits[0]!.sha }, card: { ...row.payload.card, action: { tag: verb === "Bring in" ? "branch.bring-in" : "branch.discard-foreign", verb }, subject: { kind: "branch", ref: todo.branch!.name, revision: row.revision } } } }
  }
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("owner") : topic === "todo:12" ? todo : undefined)
  await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
  await page.route("**/api/todos/12", route => route.fulfill({ json: todo }))
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    calls++
    expect(route.request().postDataJSON()).toEqual({ subject: row.payload.card.subject, revision: "generation-2:h2" })
    await route.fulfill({ status: 202, json: { id, state: "pending" } })
  })
  const confirm = await open(page)
  await confirm.getByRole("button", { name: verb, exact: true }).press("Enter")
  const toast = page.locator(`[data-notice="toast-todo.request.confirmation:${id}"]`)
  await expect(toast).toHaveAttribute("data-tone", "live")
  await confirm.getByRole("button", { name: verb, exact: true }).press("Enter")
  expect(calls).toBe(1)
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  row = { ...row, state: "approved", payload: { ...row.payload, effect: { todo: 12, request: `confirmation:${id}`, ...(verb === "Amend" ? { revision: 2 } : {}) }, card: { ...row.payload.card, receipt: { ...confirms.done.model.receipt!, text: "Approved" } } } }
  publish("confirmations:1")
  await expect(confirm).toContainText("Approved")
  await expect(toast).toHaveAttribute("data-tone", "live")
  todo = verb === "Amend" ? { ...todos.in_review.model, prompt_revisions: [...todos.in_review.model.prompt_revisions.slice(0, 1), { ...todos.in_review.model.prompt_revisions[0]!, text: "Publish card projections" }] } : todos.in_review.model
  if (verb === "Discard" || verb === "Bring in") todo = { ...todos.foreign_push.model, waits: [] }
  publish("todo:12")
  await expect(toast).toHaveAttribute("data-tone", "done")
})

test("C-UI-13 Confirm: Review & merge follows role and required checks", async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(true), role: "owner" | "member" = "member", denials = 0
  row = { ...row, payload: { ...row.payload, card: { ...row.payload.card, subject: { ...row.payload.card.subject, revision: "h2" }, review: { ...row.payload.card.review!, approved_revision: "h1", evidence: {
    attempt: 2, revision: "h2", items: [
      { kind: "github_check", name: "required-ci", required: true, state: "pending", url: "https://github.com/acme/api/actions/runs/1" },
      { kind: "github_check", name: "optional-ci", required: false, state: "failed", url: "https://github.com/acme/api/actions/runs/2" }
    ] }, merge: { state: "waiting", reason: "rechecking", on_github: true } } } } }
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster(role) : undefined)
  await page.route(`**/api/confirmations/${id}/deny`, async route => {
    denials++
    row = { ...row, state: "rejected", payload: { ...row.payload, card: { ...row.payload.card, receipt: { ...confirms.cancelled.model.receipt! } } } }
    publish("confirmations:1")
    await route.fulfill({ json: { id, state: "rejected" } })
  })
  const confirm = await open(page)
  await expect(confirm).toContainText("Approved h1 · Review h2")
  await expect(confirm.getByText("Checks running", { exact: true })).toBeVisible()
  const merge = confirm.locator('[data-flow="approval.approve"]')
  await expect(merge).toBeDisabled()
  row.payload.card.review!.merge = { state: "ready", on_github: true }
  row.payload.card.review!.evidence.items[0] = { kind: "github_check", name: "required-ci", required: true, state: "passed", url: "https://github.com/acme/api/actions/runs/1" }
  publish("confirmations:1")
  await expect(merge).toBeDisabled()
  role = "owner"; publish("members")
  await expect(merge).toBeEnabled()
  await expect(confirm.locator(".confirm-check").filter({ hasText: "optional-ci" })).toContainText("failed")
  await confirm.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
  await expect(confirm.getByText("Cancelled", { exact: true })).toBeVisible()
  expect(denials).toBe(1)
})

test("C-UI-13 Confirm: Retry restores progress until the private decision arrives", async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(), calls = 0
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("owner") : undefined)
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    calls++
    await route.fulfill(calls === 1
      ? { status: 503, json: { class: "infra", code: "confirmation_unavailable", message: "Confirmation unavailable" } }
      : { status: 200, json: { id, state: "approved" } })
  })
  const confirm = await open(page)
  await confirm.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  const toast = page.locator(`[data-notice="toast-todo.request.confirmation:${id}"]`)
  await expect(toast).toHaveAttribute("data-tone", "failed")
  await toast.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect(toast).toHaveAttribute("data-tone", "live")
  await confirm.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  expect(calls).toBe(2)
  row = { ...row, state: "expired", payload: { ...row.payload, card: { ...row.payload.card, receipt: confirms.expired.model.receipt } } }
  publish("confirmations:1")
  await expect(toast).toHaveAttribute("data-tone", "failed")
  await expect(toast).toContainText("Expired")
})

test("C-UI-13 Confirm: Review & merge stays pending through admission and settles from confirmed Merge", async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(true), calls = 0
  let todo: TodoCard = todos.in_review.model
  row.payload.card.review!.merge = { state: "ready", on_github: true }
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("owner") : topic === "todo:12" ? todo : undefined)
  await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
  await page.route("**/api/todos/12", route => route.fulfill({ json: todo }))
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    calls++
    await route.fulfill({ status: 202, json: { id, state: "pending" } })
  })
  const confirm = await open(page)
  await confirm.getByRole("button", { name: "Review & merge", exact: true }).press("Enter")
  const toast = page.locator(`[data-notice="toast-todo.request.confirmation:${id}"]`)
  await expect(toast).toHaveAttribute("data-tone", "live")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  row = { ...row, payload: { ...row.payload, input: { reviewed_head_sha: "h2" }, effect: { todo: 12, request: `confirmation:${id}` }, card: { ...row.payload.card, review: { ...row.payload.card.review!, merge: { state: "merging", reason: "merging", on_github: true } } } } }
  publish("confirmations:1")
  await expect(confirm.locator('[data-flow="approval.approve"]')).toBeDisabled()
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled()
  await expect(confirm).not.toContainText("Merged")
  await page.reload()
  await expect(page.locator('[data-kind="confirm"]')).toBeVisible()
  await expect(toast).toHaveAttribute("data-tone", "live")
  expect(calls).toBe(1)
  todo = todos.merged.model
  publish("todo:12")
  row = { ...row, state: "approved", payload: { ...row.payload, card: { ...row.payload.card, receipt: { ...confirms.done.model.receipt!, text: "Merged" } } } }
  publish("confirmations:1")
  await expect(toast).toHaveAttribute("data-tone", "done")
  await expect(page.locator('[data-kind="confirm"]')).toContainText("Merged")
  expect(calls).toBe(1)
})
