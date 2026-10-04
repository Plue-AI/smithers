import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live setup: activated TODO, learning and repository flows; C-J5-01 activation receipts.
// Written before implementation: mvp.md J5, §6.12; lands with T-FLW-03, T-APP-05
test("A-FLOWS: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J5, §6.12; lands with T-FLW-03, T-APP-05")
  await owner(page)
  await page.goto("/")
  await say(page, "/flows")
  await expect(page.getByRole("region", { name: "learning flow", exact: true }).last()).toContainText("Active")
  await page.reload()
  await say(page, "/flows")
  await expect(page.getByRole("region", { name: "learning flow", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; live provider qualification remains above.
test("A-FLOWS: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/flows")
  await expect(page.getByRole("region", { name: "TODO flow", exact: true }).last()).toContainText("Active")
  await expect(page.getByRole("region", { name: "merge flow", exact: true }).last()).toContainText("Built-in")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
