import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Written before implementation: mvp.md J1.8, §6.15, Appendix A /secrets; lands with T-ACC-03, T-APP-04
test("A-SECRETS: durable command scenario", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J1.8, §6.15, Appendix A /secrets; lands with T-ACC-03, T-APP-04")
  await owner(page)
  await page.goto("/")
  await say(page, "/secrets")
  const secrets = page.getByRole("region", { name: "Secrets", exact: true }).last()
  await secrets.getByLabel("Name", { exact: true }).fill("CANARY_KEY")
  const value = secrets.getByLabel("Value", { exact: true })
  await expect(value).toHaveAttribute("type", "password")
  await value.fill("canary-write-only-value")
  await secrets.getByRole("button", { name: "Add", exact: true }).press("Enter")
  await expect(secrets.getByText("CANARY_KEY", { exact: true })).toBeVisible()
  await expect(secrets).not.toContainText("canary-write-only-value")
  await page.reload()
  await say(page, "/secrets")
  await expect(secrets.getByText("CANARY_KEY", { exact: true })).toBeVisible()
  await expect(secrets).not.toContainText("canary-write-only-value")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
