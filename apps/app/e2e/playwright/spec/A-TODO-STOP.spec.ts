import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Production journey mutation and durable completion projections remain pending.
// Written before implementation: mvp.md Appendix A, J4, §4.1; lands with T-STK-05
test("A-TODO-STOP: pauses a working TODO", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J4, §4.1; lands with T-STK-05")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.stop T10")
  await say(page, "/todo T10")
  const card = page.locator(".smithers-card").filter({ hasText: "T10" }).last()
  await expect(card).toContainText("Paused")
  await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeVisible()
  await expect(card.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(card).toContainText("Paused")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Mounted TODO control projection; production pause receipts remain pending above.
test("A-TODO-STOP: mounted working and waiting controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/todo T10")
  const working = page.locator(".smithers-card").filter({ hasText: "T10" }).last()
  await expect(working.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
  await say(page, "/todo.stop T10")
  await expect(working).toContainText("Paused")
  await expect(working.getByRole("button", { name: "Resume", exact: true })).toBeVisible()
  await say(page, "/todo T9")
  const waiting = page.locator(".smithers-card").filter({ hasText: "T9" }).last()
  await expect(waiting).toContainText("Needs you")
  await expect(waiting.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
})
