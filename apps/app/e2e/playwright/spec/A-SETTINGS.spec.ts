import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J1.2, §6.5, Appendix A /settings; lands with T-APP-15, T-INS-08
test("A-SETTINGS: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.2, §6.5, Appendix A /settings; lands with T-APP-15, T-INS-08")
  await owner(page)
  await page.goto("/")
  await say(page, "/settings")
  const settings = page.getByRole("region", { name: "Settings", exact: true }).last()
  await expect(settings).toContainText("Fast model")
  await expect(settings).toContainText("Coding model")
  await expect(settings).toContainText("AI Gateway")
  await expect(settings).toContainText("Machines")
  await expect(settings).toContainText("App installed")
  await page.reload()
  await say(page, "/settings")
  await expect(settings).toContainText("App installed")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded projection; live qualification remains above.
test("A-SETTINGS: mounted command projection", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/settings")
  const card = page.getByRole("region", { name: "Settings", exact: true }).last()
  await expect(card).toContainText("Machines")
  await expect(card).toContainText("App installed")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
