import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-10.md; not a qualification receipt.
// Written before implementation: mvp.md §6.8, J6.1; lands with T-MCH-11
test("C-MCH-10: Fixture tool logins stay local across reload and logout", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8, J6.1; lands with T-MCH-11")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const input = page.getByRole("textbox", { name: "Terminal input", exact: true }).last()
  await input.fill("mkdir -p ~/.config/gh; printf fixture-A > ~/.config/gh/cycle19-login")
  await input.press("Enter")
  await say(page, "/branch upgrade-stripe")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  await input.fill("test ! -e ~/.config/gh/cycle19-login && mkdir -p ~/.config/gh && printf fixture-B > ~/.config/gh/cycle19-login")
  await input.press("Enter")
  await page.reload()
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  await input.fill("cat ~/.config/gh/cycle19-login; rm ~/.config/gh/cycle19-login")
  await input.press("Enter")
  await expect(page.getByRole("region", { name: "Terminal output", exact: true }).last()).toContainText("fixture-A")
  await say(page, "/branch upgrade-stripe")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  await input.fill("cat ~/.config/gh/cycle19-login")
  await input.press("Enter")
  await expect(page.getByRole("region", { name: "Terminal output", exact: true }).last()).toContainText("fixture-B")
})
