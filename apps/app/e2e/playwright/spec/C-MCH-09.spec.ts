import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MCH-09.md; not a qualification receipt.
// Written before implementation: mvp.md §6.8, M-18; lands with T-MCH-11
test("C-MCH-09: Private homes persist on one machine only", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.8, M-18; lands with T-MCH-11")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const input = page.getByRole("textbox", { name: "Terminal input", exact: true }).last()
  await input.fill("umask 002; printf cycle19 > ~/.marker; stat -c '%U %a' ~ ~/.marker")
  await input.press("Enter")
  await expect(page.getByRole("region", { name: "Terminal output", exact: true }).last()).toContainText("ben 700")
  await expect(page.getByRole("region", { name: "Terminal output", exact: true }).last()).toContainText("ben 664")
  await say(page, "/branch upgrade-stripe")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  await input.fill("test ! -e ~/.marker && echo isolated-home")
  await input.press("Enter")
  await expect(page.getByRole("region", { name: "Terminal output", exact: true }).last()).toContainText("isolated-home")
  await page.reload()
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  await input.fill("cat ~/.marker")
  await input.press("Enter")
  await expect(page.getByRole("region", { name: "Terminal output", exact: true }).last()).toContainText("cycle19")
})
