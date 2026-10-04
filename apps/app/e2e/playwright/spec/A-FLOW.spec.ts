import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live setup: C-J5-02 failed-load state; the previous TODO version remains Active.
// Written before implementation: mvp.md J5.3, §6.12; lands with T-FLW-03, T-FLW-04, T-APP-05
test("A-FLOW: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J5.3, §6.12; lands with T-FLW-03, T-FLW-04, T-APP-05")
  await owner(page)
  await page.goto("/")
  await say(page, "/flow todo")
  const flow = page.getByRole("region", { name: "TODO flow", exact: true }).last()
  await expect(flow).toContainText("Merged · not active")
  await expect(flow).toContainText("Load failed")
  await expect(flow.getByRole("button", { name: "Active", exact: true })).toBeVisible()
  await page.reload()
  await say(page, "/flow todo")
  await expect(flow).toContainText("Merged · not active")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; live provider qualification remains above.
test("A-FLOW: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/flow todo")
  const flow = page.getByRole("region", { name: "TODO flow", exact: true }).last()
  await expect(flow.getByRole("button", { name: "Active", exact: true })).toHaveAttribute("aria-pressed", "true")
  await flow.getByRole("button", { name: "Proposed", exact: true }).press("Enter")
  await expect(flow.getByRole("button", { name: "Proposed", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(flow).toContainText("Wait for merge")
  await flow.getByRole("button", { name: "Active", exact: true }).press("Enter")
  await expect(flow.getByRole("button", { name: "Active", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
