import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live setup: C-J5-01 edit-to-merge journey; activation is held until sync completes.
// Written before implementation: mvp.md J5.1–J5.4, Appendix A; lands with T-FLW-05, T-FLW-03, T-FLW-04
test("A-FLOW-EDIT: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J5.1–J5.4, Appendix A; lands with T-FLW-05, T-FLW-03, T-FLW-04")
  await owner(page)
  await page.goto("/")
  await say(page, "/flow.edit todo Run pnpm test and update the changelog")
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Merge", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Merge", exact: true }).last().press("Enter")
  await say(page, "/flow todo")
  await expect(page.getByRole("region", { name: "TODO flow", exact: true }).last()).toContainText("Merged · active after sync")
  await expect(page.getByRole("region", { name: "TODO flow", exact: true }).last()).toContainText("pnpm test")
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; live provider qualification remains above.
test("A-FLOW-EDIT: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/flow.edit todo Run pnpm test")
  await expect(page.getByLabel("Title", { exact: true }).last()).toHaveValue("Change the TODO flow: Run pnpm test")
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true }).last()).toHaveValue("Change flows/todo/flow.ts: Run pnpm test; start from the built-in composition when no override exists")
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Written before implementation: mvp.md Appendix A, J5.2, Form law; lands with T-FLW-05, T-APP-05
test("A-FLOW-EDIT: Edit prefills the flow name", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J5.2, Form law; lands with T-FLW-05, T-APP-05")
  await owner(page)
  await page.goto("/")
  await say(page, "/flow todo")
  await page.getByRole("region", { name: "TODO flow", exact: true }).last().getByRole("button", { name: "Edit", exact: true }).press("Enter")
  await expect(page.getByLabel("Flow", { exact: true }).last()).toHaveValue("todo")
  await page.getByLabel("Request", { exact: true }).last().fill("Run pnpm test")
  await page.getByRole("button", { name: "Submit", exact: true }).last().press("Enter")
  await expect(page.getByLabel("Title", { exact: true }).last()).toHaveValue("Change the TODO flow: Run pnpm test")
})
