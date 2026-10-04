import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live setup: create-flow reaches a reviewed PR; a person merges before catalog activation.
// Written before implementation: mvp.md §6.12, Appendix A; lands with T-CAT-01, T-FLW-03
test("A-FLOW-NEW: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.12, Appendix A; lands with T-CAT-01, T-FLW-03")
  await owner(page)
  await page.goto("/")
  await say(page, "/flow.new")
  await page.getByLabel("Description", { exact: true }).last().fill("Write release notes from merged TODOs")
  await page.getByRole("button", { name: "Submit", exact: true }).last().press("Enter")
  await expect(page.getByRole("button", { name: "Inspect", exact: true }).last()).toBeVisible()
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Merge", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Merge", exact: true }).last().press("Enter")
  await page.reload()
  await say(page, "/flows")
  await expect(page.getByText("Write release notes from merged TODOs", { exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
