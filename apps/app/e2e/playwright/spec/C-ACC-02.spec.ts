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
