import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-07.md; not a qualification receipt.
// Written before implementation: mvp.md §6.15, M-25; lands with T-MCH-12
test("C-MCH-07: New sessions receive all-branches secrets while cards keep values private", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.15, M-25; lands with T-MCH-12")
  await owner(page)
  await page.goto("/")
  // Seed old terminal before this write; new sessions get the updated env.
  // API credential matrix, SSH and coding-host redaction require integration evidence.
  await say(page, "/secrets")
  await page.getByRole("textbox", { name: "Name", exact: true }).last().fill("CANARY_TOKEN")
  await page.getByLabel("Value", { exact: true }).last().fill("cycle18-private-canary")
  await page.getByRole("button", { name: "Add", exact: true }).last().press("Enter")
  await expect(page.getByText("CANARY_TOKEN", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("cycle18-private-canary", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("CANARY_TOKEN", { exact: true }).last()).toBeVisible()
  await expect(page.getByLabel("Value", { exact: true }).last()).toHaveValue("")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const input = page.getByRole("textbox", { name: "Terminal input", exact: true }).last()
  await input.fill("test \"$CANARY_TOKEN\" = cycle18-private-canary && test -z \"$DEPLOY_KEY\" && echo scopes-ok")
  await input.press("Enter")
  await expect(page.getByRole("region", { name: "Terminal output", exact: true }).last()).toContainText("scopes-ok")
})
