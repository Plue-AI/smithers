import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live setup: repository TODO flow with typed prompt input, held at its first step.
// Written before implementation: mvp.md §6.12, Appendix A, J11.3; lands with T-FLW-01, T-INS-02, T-CAT-01
test("A-FLOW-RUN: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.12, Appendix A, J11.3; lands with T-FLW-01, T-INS-02, T-CAT-01")
  await owner(page)
  await page.goto("/")
  await say(page, '/flow.run todo {"prompt":"Add retry coverage"}')
  await expect(page.getByRole("button", { name: "Inspect", exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/runs")
  await expect(page.getByText("Add retry coverage", { exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; live provider qualification remains above.
test("A-FLOW-RUN: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/flow.run")
  await expect(page.getByLabel("Flow", { exact: true }).last()).toBeEditable()
  await page.getByLabel("Flow", { exact: true }).last().fill("todo")
  await expect(page.getByLabel("Flow", { exact: true }).last()).toHaveValue("todo")
  await expect(page.getByRole("button", { name: "Submit", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
