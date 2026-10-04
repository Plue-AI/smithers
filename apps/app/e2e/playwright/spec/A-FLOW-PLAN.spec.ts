import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J11.3, §6.14, Appendix A /flow.plan; lands with T-APP-05, T-FLW-04, T-FLW-05, T-FLW-07
test("A-FLOW-PLAN: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.3, §6.14, Appendix A /flow.plan; lands with T-APP-05, T-FLW-04, T-FLW-05, T-FLW-07")
  await owner(page)
  await page.goto("/")
  // Live seed: edited TODO flow on a scratch branch, with notify after check.
  await say(page, "/flow.plan todo")
  await expect(page.getByText("notify", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("check", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("review", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Working", { exact: true })).toHaveCount(0)
  await say(page, "/flow todo")
  await expect(page.getByRole("button", { name: "Active", exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Proposed", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Missing-input projection; preview of edited machine source remains above.
test("A-FLOW-PLAN: missing flow opens a form", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/flow.plan")
  await expect(page.getByLabel("Flow", { exact: true }).last()).toBeEditable()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
