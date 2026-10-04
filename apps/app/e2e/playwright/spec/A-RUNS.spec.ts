import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live setup: C-J4-01 shared run projection, with one held Needs you TODO.
// Written before implementation: mvp.md J4, Appendix A, §6.14; lands with T-FLW-07, T-COL-02
test("A-RUNS: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J4, Appendix A, §6.14; lands with T-FLW-07, T-COL-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/runs")
  await expect(page.getByText("Needs you", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/runs")
  await page.getByPlaceholder("Answer the coding agent").last().fill("Use the existing retry helper")
  await page.getByRole("button", { name: "Answer", exact: true }).last().press("Enter")
  await expect(page.getByText("Working", { exact: true }).last()).toBeVisible()
  await expect(page.getByPlaceholder("Answer the coding agent")).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; live provider qualification remains above.
test("A-RUNS: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/runs")
  const run = page.getByRole("region", { name: "Run Retry failed webhooks with backoff", exact: true })
  await expect(run).toBeVisible()
  await expect(run.getByRole("button", { name: "Inspect", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Run Fix the flaky checkout test", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Run Log every webhook retry attempt", exact: true })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
