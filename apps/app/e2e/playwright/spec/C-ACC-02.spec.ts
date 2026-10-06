import { fixtures as todos } from "../../../../../packages/rpc/test/fixtures/Todo"
import type { MemberConfirmation } from "@smthrs/rpc/ConfirmCard"
import type { TodoCard } from "@smthrs/rpc/TodoCard"
import { expect, test } from "../browserTest"
import { fixtures as confirms } from "../../../../../packages/rpc/test/fixtures/Confirm"
import { fixture, open, privateRow, roster } from "./confirmation-fixtures"

// The composed PostgreSQL/GitHub-fake test proves stale admission refuses.
// Here the real install seam projects expiry and requires a fresh person press.
test("C-ACC-02: a stale delegated merge expires before the member reviews the current revision", async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(true), calls = 0
  row = { ...row, revision: "generation-1:h1", payload: { ...row.payload, card: { ...row.payload.card,
    subject: { kind: "todo", ref: "T12", revision: "h1" }, review: { ...row.payload.card.review!, merge: { state: "ready", on_github: true } } } } }
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("owner") : undefined)
  await page.route("**/api/confirmations/*/approve", async route => {
    calls++
    if (calls === 1) {
      row = { ...row, state: "expired", payload: { ...row.payload, card: { ...row.payload.card, receipt: confirms.expired.model.receipt } } }
      publish("confirmations:1")
      await route.fulfill({ status: 409, json: { class: "conflict", code: "confirmation_resolved", message: "Confirmation changed or was already answered" } })
    } else {
      await route.fulfill({ status: 202, json: { id: row.id, state: "pending" } })
    }
  })
  const card = await open(page)
  await expect(card).toContainText("rev h1")
  await card.getByRole("button", { name: "Review & merge", exact: true }).press("Enter")
  await expect(card).toContainText("Expired")
  await expect(card.getByRole("button")).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  row = { ...privateRow(true), id: "10000000-0000-4000-8000-000000000002", payload: { ...privateRow(true).payload,
    card: { ...privateRow(true).payload.card, subject: { kind: "todo", ref: "T12", revision: "h2" },
      review: { ...privateRow(true).payload.card.review!, merge: { state: "waiting", reason: "checks", detail: "Checks running on h2", on_github: true } } } } }
  publish("confirmations:1")
  const current = page.locator('[data-kind="confirm"]').filter({ hasText: "rev h2" })
  await expect(current).toContainText("Checks running on h2")
  await expect(current.getByRole("button", { name: "Review & merge", exact: true })).toBeDisabled()
  expect(calls).toBe(1)
  row = { ...row, payload: { ...row.payload, card: { ...row.payload.card, review: { ...row.payload.card.review!, merge: { state: "ready", on_github: true } } } } }
  publish("confirmations:1")
  await current.getByRole("button", { name: "Review & merge", exact: true }).press("Enter")
  await expect.poll(() => calls).toBe(2)
  await expect(current).not.toContainText("Merged")
  row = { ...row, state: "approved", payload: { ...row.payload, card: { ...row.payload.card, receipt: { ...confirms.done.model.receipt!, text: "Merged" } } } }
  publish("confirmations:1")
  await expect(page.locator('[data-kind="confirm"]').last()).toContainText("Merged")
  await page.reload()
  await expect(page.locator('[data-kind="confirm"]').last()).toContainText("Merged")
  expect(calls).toBe(2)
})

// Pending merge admission stays durable through reload and settles from the real seam.
test("C-ACC-02: a person reviews the current revision and merge survives reload", async ({ page }) => {
  test.setTimeout(120_000)
  const id = "10000000-0000-4000-8000-000000000002"
  let todo: TodoCard = structuredClone(todos.in_review.model)
  let row: MemberConfirmation = { id, command: "merge", state: "pending", revision: "generation-2:h2", expires_at: "2099-01-01T00:00:00Z",
    payload: { input: { reviewed_head_sha: "h2" }, card: { ...structuredClone(confirms.review_merge.model),
      subject: { kind: "todo", ref: "T12", revision: "generation-2:h2" }, review: {
        ...structuredClone(confirms.review_merge.model.review!), approved_revision: "h1",
        evidence: { attempt: 2, revision: "h2", items: [{ kind: "github_check", name: "required-ci", required: true, state: "pending", url: "https://github.com/acme/api/actions/runs/1" }] },
        merge: { state: "waiting", reason: "rechecking", on_github: true }
      } } } }
  const publish = await fixture(page, topic => topic === "members" ? roster("owner") : topic === "confirmations:1" ? [row] : topic === "todo:12" ? todo : undefined)
  await page.route("**/api/todos", route => route.fulfill({ json: [todo] }))
  await page.route("**/api/todos/12", route => route.fulfill({ json: todo }))
  const presses: unknown[] = []
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    presses.push(route.request().postDataJSON())
    await route.fulfill({ status: 202, json: { id, state: "pending" } })
  })
  const card = await open(page)
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText("Approved h1 · Review generation-2:h2")
  await expect(card.getByText("Checks running", { exact: true })).toBeVisible()
  const approve = () => card.getByRole("button", { name: "Review & merge", exact: true })
  await expect(approve()).toBeDisabled()
  expect(presses).toEqual([])
  row.payload.card.review!.evidence.items[0] = { kind: "github_check", name: "required-ci", required: true, state: "passed", url: "https://github.com/acme/api/actions/runs/1" }
  row.payload.card.review!.merge = { state: "ready", on_github: true }
  publish("confirmations:1")
  await expect(approve()).toBeEnabled()
  await approve().press("Enter")
  await expect.poll(() => presses.length).toBe(1)
  expect(presses[0]).toEqual({ subject: row.payload.card.subject, revision: "generation-2:h2" })
  const toast = page.locator(`[data-notice="toast-todo.request.confirmation:${id}"]`)
  await expect(toast).toHaveAttribute("data-tone", "live")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  row.payload.effect = { todo: 12, request: `confirmation:${id}` }
  row.payload.card.review!.merge = { state: "merging", reason: "merging", on_github: true }
  publish("confirmations:1")
  await expect(approve()).toBeDisabled()
  await page.reload()
  await expect(card).toBeVisible()
  await expect(toast).toHaveAttribute("data-tone", "live")
  expect(presses).toHaveLength(1)
  todo = structuredClone(todos.merged.model)
  publish("todo:12")
  row = { ...row, state: "approved", payload: { ...row.payload, card: { ...row.payload.card,
    receipt: { ...confirms.done.model.receipt!, text: "Merged" } } } }
  publish("confirmations:1")
  await expect(toast).toHaveAttribute("data-tone", "done")
  await expect(card).toContainText("Merged")
  expect(presses).toHaveLength(1)
})
