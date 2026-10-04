import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J11.1, §6.14, Appendix A /monitor; lands with T-FLW-07
test("A-MONITOR: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.1, §6.14, Appendix A /monitor; lands with T-FLW-07")
  await owner(page)
  await page.goto("/")
  // Live seed: merged T8, flow-load and interrupted runs from C-J11-01.
  await say(page, "/monitor")
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Retry", exact: true }).last()).toBeVisible()
  await expect(page.getByText("flow-load", { exact: true }).last()).toBeVisible()
  await say(page, "/run.inspect T8")
  await expect(page.getByRole("navigation", { name: "Run timeline", exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: /Rewind|Edit and rerun/ })).toHaveCount(0)
  await page.reload()
  await say(page, "/monitor")
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
