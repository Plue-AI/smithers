import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J4, Appendix A /run, §6.14; lands with T-FLW-07, T-COL-02
test("A-RUN: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J4, Appendix A /run, §6.14; lands with T-FLW-07, T-COL-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/run T9")
  const run = page.getByRole("region", { name: "Run Retry failed webhooks with backoff", exact: true }).last()
  await expect(run).toContainText("Needs you")
  await page.reload()
  await say(page, "/run T9")
  await expect(run).toContainText("Needs you")
  await run.getByPlaceholder("Answer the coding agent").fill("Use the existing retry helper")
  await run.getByRole("button", { name: "Answer", exact: true }).press("Enter")
  await expect(run).toContainText("Working")
  await expect(run.getByPlaceholder("Answer the coding agent")).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded read projection; live provider qualification remains above.
test("A-RUN: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/run T9")
  const run = page.getByRole("region", { name: "Run Retry failed webhooks with backoff", exact: true })
  await expect(run).toHaveCount(1)
  await expect(run.getByRole("button", { name: "Inspect", exact: true })).toBeVisible()
  await expect(run.getByRole("navigation", { name: "Run timeline", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(run).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
