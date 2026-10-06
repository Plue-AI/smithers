import { expect, test } from "../browserTest"
import { fixtures as confirms } from "../../../../../packages/rpc/test/fixtures/Confirm"
import { fixture, id, open, privateRow, roster } from "./confirmation-fixtures"

// Actual makeCli login and delegated Merge requests are covered through the
// composed PostgreSQL install tests; this proves the member's browser door.
test("C-J6-02: a laptop agent leaves merge approval to the member", async ({ page }) => {
  test.setTimeout(120_000)
  let row = privateRow(true), calls = 0
  row = { ...row, payload: { ...row.payload, card: { ...row.payload.card, asked_by: confirms.one_click.model.asked_by,
    review: { ...row.payload.card.review!, merge: { state: "ready", on_github: true } } } } }
  const publish = await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("owner") : undefined)
  await page.route(`**/api/confirmations/${id}/approve`, async route => {
    calls++
    expect(route.request().headers()["authorization"]).toBeUndefined()
    expect(route.request().headers()["idempotency-key"]).toContain(id)
    await route.fulfill({ status: 202, json: { id, state: "pending" } })
  })
  const card = await open(page)
  expect(calls).toBe(0)
  await expect(card).not.toContainText("Merged")
  await card.getByRole("button", { name: "Review & merge", exact: true }).press("Enter")
  await expect.poll(() => calls).toBe(1)
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  row = { ...row, payload: { ...row.payload, effect: { todo: 12, request: `confirmation:${id}` }, card: { ...row.payload.card,
    review: { ...row.payload.card.review!, merge: { state: "merging", reason: "merging", on_github: true } } } } }
  publish("confirmations:1")
  await expect(card.locator('[data-flow="approval.approve"]')).toBeDisabled()
  await expect(card).not.toContainText("Merged")
  await page.reload()
  expect(calls).toBe(1)
  row = { ...row, state: "approved", payload: { ...row.payload, card: { ...row.payload.card, receipt: { ...confirms.done.model.receipt!, text: "Merged" } } } }
  publish("confirmations:1")
  await expect(page.locator('[data-kind="confirm"]')).toContainText("Merged")
  expect(calls).toBe(1)
})

test("C-J6-02: the private laptop request retains issuer attribution", async ({ page }) => {
  test.setTimeout(120_000)
  const row = privateRow()
  await fixture(page, topic => topic === "confirmations:1" ? [row] : topic === "members" ? roster("owner") : undefined)
  const card = await open(page)
  await expect(card.getByText("Claude Code for Ben", { exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Commit", exact: true })).toBeEnabled()
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await page.reload()
  await expect(page.locator('[data-kind="confirm"]').getByText("Claude Code for Ben", { exact: true })).toBeVisible()
})
