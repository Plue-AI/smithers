import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Requires production TODO projections and a seeded T9 question; issue #7 includes retry discussion.
// Written before implementation: mvp.md Appendix A, J1, J2, §4.2; lands with T-STK-01
test("A-TODO-NEW: writes and places a TODO", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J1, J2, §4.2; lands with T-STK-01")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).last().fill("Log each retry")
  await page.getByLabel("Prompt", { exact: true }).last().fill("Log each webhook retry attempt.")
  await expect(page.getByRole("combobox", { name: "Place", exact: true }).last()).toHaveValue('{"mode":"append"}')
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect(page.locator(".smithers-card").last()).toContainText("Committed as")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Mounted private draft projection; production commit remains pending above.
test("A-TODO-NEW: opens and discards a private draft", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.new")
  await expect(page.getByLabel("Title", { exact: true }).last()).toBeEditable()
  await expect(page.getByLabel("Prompt", { exact: true }).last()).toBeEditable()
  await expect(page.getByText("Only you", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Place", exact: true }).last()).toHaveValue('{"mode":"append"}')
  await page.getByRole("button", { name: "Discard", exact: true }).last().press("Enter")
  await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0)
})

// Written before implementation: mvp.md Appendix A, §4.2 draft persistence; lands with T-APP-02
test("A-TODO-NEW: draft edits survive reload", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, §4.2 draft persistence; lands with T-APP-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).last().fill("Log each retry")
  await page.keyboard.press("Tab")
  await page.getByLabel("Prompt", { exact: true }).last().fill("Log every webhook retry attempt.")
  await page.keyboard.press("Tab")
  await page.reload()
  await expect(page.getByLabel("Title", { exact: true }).last()).toHaveValue("Log each retry")
  await expect(page.getByLabel("Prompt", { exact: true }).last()).toHaveValue("Log every webhook retry attempt.")
})
