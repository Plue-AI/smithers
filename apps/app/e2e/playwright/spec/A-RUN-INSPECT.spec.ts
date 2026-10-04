import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J11.1, §6.14, Appendix A /run.inspect; lands with T-FLW-07
test("A-RUN-INSPECT: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.1, §6.14, Appendix A /run.inspect; lands with T-FLW-07")
  await owner(page)
  await page.goto("/")
  // Live seed: C-J11-01 journal with failed and passed checks and settled wait.
  await say(page, "/run.inspect T8")
  const run = page.getByRole("region", { name: "Run Upgrade the Stripe SDK to v17", exact: true }).last()
  await expect(run.getByRole("navigation", { name: "Run timeline", exact: true })).toBeVisible()
  await expect(run).toContainText("answered by Ben")
  await run.getByRole("tab", { name: "Journal", exact: true }).press("Enter")
  await expect(run.getByLabel("Run position", { exact: true })).toBeVisible()
  await expect(run.getByRole("button", { name: /Fork|Rewind/ })).toHaveCount(0)
  await page.reload()
  await say(page, "/run.inspect T8")
  await expect(run).toContainText("answered by Ben")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded read projection; live provider qualification remains above.
test("A-RUN-INSPECT: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/run.inspect T9")
  const run = page.getByRole("region", { name: "Run Retry failed webhooks with backoff", exact: true }).last()
  await expect(run.getByRole("navigation", { name: "Run timeline", exact: true })).toBeVisible()
  await expect(run.getByRole("region", { name: "Selected cell", exact: true })).toBeVisible()
  await expect(run.getByRole("button", { name: /Rewind|Fork/ })).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
