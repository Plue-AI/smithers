import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"
import { fixtures } from "../../../../../packages/rpc/test/fixtures/Todo"

for (const state of ["failed", "retrying"] as const) {
 test(`C-UI-12: ${state} TODO shows its actionable reason from the install provider`, async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  const model = {
   ...fixtures.failed.model, n: 24, title: "Visible reason", state,
   failure: state === "failed" ? { step: "coding/check-command", label: "Ran checks", class: "user", message: "No checks found", retryable: true, check_configuration: true } : undefined,
   retry: state === "retrying" ? { reason: "The previous machine could not be retired", at: "2026-10-10T12:00:00Z" } : undefined,
   run: { id: "attempt-24", attempt: 1, executing: false, indicators: [] }
  }
  await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
  await page.route("**/api/todos/24", route => route.fulfill({ json: model }))
  await page.goto("/")
  await say(page, "/todo T24")
  const card = page.getByRole("article", { name: "TODO T24", exact: true })
  if (state === "failed") {
   await expect(card).toContainText("Ran checks failed")
   await expect(card.getByText("No checks found", { exact: true })).toBeVisible()
   await expect(card).not.toContainText("factory/stamp-route")
   await expect(card.getByRole("button", { name: "Configure checks", exact: true })).toBeVisible()
  } else {
   await expect(card.locator("header .state")).toHaveText("Retrying")
   await expect(card).toContainText(model.retry!.reason)
   await expect(card.locator("time")).toHaveAttribute("datetime", model.retry!.at)
   await expect(card.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
   await expect(card).not.toContainText("Working")
   await say(page, "/stack")
   const row = page.locator('.stack-row[data-state="retrying"]').filter({ hasText: "Visible reason" })
   await expect(row).toContainText("Retrying")
   await expect(row).toContainText(model.retry!.reason)
   await expect(row.locator("time")).toHaveAttribute("datetime", model.retry!.at)
  }
  await expect(page.getByTestId("composer-input")).toBeEditable()
 })
}

test("C-UI-12: a failed action remains visible while setup cannot load shared preferences", async ({ page }) => {
 await installCloudFixture(page, { capabilities: ["identity", "install"] })
 await page.route("**/api/conversations/main/view-state", async () => { await new Promise(() => {}) })
 const model = { ...fixtures.working.model, n: 24, run: { id: "run-24", attempt: 1, executing: true, indicators: [] } }
 await page.route("**/api/todos", route => route.fulfill({ json: [model] }))
 await page.route("**/api/todos/24", route => route.request().method() === "POST"
  ? route.fulfill({ status: 503, json: { class: "infra", code: "unavailable", message: "Machine unavailable" } })
  : route.fulfill({ json: model }))
 await page.goto("/")
 await say(page, "/todo T24")
 const card = page.getByRole("article", { name: "TODO T24", exact: true })
 await card.getByRole("button", { name: "Stop", exact: true }).press("Enter")
 await expect(page.locator('.notice[data-tone="failed"]')).toBeVisible()
 await expect(page.getByTestId("composer-input")).toBeEditable()
})
