import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J11.4, §6.5, Appendix A /agent; lands with T-FLW-08
test("A-AGENT: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J11.4, §6.5, Appendix A /agent; lands with T-FLW-08")
  await owner(page)
  await page.goto("/")
  await say(page, "/agent reviewer")
  await page.getByRole("button", { name: "Model: Opus 5.5", exact: true }).last().press("Enter")
  await page.getByRole("option", { name: /Sonnet 5.5/ }).press("Enter")
  await expect(page.getByRole("button", { name: "Model: Sonnet 5.5", exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/agent reviewer")
  await expect(page.getByRole("button", { name: "Model: Sonnet 5.5", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
