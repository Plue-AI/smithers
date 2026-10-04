import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J11.4, §6.14, Appendix A /agents; lands with T-FLW-08
test("A-AGENTS: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.4, §6.14, Appendix A /agents; lands with T-FLW-08")
  await owner(page)
  await page.goto("/")
  await say(page, "/agents")
  for (const name of ["Planner agent", "Implementer agent", "Reviewer agent", "App agent"])
    await expect(page.getByText(name, { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Reviewer agent", exact: true }).last().press("Enter")
  await expect(page.getByText("Instructions", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Runs", { exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
